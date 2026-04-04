import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { completeWithProvider } from "../src/mission/providers.js";
import { runMissionDetailed } from "../src/mission/runtime.js";
import { buildCliFeatureAgents, createMissionSandbox, createMockCliSuite, enablePassingValidationScripts } from "./missionTestUtils.js";

test("copilot CLI adapter runs in read-only mode with an explicit profile", async () => {
  const sandbox = await createMissionSandbox("mission-copilot-cli-readonly");
  const cli = await createMockCliSuite();
  const env = {
    ...process.env,
    ORCHESTRUM_COPILOT_BIN: cli.copilot,
    MOCK_COPILOT_AUTH: "1",
    COPILOT_GITHUB_TOKEN: "github_pat_test"
  };

  const before = await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8");
  const result = await completeWithProvider({
    vendor: "copilot",
    transport: "cli",
    profileId: "copilot-cli-gpt54",
    auth: { kind: "cli" }
  }, "Inspect the repository and report back.", env, {
    repoPath: sandbox.repoPath,
    role: "pm",
    executor: "prompt"
  });
  const after = await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8");

  assert.equal(result.vendor, "copilot");
  assert.equal(result.transport, "cli");
  assert.equal(result.nativeWrite, false);
  assert.equal(result.model, "gpt-5.4");
  assert.match(result.text, /copilot execution complete via gpt-5\.4/i);
  assert.equal(after, before);
});

test("copilot CLI adapter can use the CLI default model without env-based discovery auth", async () => {
  const sandbox = await createMissionSandbox("mission-copilot-cli-default-model");
  const cli = await createMockCliSuite();
  const env = {
    ...process.env,
    ORCHESTRUM_COPILOT_BIN: cli.copilot,
    MOCK_COPILOT_AUTH: "1",
    COPILOT_GITHUB_TOKEN: undefined
  };

  const result = await completeWithProvider({
    vendor: "copilot",
    transport: "cli",
    auth: { kind: "cli" }
  }, "Reply without editing files.", env, {
    repoPath: sandbox.repoPath,
    role: "pm",
    executor: "prompt"
  });

  assert.equal(result.vendor, "copilot");
  assert.equal(result.model, "");
  assert.equal(result.nativeWrite, false);
  assert.match(result.text, /copilot execution complete via default/i);
});

test("copilot CLI adapter retries with a supported effort when xhigh is rejected", async () => {
  const sandbox = await createMissionSandbox("mission-copilot-cli-effort-fallback");
  const cli = await createMockCliSuite();
  const env = {
    ...process.env,
    ORCHESTRUM_COPILOT_BIN: cli.copilot,
    MOCK_COPILOT_AUTH: "1",
    COPILOT_GITHUB_TOKEN: "github_pat_test",
    MOCK_COPILOT_REJECT_EFFORT: "xhigh"
  };

  const result = await completeWithProvider({
    vendor: "copilot",
    transport: "cli",
    profileId: "copilot-cli-gpt54",
    effort: "max",
    auth: { kind: "cli" }
  }, "Inspect the repository and report back.", env, {
    repoPath: sandbox.repoPath,
    role: "pm",
    executor: "prompt"
  });

  assert.equal(result.vendor, "copilot");
  assert.equal(result.transport, "cli");
  assert.equal(result.model, "gpt-5.4");
  assert.equal(result.effort, "high");
  assert.match(result.text, /copilot execution complete via gpt-5\.4/i);
});

test("feature-dev mission completes with default Copilot-backed developer agent", async () => {
  const sandbox = await createMissionSandbox("mission-copilot");
  await enablePassingValidationScripts(sandbox.repoPath);
  const cli = await createMockCliSuite();
  const originalEnv = {
    ORCHESTRUM_CLAUDE_BIN: process.env.ORCHESTRUM_CLAUDE_BIN,
    ORCHESTRUM_COPILOT_BIN: process.env.ORCHESTRUM_COPILOT_BIN,
    MOCK_CLAUDE_AUTH: process.env.MOCK_CLAUDE_AUTH,
    MOCK_COPILOT_AUTH: process.env.MOCK_COPILOT_AUTH
  };

  process.env.ORCHESTRUM_CLAUDE_BIN = cli.claude;
  process.env.ORCHESTRUM_COPILOT_BIN = cli.copilot;
  process.env.MOCK_CLAUDE_AUTH = "1";
  process.env.MOCK_COPILOT_AUTH = "1";

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Flip the exported value with Copilot CLI.",
      agents: buildCliFeatureAgents()
    });

    assert.equal(result.ok, true);
    assert.equal(result.run.status, "completed");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8"), /false/);
    assert.equal(result.run.graph.nodes.find((node) => node.id === "spec")?.transport, "cli");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "implement")?.transport, "cli");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "implement")?.provider, "copilot");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "audit")?.transport, "cli");
  } finally {
    process.env.ORCHESTRUM_CLAUDE_BIN = originalEnv.ORCHESTRUM_CLAUDE_BIN;
    process.env.ORCHESTRUM_COPILOT_BIN = originalEnv.ORCHESTRUM_COPILOT_BIN;
    process.env.MOCK_CLAUDE_AUTH = originalEnv.MOCK_CLAUDE_AUTH;
    process.env.MOCK_COPILOT_AUTH = originalEnv.MOCK_COPILOT_AUTH;
  }
});

test("workspace config model defaults apply to mission graph when they are concrete model ids", async () => {
  const sandbox = await createMissionSandbox("mission-config-model-overrides");
  await enablePassingValidationScripts(sandbox.repoPath);
  await fs.mkdir(path.join(sandbox.repoPath, ".orchestrum", "control"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.repoPath, ".orchestrum", "control", "config.json"),
    JSON.stringify({ models: { dev: "gpt-5.3-codex", audit: "gpt-5.4" } }, null, 2),
    "utf8"
  );
  const cli = await createMockCliSuite();
  const originalEnv = {
    ORCHESTRUM_CLAUDE_BIN: process.env.ORCHESTRUM_CLAUDE_BIN,
    ORCHESTRUM_COPILOT_BIN: process.env.ORCHESTRUM_COPILOT_BIN,
    MOCK_CLAUDE_AUTH: process.env.MOCK_CLAUDE_AUTH,
    MOCK_COPILOT_AUTH: process.env.MOCK_COPILOT_AUTH
  };

  process.env.ORCHESTRUM_CLAUDE_BIN = cli.claude;
  process.env.ORCHESTRUM_COPILOT_BIN = cli.copilot;
  process.env.MOCK_CLAUDE_AUTH = "1";
  process.env.MOCK_COPILOT_AUTH = "1";

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Use configured model defaults.",
      agents: buildCliFeatureAgents()
    });

    assert.equal(result.ok, true);
    assert.equal(result.run.graph.nodes.find((node) => node.id === "implement")?.model, "gpt-5.3-codex");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "audit")?.model, "sonnet");
  } finally {
    process.env.ORCHESTRUM_CLAUDE_BIN = originalEnv.ORCHESTRUM_CLAUDE_BIN;
    process.env.ORCHESTRUM_COPILOT_BIN = originalEnv.ORCHESTRUM_COPILOT_BIN;
    process.env.MOCK_CLAUDE_AUTH = originalEnv.MOCK_CLAUDE_AUTH;
    process.env.MOCK_COPILOT_AUTH = originalEnv.MOCK_COPILOT_AUTH;
  }
});

test("workspace config effort defaults apply independently per role", async () => {
  const sandbox = await createMissionSandbox("mission-config-effort-overrides");
  await enablePassingValidationScripts(sandbox.repoPath);
  await fs.mkdir(path.join(sandbox.repoPath, ".orchestrum", "control"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.repoPath, ".orchestrum", "control", "config.json"),
    JSON.stringify({ efforts: { pm: "low", dev: "high", audit: "max" } }, null, 2),
    "utf8"
  );
  const cli = await createMockCliSuite();
  const originalEnv = {
    ORCHESTRUM_CLAUDE_BIN: process.env.ORCHESTRUM_CLAUDE_BIN,
    ORCHESTRUM_COPILOT_BIN: process.env.ORCHESTRUM_COPILOT_BIN,
    MOCK_CLAUDE_AUTH: process.env.MOCK_CLAUDE_AUTH,
    MOCK_COPILOT_AUTH: process.env.MOCK_COPILOT_AUTH
  };

  process.env.ORCHESTRUM_CLAUDE_BIN = cli.claude;
  process.env.ORCHESTRUM_COPILOT_BIN = cli.copilot;
  process.env.MOCK_CLAUDE_AUTH = "1";
  process.env.MOCK_COPILOT_AUTH = "1";

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Use configured effort defaults.",
      agents: buildCliFeatureAgents()
    });

    assert.equal(result.ok, true);
    assert.equal(result.run.graph.nodes.find((node) => node.id === "spec")?.effort, "low");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "implement")?.effort, "high");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "audit")?.effort, "max");
  } finally {
    process.env.ORCHESTRUM_CLAUDE_BIN = originalEnv.ORCHESTRUM_CLAUDE_BIN;
    process.env.ORCHESTRUM_COPILOT_BIN = originalEnv.ORCHESTRUM_COPILOT_BIN;
    process.env.MOCK_CLAUDE_AUTH = originalEnv.MOCK_CLAUDE_AUTH;
    process.env.MOCK_COPILOT_AUTH = originalEnv.MOCK_COPILOT_AUTH;
  }
});
