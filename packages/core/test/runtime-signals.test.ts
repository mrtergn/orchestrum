import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runMissionDetailed } from "../src/mission/runtime.js";
import { installPlugin, setPluginEnabled } from "../src/plugins/registry.js";
import {
  buildAgents,
  createMissionSandbox,
  enablePassingValidationScripts,
  mockProviderFetch,
  singleLineDiff,
  wrapDiff
} from "./missionTestUtils.js";

test("mission runtime emits plugin hooks, telemetry, and workspace learnings", async () => {
  const sandbox = await createMissionSandbox("mission-runtime-signals");
  await enablePassingValidationScripts(sandbox.repoPath);

  const pluginLogPath = path.join(sandbox.rootDir, "plugin-hooks.ndjson");
  const pluginDir = path.join(sandbox.rootDir, "mission-signals-plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(sandbox.repoPath, "orchestrum.config.json"),
    JSON.stringify({
      telemetry: { enabled: true }
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      name: "mission-signals",
      version: "0.0.1",
      entry: "index.js",
      capabilities_required: ["run.start", "step.start", "step.finish", "run.finish"]
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      "const fs = require('node:fs');",
      `const logPath = ${JSON.stringify(pluginLogPath)};`,
      "function append(event) {",
      "  fs.appendFileSync(logPath, `${JSON.stringify(event)}\\n`, { encoding: 'utf8' });",
      "}",
      "module.exports = {",
      "  default: {",
      "    name: 'mission-signals',",
      "    onRunStart: async (run) => append({ hook: 'run.start', runId: run.runId, status: run.status }),",
      "    onStepStart: async (step) => append({ hook: 'step.start', stepId: step.stepId, status: step.status }),",
      "    onStepFinish: async (step) => append({ hook: 'step.finish', stepId: step.stepId, status: step.status }),",
      "    onRunFinish: async (run) => append({ hook: 'run.finish', runId: run.runId, status: run.status })",
      "  }",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );
  await installPlugin(sandbox.repoPath, pluginDir);
  await setPluginEnabled(sandbox.repoPath, "mission-signals", true);

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Implementation plan ready." },
    { text: wrapDiff(singleLineDiff("src/index.ts", "export const ok = true;", "export const ok = false;")) },
    { text: JSON.stringify({ blocking: false, issues: [] }) }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Flip the exported value and record runtime signals.",
      agents: buildAgents("openai"),
      traceContext: {
        workItemId: "work-item-demo",
        cycleId: "cycle-1",
        workstreamId: "implement",
        ownerAgentId: "openai-dev",
        ownerAgentName: "dev openai",
        ownerRole: "dev"
      }
    });

    assert.equal(result.run.status, "completed");

    const hookLines = await waitForJsonLines<{ hook: string; status?: string }>(
      pluginLogPath,
      (entries) => entries.some((entry) => entry.hook === "run.finish" && entry.status === "completed")
    );
    assert.ok(hookLines.some((entry) => entry.hook === "run.start"));
    assert.ok(hookLines.some((entry) => entry.hook === "run.finish" && entry.status === "completed"));
    assert.ok(hookLines.some((entry) => entry.hook === "step.start"));
    assert.ok(hookLines.some((entry) => entry.hook === "step.finish"));

    const signalEntries = await waitForJsonLines<{
        workspaceId?: string;
        source?: string;
        type?: string;
        entityId?: string;
        status?: string;
        payload?: Record<string, unknown>;
      }>(
      path.join(sandbox.repoPath, ".orchestrum", "control", "signals.ndjson"),
      (entries) => entries.some((entry) =>
        entry.workspaceId === "demo"
        && entry.source === "work"
        && entry.type === "prompt.sent"
        && entry.payload?.workItemId === "work-item-demo"
      )
    );
    assert.ok(signalEntries.some((entry) =>
      entry.workspaceId === "demo"
      && entry.source === "mission"
      && entry.type === "mission.run.started"
      && entry.entityId === result.runId
      && entry.status === "running"
    ));
    assert.ok(signalEntries.some((entry) =>
      entry.workspaceId === "demo"
      && entry.source === "mission"
      && entry.type === "mission.run.finished"
      && entry.entityId === result.runId
      && entry.status === "completed"
    ));
    assert.ok(signalEntries.some((entry) =>
      entry.workspaceId === "demo"
      && entry.source === "work"
      && entry.type === "prompt.sent"
      && entry.payload?.workItemId === "work-item-demo"
      && entry.payload?.workstreamId === "implement"
      && typeof entry.payload?.providerModel === "string"
      && typeof entry.payload?.laneLabel === "string"
    ));
    assert.ok(signalEntries.some((entry) =>
      entry.workspaceId === "demo"
      && entry.source === "work"
      && entry.type === "cost.updated"
      && entry.payload?.workItemId === "work-item-demo"
      && typeof entry.payload?.providerModel === "string"
    ));

    const learnings = (await fs.readFile(path.join(sandbox.repoPath, ".orchestrum", "control", "learnings.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sourceRunId?: string });
    assert.ok(learnings.length > 0);
    assert.ok(learnings.some((entry) => entry.sourceRunId === result.runId));

    const traceEntries = (await fs.readFile(
      path.join(sandbox.repoPath, ".orchestrum", "control", "traces", "work-item-demo", "index.ndjson"),
      "utf8"
    ))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { traceType?: string; workstreamId?: string | null; promptRaw?: string | null; responseRaw?: string | null });
    assert.ok(traceEntries.some((entry) => entry.traceType === "provider_prompt" && entry.workstreamId === "implement" && typeof entry.promptRaw === "string"));
    assert.ok(traceEntries.some((entry) => entry.traceType === "provider_response" && entry.workstreamId === "implement" && typeof entry.responseRaw === "string"));
    assert.ok(traceEntries.some((entry) => entry.traceType === "cost_update"));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

async function waitForJsonLines<T>(
  filePath: string,
  predicate: (entries: T[]) => boolean,
  timeoutMs = 2000
): Promise<T[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const entries = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
