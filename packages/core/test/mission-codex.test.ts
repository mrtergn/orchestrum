import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { completeWithProvider } from "../src/mission/providers.js"
import { runMissionDetailed } from "../src/mission/runtime.js";
import {
  buildAgents,
  createMissionSandbox,
  createMockCliSuite,
  mockProviderFetch,
  singleLineDiff,
  wrapDiff
} from "./missionTestUtils.js";

test("codex CLI adapter runs non-interactively", async () => {
  const sandbox = await createMissionSandbox("mission-codex-cli");
  const cli = await createMockCliSuite();
  const artifactDir = path.join(sandbox.rootDir, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  const env = {
    ...process.env,
    ORCHESTRUM_CODEX_BIN: cli.codex,
    MOCK_CODEX_AUTH: "1"
  };

  const result = await completeWithProvider({
    vendor: "codex",
    transport: "cli",
    profileId: "codex-cli-balanced",
    auth: { kind: "cli" }
  }, "Update the repository.", env, {
    repoPath: sandbox.repoPath,
    artifactDir,
    role: "dev",
    executor: "patch"
  });

  assert.equal(result.transport, "cli");
  assert.equal(result.vendor, "codex");
  assert.equal(result.nativeWrite, true);
  assert.match(result.text, /codex execution complete/i);
});

test("feature-dev mission completes with OpenAI-backed agents", async () => {
  const sandbox = await createMissionSandbox("mission-openai");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Implementation plan ready.", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    { text: wrapDiff(singleLineDiff("src/index.ts", "export const ok = true;", "export const ok = false;")), usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } },
    { text: JSON.stringify({ blocking: false, issues: [] }), usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Flip the exported value.",
      agents: buildAgents("openai")
    });

    assert.equal(result.ok, true);
    assert.equal(result.run.status, "finished");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8"), /false/);
    assert.ok((result.run.totalTokens ?? 0) > 0);
    assert.ok(fsSync.existsSync(path.join(result.runDir, "nodes", "implement", "git.diff")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});
