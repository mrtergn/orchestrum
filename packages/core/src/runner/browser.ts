import fs from "node:fs/promises";
import path from "node:path";
import { EventWriter } from "./events.js";
import { ensureDir, writeJson, writeText } from "./fs.js";
import { Logger } from "./logger.js";
import { loadWorkspaceProfile } from "../profiles/index.js";
import { createRunId, formatError, nowIso, nowTs } from "./utils.js";
import type { BrowserRunOptions as BrowserLaunchOptions } from "../contracts/service.js";
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
  const profile = await loadWorkspaceProfile(options.repoPath).catch(() => null);
  const resolvedBaseUrl = resolveBaseUrl(options, profile?.browser_base_url);
  if (!resolvedBaseUrl) {
    throw new Error("Browser run requires a base URL or workspace browser_base_url profile setting.");
  }

  const iterations = options.kind === "canary"
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

    for (let cycle = 1; cycle <= iterations; cycle += 1) {
      const stepId = options.kind === "canary" ? `cycle-${cycle}` : options.kind;
      const stepDir = path.join(stepsDir, stepId);
      await ensureDir(stepDir);
      page = await context.newPage();
      const status = {
        stepId,
        start: nowIso(),
        end: null as string | null,
        ok: true,
        error: null as string | null
      };
      events.emit({ t: "step.started", stepId, runId, ts: nowTs() });

      const cycleResult = await runBrowserCycle({
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
      if (page) {
        await page.close().catch(() => undefined);
        page = null;
      }
      if (options.kind === "canary" && cycle < iterations) {
        await wait(options.options?.intervalMs ?? 3000);
      }
    }

    runMeta.status = alerts > 0 || failures > 0 ? "failed" : "finished";
    runMeta.end = nowIso();
    runMeta.readiness = buildBrowserReadiness(options.kind, alerts + failures, runMeta.status);
    await writeJson(runMetaPath, runMeta);
    events.emit({ t: "run.finished", runId, ok: runMeta.status === "finished", ts: nowTs() });
    await logger.info("browser.run.finished", { runId, kind: options.kind, alerts, ok: runMeta.status === "finished" });
    return { ok: runMeta.status === "finished", runId, runDir };
  } catch (err) {
    runMeta.status = "failed";
    runMeta.end = nowIso();
    runMeta.error = formatError(err);
    runMeta.readiness = buildBrowserReadiness(options.kind, alerts + 1, "failed");
    await writeJson(runMetaPath, runMeta);
    events.emit({ t: "run.finished", runId, ok: false, ts: nowTs(), error: runMeta.error });
    await logger.error("browser.run.failed", { runId, kind: options.kind, error: runMeta.error });
    return { ok: false, runId, runDir };
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
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
  if (status !== "finished") {
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
