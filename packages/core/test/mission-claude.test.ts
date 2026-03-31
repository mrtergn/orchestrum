import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resumeMissionRun, runMissionDetailed } from "../src/mission/runtime.js";
import { ClaudeProvider } from "../src/runner/providers/claude.js";
import { buildAgents, createMissionSandbox, enablePassingValidationScripts, mockProviderFetch } from "./missionTestUtils.js";

test("claude provider normalizes usage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: "hello from claude" }],
    usage: { input_tokens: 11, output_tokens: 7 }
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

  try {
    const provider = new ClaudeProvider("test-key");
    const result = await provider.complete({ model: "claude-3-5-sonnet-latest", prompt: "ping" });
    assert.equal(result.text, "hello from claude");
    assert.deepEqual(result.usage, {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("claude provider surfaces auth failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

  try {
    const provider = new ClaudeProvider("bad-key");
    await assert.rejects(
      () => provider.complete({ model: "claude-3-5-sonnet-latest", prompt: "ping" }),
      /Claude error 401/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feature-dev mission pauses for approval and resumes with Claude-backed agents", async () => {
  const sandbox = await createMissionSandbox("mission-claude-approval", {
    relativePath: path.join(".github", "workflows", "ci.yml"),
    initialContent: "name: ci\n"
  });
  await enablePassingValidationScripts(sandbox.repoPath);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = mockProviderFetch("claude", [
    { text: "Protect workflow update." },
    { text: "```diff\n--- .github/workflows/ci.yml\n+++ .github/workflows/ci.yml\n@@ -1 +1 @@\n-name: ci\n+name: ci # OPENAI_API_KEY=test\n```" }
  ]);

  try {
    const firstPass = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Update the CI workflow.",
      agents: buildAgents("claude")
    });

    assert.equal(firstPass.ok, false);
    assert.equal(firstPass.paused, true);
    const implementNode = firstPass.run.graph.nodes.find((node) => node.id === "implement");
    assert.equal(implementNode?.status, "awaiting_approval");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, ".github", "workflows", "ci.yml"), "utf8"), /^name: ci/m);

    await fs.mkdir(path.join(firstPass.runDir, "approvals"), { recursive: true });
    await fs.writeFile(path.join(firstPass.runDir, "approvals", "implement.approved"), new Date().toISOString(), "utf8");

    globalThis.fetch = mockProviderFetch("claude", [
      { text: JSON.stringify({ blocking: false, issues: [] }) }
    ]);

    const resumed = await resumeMissionRun({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: firstPass.run.runId,
      agents: buildAgents("claude")
    });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.run.status, "completed");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, ".github", "workflows", "ci.yml"), "utf8"), /OPENAI_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});
