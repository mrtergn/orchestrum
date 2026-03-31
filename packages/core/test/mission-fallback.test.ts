import { test } from "vitest";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import { importMissionNodeInput, loadMissionRun, resumeMissionRun, runMissionDetailed } from "../src/mission/runtime.js";
import {
  buildCliFeatureAgents,
  buildDeliveryAgents,
  createMissionSandbox,
  createMockCliSuite,
  mockProviderFetch
} from "./missionTestUtils.js";

test("feature-dev mission falls back from Claude CLI to Claude API", async () => {
  const sandbox = await createMissionSandbox("mission-cli-fallback");
  const cli = await createMockCliSuite();
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    ORCHESTRUM_CLAUDE_BIN: process.env.ORCHESTRUM_CLAUDE_BIN,
    ORCHESTRUM_CURSOR_BIN: process.env.ORCHESTRUM_CURSOR_BIN,
    MOCK_CLAUDE_AUTH: process.env.MOCK_CLAUDE_AUTH,
    MOCK_CURSOR_AUTH: process.env.MOCK_CURSOR_AUTH,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
  };
  process.env.ORCHESTRUM_CLAUDE_BIN = cli.claude;
  process.env.ORCHESTRUM_CURSOR_BIN = cli.cursor;
  process.env.MOCK_CLAUDE_AUTH = "0";
  process.env.MOCK_CURSOR_AUTH = "1";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = mockProviderFetch("claude", [
    { text: "Implementation plan ready via Claude API." },
    { text: JSON.stringify({ blocking: false, issues: [] }) }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Use fallback when Claude CLI auth is unavailable.",
      agents: buildCliFeatureAgents()
    });

    assert.equal(result.ok, true);
    assert.equal(result.run.graph.nodes.find((node) => node.id === "spec")?.transport, "api");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "audit")?.transport, "api");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "implement")?.transport, "cli");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ORCHESTRUM_CLAUDE_BIN = originalEnv.ORCHESTRUM_CLAUDE_BIN;
    process.env.ORCHESTRUM_CURSOR_BIN = originalEnv.ORCHESTRUM_CURSOR_BIN;
    process.env.MOCK_CLAUDE_AUTH = originalEnv.MOCK_CLAUDE_AUTH;
    process.env.MOCK_CURSOR_AUTH = originalEnv.MOCK_CURSOR_AUTH;
    process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
  }
});

test("delivery-sprint mission waits for import and resumes after completed handoff", async () => {
  const sandbox = await createMissionSandbox("mission-delivery-complete");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = mockProviderFetch("claude", [
    { text: "Prepare the delivery packet." }
  ]);

  try {
    const firstPass = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Prepare a delivery handoff.",
      agents: buildDeliveryAgents("claude")
    });

    assert.equal(firstPass.ok, false);
    assert.equal(firstPass.paused, true);
    const waitNode = firstPass.run.graph.nodes.find((node) => node.id === "handoff_wait");
    assert.equal(waitNode?.status, "waiting_input");
    assert.ok(fsSync.existsSync(`${firstPass.runDir}/nodes/handoff_export/packet.md`));

    const afterImport = await importMissionNodeInput({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: firstPass.run.runId,
      nodeId: "handoff_wait",
      text: [
        "Status: completed",
        "Summary: Delivery handoff is complete.",
        "- [delivery|medium] Follow-up docs :: Document the rollout checklist."
      ].join("\n"),
      targetTool: "claude"
    });
    assert.equal(afterImport.status, "running");

    globalThis.fetch = mockProviderFetch("claude", [
      { text: JSON.stringify({ blocking: false, issues: [] }) }
    ]);

    const resumed = await resumeMissionRun({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: firstPass.run.runId,
      agents: buildDeliveryAgents("claude")
    });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.run.status, "finished");
    const persisted = await loadMissionRun(firstPass.runDir);
    assert.equal(persisted?.graph.nodes.find((node) => node.id === "handoff_wait")?.findingCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

test("delivery-sprint mission fails when imported handoff is blocked", async () => {
  const sandbox = await createMissionSandbox("mission-delivery-blocked");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Prepare the delivery packet." }
  ]);

  try {
    const firstPass = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Prepare a delivery handoff.",
      agents: buildDeliveryAgents("openai")
    });

    const afterImport = await importMissionNodeInput({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: firstPass.run.runId,
      nodeId: "handoff_wait",
      text: [
        "Status: blocked",
        "Summary: Release blockers remain.",
        "- [delivery_blocker|high] Migration missing :: Rollout path is undefined."
      ].join("\n"),
      targetTool: "claude"
    });

    assert.equal(afterImport.status, "failed");
    const waitNode = afterImport.graph.nodes.find((node) => node.id === "handoff_wait");
    assert.equal(waitNode?.status, "blocked");
    assert.equal(waitNode?.findingCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});
