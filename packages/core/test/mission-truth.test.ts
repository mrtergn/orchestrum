import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { importMissionNodeInput, loadMissionRun, resumeMissionRun, runMissionDetailed } from "../src/mission/runtime.js";
import { buildAgents, buildDeliveryAgents, createMissionSandbox, mockProviderFetch, singleLineDiff, wrapDiff } from "./missionTestUtils.js";

test("feature-dev mission records explicit patch and validation truth", async () => {
  const sandbox = await createMissionSandbox("mission-truth-validate");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  await fs.writeFile(
    path.join(sandbox.repoPath, "package.json"),
    JSON.stringify({
      name: "mission-truth-validate",
      version: "1.0.0",
      scripts: {
        typecheck: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\""
      }
    }, null, 2),
    "utf8"
  );
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
      goal: "Flip the exported value and validate it.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    assert.equal(result.run.change?.status, "validated");
    assert.equal(result.run.validation?.status, "passed");
    assert.equal(result.run.verdict, "ready_to_merge");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "validate")?.status, "completed");
    assert.ok(fsSync.existsSync(path.join(result.runDir, "nodes", "validate", "validation", "summary.json")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("delivery-sprint pauses for input without emitting a failed node event", async () => {
  const sandbox = await createMissionSandbox("mission-truth-pause");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Sprint brief ready." }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Prepare a delivery handoff and wait for import.",
      agents: buildDeliveryAgents("openai")
    });

    assert.equal(result.run.status, "paused");
    assert.equal(result.run.pauseReason, "awaiting_input");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "handoff_wait")?.status, "waiting_input");

    const events = await fs.readFile(path.join(result.runDir, "events.ndjson"), "utf8");
    assert.match(events, /mission\.node\.paused/);
    assert.doesNotMatch(events, /"t":"mission\.node\.failed".*"nodeId":"handoff_wait"/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("delivery import with invalid external patch becomes explicit apply failure", async () => {
  const sandbox = await createMissionSandbox("mission-truth-apply-fail");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Sprint brief ready." }
  ]);

  try {
    const started = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Wait for an external patch.",
      agents: buildDeliveryAgents("openai")
    });
    assert.equal(started.run.status, "paused");

    const imported = await importMissionNodeInput({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      nodeId: "handoff_wait",
      text: [
        "Status: completed",
        "Summary: attempted to apply the requested change",
        "```diff",
        "--- src/index.ts",
        "+++ src/index.ts",
        "@@ malformed",
        "+broken",
        "```"
      ].join("\n")
    });

    assert.equal(imported.status, "blocked");
    assert.equal(imported.change?.status, "apply_failed");
    assert.equal(imported.graph.nodes.find((node) => node.id === "handoff_wait")?.change?.status, "apply_failed");
    assert.ok(fsSync.existsSync(path.join(started.runDir, "nodes", "handoff_wait", "conflict-summary.md")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("delivery import with external patch resumes to a truthful review-ready verdict", async () => {
  const sandbox = await createMissionSandbox("mission-truth-external-patch");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Sprint brief ready." },
    { text: JSON.stringify({ blocking: false, issues: [] }) }
  ]);

  try {
    const started = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Wait for an external implementation patch.",
      agents: buildDeliveryAgents("openai")
    });
    assert.equal(started.run.status, "paused");

    const imported = await importMissionNodeInput({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      nodeId: "handoff_wait",
      text: [
        "Status: completed",
        "Summary: external tool supplied a patch",
        "```diff",
        singleLineDiff("src/index.ts", "export const ok = true;", "export const ok = false;"),
        "```"
      ].join("\n")
    });

    assert.equal(imported.status, "running");
    assert.equal(imported.change?.status, "applied");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8"), /false/);

    const resumed = await resumeMissionRun({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      agents: buildDeliveryAgents("openai")
    });
    const latest = await loadMissionRun(path.join(sandbox.runsDir, "demo", started.runId));

    assert.equal(resumed.run.status, "completed");
    assert.equal(latest?.status, "completed");
    assert.equal(latest?.change?.status, "applied");
    assert.equal(latest?.validation?.status, "not_requested");
    assert.equal(latest?.verdict, "ready_for_review");
    assert.ok(fsSync.existsSync(path.join(started.runDir, "nodes", "handoff_wait", "external_patch.diff")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});
