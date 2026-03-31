import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { runMissionDetailed } from "../src/mission/runtime.js";
import { buildCursorFeatureAgents, createMissionSandbox, createMockCliSuite } from "./missionTestUtils.js";

test("feature-dev mission completes with CLI-backed agents", async () => {
  const sandbox = await createMissionSandbox("mission-cli");
  const cli = await createMockCliSuite();
  const originalEnv = {
    ORCHESTRUM_CLAUDE_BIN: process.env.ORCHESTRUM_CLAUDE_BIN,
    ORCHESTRUM_CURSOR_BIN: process.env.ORCHESTRUM_CURSOR_BIN,
    MOCK_CLAUDE_AUTH: process.env.MOCK_CLAUDE_AUTH,
    MOCK_CURSOR_AUTH: process.env.MOCK_CURSOR_AUTH
  };

  process.env.ORCHESTRUM_CLAUDE_BIN = cli.claude;
  process.env.ORCHESTRUM_CURSOR_BIN = cli.cursor;
  process.env.MOCK_CLAUDE_AUTH = "1";
  process.env.MOCK_CURSOR_AUTH = "1";

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Flip the exported value with native CLI agents.",
      agents: buildCursorFeatureAgents()
    });

    assert.equal(result.ok, true);
    assert.equal(result.run.status, "finished");
    assert.match(await fs.readFile(`${sandbox.repoPath}/src/index.ts`, "utf8"), /false/);
    assert.equal(result.run.graph.nodes.find((node) => node.id === "spec")?.transport, "cli");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "implement")?.transport, "cli");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "audit")?.transport, "cli");
  } finally {
    process.env.ORCHESTRUM_CLAUDE_BIN = originalEnv.ORCHESTRUM_CLAUDE_BIN;
    process.env.ORCHESTRUM_CURSOR_BIN = originalEnv.ORCHESTRUM_CURSOR_BIN;
    process.env.MOCK_CLAUDE_AUTH = originalEnv.MOCK_CLAUDE_AUTH;
    process.env.MOCK_CURSOR_AUTH = originalEnv.MOCK_CURSOR_AUTH;
  }
});
