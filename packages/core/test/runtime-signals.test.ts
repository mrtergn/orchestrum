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
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");

    const hookLines = (await fs.readFile(pluginLogPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { hook: string; status?: string });
    assert.ok(hookLines.some((entry) => entry.hook === "run.start"));
    assert.ok(hookLines.some((entry) => entry.hook === "run.finish" && entry.status === "completed"));
    assert.ok(hookLines.some((entry) => entry.hook === "step.start"));
    assert.ok(hookLines.some((entry) => entry.hook === "step.finish"));

    const signalEntries = (await fs.readFile(path.join(sandbox.repoPath, ".orchestrum", "control", "signals.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { workspaceId?: string; source?: string; type?: string; entityId?: string; status?: string });
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

    const learnings = (await fs.readFile(path.join(sandbox.repoPath, ".orchestrum", "control", "learnings.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sourceRunId?: string });
    assert.ok(learnings.length > 0);
    assert.ok(learnings.some((entry) => entry.sourceRunId === result.runId));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});
