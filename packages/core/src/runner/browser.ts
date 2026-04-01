import fs from "node:fs/promises";
import path from "node:path";
import { EventWriter } from "./events.js";
import { loadConfig } from "./config.js";
import { ensureDir, writeJson, writeText } from "./fs.js";
import { Logger } from "./logger.js";
import { buildStepState, loadPlugins, runPluginHook } from "./plugins.js";
import { appendWorkspaceSignal } from "./signals.js";
import { loadWorkspaceProfile } from "../profiles/index.js";
import { getLicenseStatus } from "../licensing/index.js";
import { emitTelemetry } from "../telemetry/index.js";
import { createRunId, formatError, nowIso, nowTs } from "./utils.js";
import type { BrowserRunOptions as BrowserLaunchOptions, BrowserScenarioStep } from "../contracts/service.js";
import type { RunKind, RunReadiness, RunState } from "./types.js";

export type BrowserRunKind = RunKind;

export type BrowserRunInput = {
  kind: BrowserRunKind;
  repoPath: string;
  runsDir: string;
  workspaceId: string;
  baseUrl?: string;
  targetPath?: string;
  runId?: string;
  options?: BrowserLaunchOptions;
};

type BrowserModule = {
  chromium: {
    launch: (options: { headless?: boolean }) => Promise<any>;
  };
};

export async function runBrowserRunDetailed(options: BrowserRunInput): Promise<{ ok: boolean; runId: string; runDir: string }> {
  const runId = options.runId ?? createRunId();
  const runDir = path.join(options.runsDir, options.workspaceId, runId);
  const stepsDir = path.join(runDir, "steps");
  await ensureDir(stepsDir);
  const logger = new Logger(path.join(runDir, "logs", "runner.ndjson"), runId);
  const events = new EventWriter(path.join(runDir, "events.ndjson"));
  const config = await loadConfig(options.repoPath).catch(() => null);
  const license = await getLicenseStatus().catch(() => ({ tier: "Free" as const }));
  const plugins = await loadPlugins(options.repoPath, config).catch(() => []);
  const profile = await loadWorkspaceProfile(options.repoPath).catch(() => null);
  const resolvedBaseUrl = resolveBaseUrl(options, profile?.browser_base_url);
  if (!resolvedBaseUrl) {
    throw new Error("Browser run requires a base URL or workspace browser_base_url profile setting.");
  }
  const scenarioSteps = normalizeScenario(options.options?.scenario);
  const usesScenario = options.kind === "qa" && scenarioSteps.length > 0;

  const iterations = usesScenario
    ? scenarioSteps.length
    : options.kind === "canary"
    ? Math.max(1, Math.floor(options.options?.iterations ?? 3))
    : 1;
  const runMeta: RunState = {
    runId,
    kind: options.kind,
    status: "running",
    start: nowIso(),
    end: null,
    goal: options.targetPath ?? resolvedBaseUrl,
    userGoal: options.targetPath ?? resolvedBaseUrl,
    repoPath: options.repoPath,
    workspaceId: options.workspaceId,
    workspacePath: options.repoPath,
    totalSteps: iterations,
    completedSteps: 0,
    pinned: false,
    tags: ["browser", options.kind],
    profile: profile ?? null,
    readiness: null,
    worktreePath: null
  };

  const runMetaPath = path.join(runDir, "run.json");
  await writeJson(runMetaPath, runMeta);
  await runPluginHook(plugins, "onRunStart", runMeta, {
    repoPath: options.repoPath,
    workspaceId: options.workspaceId,
    entityId: runId
  });
  await emitTelemetry({
    t: "browser.run.started",
    ts: nowIso(),
    tier: license.tier,
    run_kind: options.kind,
    run_status: runMeta.status,
    workspace_id: options.workspaceId
  }, config?.telemetry, { workspacePath: options.repoPath });
  await appendWorkspaceSignal(options.repoPath, {
    workspaceId: options.workspaceId,
    source: "browser",
    type: usesScenario ? "browser.scenario.started" : "browser.smoke.started",
    entityId: runId,
    status: runMeta.status,
    summary: usesScenario ? "Browser scenario started" : "Browser smoke started",
    payload: {
      runId,
      kind: options.kind,
      steps: iterations
    }
  }).catch(() => undefined);
  events.emit({ t: "run.started", runId, kind: options.kind, ts: nowTs(), totalSteps: iterations, workspaceId: options.workspaceId });
  await logger.info("browser.run.started", { runId, kind: options.kind, workspaceId: options.workspaceId });

  const playwright = await loadPlaywright();
  let browser: any = null;
  let page: any = null;
  let baselineDuration = 0;
  let alerts = 0;
  let failures = 0;
  let completed = 0;

  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();

    if (usesScenario) {
      page = await context.newPage();
    }

    for (let cycle = 1; cycle <= iterations; cycle += 1) {
      const scenarioStep = usesScenario ? scenarioSteps[cycle - 1]! : null;
      const scenarioAction = scenarioStep?.action ?? options.kind;
      const stepId = usesScenario
        ? `scenario-${String(cycle).padStart(2, "0")}-${scenarioAction}`
        : options.kind === "canary"
          ? `cycle-${cycle}`
          : options.kind;
      const stepDir = path.join(stepsDir, stepId);
      await ensureDir(stepDir);
      if (!usesScenario) {
        page = await context.newPage();
      }
      const status = {
        stepId,
        start: nowIso(),
        end: null as string | null,
        ok: true,
        error: null as string | null
      };
      events.emit({ t: "step.started", stepId, runId, ts: nowTs() });
      await runPluginHook(plugins, "onStepStart", buildStepState({
        stepId,
        status: "running"
      }), {
        repoPath: options.repoPath,
        workspaceId: options.workspaceId,
        entityId: stepId
      });

      const cycleResult = usesScenario && scenarioStep
        ? await runBrowserScenarioStep({
            page,
            stepDir,
            resolvedBaseUrl,
            runId,
            stepId,
            events,
            definition: scenarioStep
          })
        : await runBrowserCycle({
            kind: options.kind,
            page,
            stepDir,
            resolvedBaseUrl,
            targetPath: options.targetPath ?? options.options?.targetPath,
            runId,
            stepId,
            events
          });

      status.ok = cycleResult.ok;
      status.error = cycleResult.ok ? null : cycleResult.summary;
      status.end = nowIso();
      await writeJson(path.join(stepDir, "status.json"), status);
      events.emit({ t: "step.finished", stepId, runId, ok: status.ok, ts: nowTs() });
      const pluginStep = buildStepState({
        stepId,
        status: status.ok ? "completed" : "failed",
        ok: status.ok,
        error: status.error
      });
      pluginStep.start = status.start;
      pluginStep.end = status.end ?? undefined;
      await runPluginHook(plugins, "onStepFinish", pluginStep, {
        repoPath: options.repoPath,
        workspaceId: options.workspaceId,
        entityId: stepId
      });
      if (!cycleResult.ok) {
        failures += 1;
      }

      if (cycle === 1) {
        baselineDuration = cycleResult.durationMs;
      } else if (options.kind === "canary") {
        const threshold = Math.max(2000, Math.round(baselineDuration * 1.3));
        if (!cycleResult.ok || cycleResult.durationMs > threshold) {
          alerts += 1;
          events.emit({
            t: "canary.alert",
            runId,
            stepId,
            durationMs: cycleResult.durationMs,
            baselineMs: baselineDuration,
            ts: nowTs()
          });
        }
      }

      completed += 1;
      runMeta.completedSteps = completed;
      await writeJson(runMetaPath, runMeta);
      if (!usesScenario && page) {
        await page.close().catch(() => undefined);
        page = null;
      }
      if (options.kind === "canary" && cycle < iterations) {
        await wait(options.options?.intervalMs ?? 3000);
      }
    }

    runMeta.status = alerts > 0 || failures > 0 ? "failed" : "completed";
    runMeta.end = nowIso();
    runMeta.readiness = buildBrowserReadiness(options.kind, alerts + failures, runMeta.status);
    await writeJson(runMetaPath, runMeta);
    events.emit({ t: "run.finished", runId, ok: runMeta.status === "completed", ts: nowTs() });
    await logger.info("browser.run.finished", { runId, kind: options.kind, alerts, ok: runMeta.status === "completed" });
    await runPluginHook(plugins, "onRunFinish", runMeta, {
      repoPath: options.repoPath,
      workspaceId: options.workspaceId,
      entityId: runId
    });
    await emitTelemetry({
      t: "browser.run.finished",
      ts: nowIso(),
      tier: license.tier,
      run_kind: options.kind,
      run_status: runMeta.status,
      workspace_id: options.workspaceId,
      duration_ms: durationBetween(runMeta.start, runMeta.end)
    }, config?.telemetry, { workspacePath: options.repoPath });
    await appendWorkspaceSignal(options.repoPath, {
      workspaceId: options.workspaceId,
      source: "browser",
      type: usesScenario ? "browser.scenario.finished" : "browser.smoke.finished",
      entityId: runId,
      status: runMeta.status,
      summary: usesScenario ? "Browser scenario finished" : "Browser smoke finished",
      payload: {
        runId,
        kind: options.kind,
        alerts,
        failures
      }
    }).catch(() => undefined);
    return { ok: runMeta.status === "completed", runId, runDir };
  } catch (err) {
    runMeta.status = "failed";
    runMeta.end = nowIso();
    runMeta.error = formatError(err);
    runMeta.readiness = buildBrowserReadiness(options.kind, alerts + 1, "failed");
    await writeJson(runMetaPath, runMeta);
    events.emit({ t: "run.finished", runId, ok: false, ts: nowTs(), error: runMeta.error });
    await logger.error("browser.run.failed", { runId, kind: options.kind, error: runMeta.error });
    await runPluginHook(plugins, "onRunFinish", runMeta, {
      repoPath: options.repoPath,
      workspaceId: options.workspaceId,
      entityId: runId
    });
    await emitTelemetry({
      t: "browser.run.finished",
      ts: nowIso(),
      tier: license.tier,
      run_kind: options.kind,
      run_status: runMeta.status,
      workspace_id: options.workspaceId,
      duration_ms: durationBetween(runMeta.start, runMeta.end)
    }, config?.telemetry, { workspacePath: options.repoPath });
    await appendWorkspaceSignal(options.repoPath, {
      workspaceId: options.workspaceId,
      source: "browser",
      type: usesScenario ? "browser.scenario.finished" : "browser.smoke.finished",
      entityId: runId,
      status: runMeta.status,
      summary: usesScenario ? "Browser scenario failed" : "Browser smoke failed",
      payload: {
        runId,
        kind: options.kind,
        error: runMeta.error ?? null
      }
    }).catch(() => undefined);
    return { ok: false, runId, runDir };
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
}

function durationBetween(start?: string | null, end?: string | null) {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

async function runBrowserCycle(options: {
  kind: BrowserRunKind;
  page: any;
  stepDir: string;
  resolvedBaseUrl: string;
  targetPath?: string;
  runId: string;
  stepId: string;
  events: EventWriter;
}): Promise<{ ok: boolean; durationMs: number; summary: string }> {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];
  options.page.on("console", (message: any) => {
    if (message.type?.() === "error") {
      consoleErrors.push(message.text?.() ?? String(message));
    }
  });
  options.page.on("pageerror", (error: Error) => {
    pageErrors.push(error.message);
  });
  options.page.on("requestfailed", (request: any) => {
    failedRequests.push(`${request.method?.() ?? "GET"} ${request.url?.() ?? ""}`);
  });

  const targetUrl = new URL(options.targetPath ?? "/", options.resolvedBaseUrl).toString();
  const startedAt = Date.now();
  await options.page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });
  const durationMs = Date.now() - startedAt;
  const html = await options.page.content();
  const screenshotPath = path.join(options.stepDir, "screenshot.png");
  await options.page.screenshot({ path: screenshotPath, fullPage: true });
  await writeText(path.join(options.stepDir, "dom.html"), html);

  const metrics = await options.page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource");
    return {
      title: document.title,
      navigation: navigation ? {
        domContentLoaded: Math.round(navigation.domContentLoadedEventEnd),
        loadEventEnd: Math.round(navigation.loadEventEnd),
        responseEnd: Math.round(navigation.responseEnd)
      } : null,
      resourceCount: resources.length
    };
  });

  const ok = consoleErrors.length === 0 && failedRequests.length === 0 && pageErrors.length === 0;
  const summary = ok
    ? `${options.kind} completed without console or network failures.`
    : `Console errors: ${consoleErrors.length}, failed requests: ${failedRequests.length}, page errors: ${pageErrors.length}.`;

  await writeJson(path.join(options.stepDir, "summary.json"), {
    url: targetUrl,
    durationMs,
    metrics,
    consoleErrors,
    failedRequests,
    pageErrors,
    ok,
    summary
  });
  await writeText(
    path.join(options.stepDir, "output.md"),
    [
      `# ${options.kind.toUpperCase()} Summary`,
      "",
      `URL: ${targetUrl}`,
      `Duration: ${durationMs}ms`,
      `Status: ${ok ? "ok" : "attention"}`,
      "",
      `Summary: ${summary}`
    ].join("\n")
  );
  options.events.emit({
    t: "browser.metrics",
    runId: options.runId,
    stepId: options.stepId,
    durationMs,
    resourceCount: metrics.resourceCount,
    ok,
    ts: nowTs()
  });
  return { ok, durationMs, summary };
}

async function runBrowserScenarioStep(options: {
  page: any;
  stepDir: string;
  resolvedBaseUrl: string;
  runId: string;
  stepId: string;
  events: EventWriter;
  definition: BrowserScenarioStep;
}): Promise<{ ok: boolean; durationMs: number; summary: string }> {
  const startedAt = Date.now();
  let summary = `${options.definition.action} completed.`;
  try {
    switch (options.definition.action) {
      case "goto": {
        const targetUrl = new URL(options.definition.url ?? options.definition.targetPath ?? "/", options.resolvedBaseUrl).toString();
        await options.page.goto(targetUrl, {
          waitUntil: options.definition.waitUntil ?? "networkidle",
          timeout: 30000
        });
        summary = `Navigated to ${targetUrl}.`;
        break;
      }
      case "click":
        await options.page.locator(options.definition.selector).click();
        summary = `Clicked ${options.definition.selector}.`;
        break;
      case "fill":
        await options.page.locator(options.definition.selector).fill(options.definition.value);
        summary = `Filled ${options.definition.selector}.`;
        break;
      case "waitFor":
        if (options.definition.selector) {
          await options.page.locator(options.definition.selector).waitFor({
            state: "visible",
            timeout: options.definition.timeoutMs ?? 10000
          });
          summary = `Waited for ${options.definition.selector}.`;
        } else if (options.definition.text) {
          await options.page.getByText(options.definition.text, { exact: false }).waitFor({
            state: "visible",
            timeout: options.definition.timeoutMs ?? 10000
          });
          summary = `Waited for text "${options.definition.text}".`;
        } else {
          throw new Error("waitFor requires selector or text.");
        }
        break;
      case "assertText": {
        const text = options.definition.selector
          ? await options.page.locator(options.definition.selector).textContent()
          : await options.page.textContent("body");
        if (!String(text ?? "").includes(options.definition.text)) {
          throw new Error(`Expected text "${options.definition.text}" was not found.`);
        }
        summary = `Verified text "${options.definition.text}".`;
        break;
      }
      case "assertVisible": {
        const visible = await options.page.locator(options.definition.selector).isVisible();
        if (!visible) {
          throw new Error(`Expected ${options.definition.selector} to be visible.`);
        }
        summary = `Verified visibility for ${options.definition.selector}.`;
        break;
      }
      case "screenshot": {
        const name = sanitizeScenarioArtifactName(options.definition.name ?? options.stepId);
        const screenshotPath = path.join(options.stepDir, `${name}.png`);
        await options.page.screenshot({
          path: screenshotPath,
          fullPage: options.definition.fullPage !== false
        });
        summary = `Captured screenshot ${name}.png.`;
        break;
      }
      default:
        throw new Error(`Unsupported scenario action ${(options.definition as { action?: string }).action ?? "unknown"}.`);
    }
    const durationMs = Date.now() - startedAt;
    await writeJson(path.join(options.stepDir, "summary.json"), {
      action: options.definition.action,
      ok: true,
      durationMs,
      summary
    });
    await writeText(path.join(options.stepDir, "output.md"), [
      `# Scenario Step ${options.stepId}`,
      "",
      `Action: ${options.definition.action}`,
      `Duration: ${durationMs}ms`,
      "",
      summary
    ].join("\n"));
    options.events.emit({
      t: "browser.scenario.step",
      runId: options.runId,
      stepId: options.stepId,
      action: options.definition.action,
      durationMs,
      ok: true,
      ts: nowTs()
    });
    return { ok: true, durationMs, summary };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const error = formatError(err);
    await writeJson(path.join(options.stepDir, "summary.json"), {
      action: options.definition.action,
      ok: false,
      durationMs,
      summary: error
    });
    await writeText(path.join(options.stepDir, "output.md"), [
      `# Scenario Step ${options.stepId}`,
      "",
      `Action: ${options.definition.action}`,
      `Duration: ${durationMs}ms`,
      "",
      error
    ].join("\n"));
    options.events.emit({
      t: "browser.scenario.step",
      runId: options.runId,
      stepId: options.stepId,
      action: options.definition.action,
      durationMs,
      ok: false,
      error,
      ts: nowTs()
    });
    return { ok: false, durationMs, summary: error };
  }
}

function normalizeScenario(raw: BrowserLaunchOptions["scenario"]): BrowserScenarioStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((step): step is BrowserScenarioStep => Boolean(step) && typeof step === "object" && typeof step.action === "string");
}

function sanitizeScenarioArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "screenshot";
}

async function loadPlaywright(): Promise<BrowserModule> {
  const mod = await import("playwright");
  const resolved = (mod as any).default ?? mod;
  if (!resolved?.chromium?.launch) {
    throw new Error("Playwright chromium runtime is unavailable.");
  }
  return resolved as BrowserModule;
}

function resolveBaseUrl(options: BrowserRunInput, profileBaseUrl?: string): string | null {
  const baseUrl = options.baseUrl ?? options.options?.baseUrl ?? profileBaseUrl ?? null;
  if (!baseUrl) return null;
  return baseUrl.trim();
}

function buildBrowserReadiness(kind: BrowserRunKind, alerts: number, status: RunState["status"]): RunReadiness {
  const blocking: string[] = [];
  let score = 100;
  if (status !== "completed") {
    score -= 35;
    blocking.push(`${kind} run did not finish cleanly.`);
  }
  if (alerts > 0) {
    score -= Math.min(35, alerts * 15);
    blocking.push(`${alerts} ${kind} alert(s) detected.`);
  }
  return {
    score: Math.max(0, score),
    blocking,
    updatedAt: new Date().toISOString()
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
