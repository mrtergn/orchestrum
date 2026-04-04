import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { completeWithProvider } from "../src/mission/providers.js"
import { runMissionDetailed } from "../src/mission/runtime.js";
import { listMissionTemplates } from "../src/mission/templates.js";
import {
  buildAgents,
  createMissionSandbox,
  createMockCliSuite,
  enablePassingValidationScripts,
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

test("codex CLI caches supported reasoning efforts and avoids repeating rejected effort", async () => {
  const sandbox = await createMissionSandbox("mission-codex-cli-effort-cache");
  const cli = await createMockCliSuite();
  const artifactDir = path.join(sandbox.rootDir, "artifacts");
  const argsLog = path.join(sandbox.rootDir, "codex-args.ndjson");
  await fs.mkdir(artifactDir, { recursive: true });
  const env = {
    ...process.env,
    ORCHESTRUM_CODEX_BIN: cli.codex,
    MOCK_CODEX_AUTH: "1",
    MOCK_CODEX_REJECT_EFFORT: "xhigh",
    MOCK_CODEX_INCLUDE_RECEIVED_EFFORT: "1",
    MOCK_CODEX_ARGS_LOG: argsLog
  };

  const first = await completeWithProvider({
    vendor: "codex",
    transport: "cli",
    profileId: "codex-cli-balanced",
    effort: "max",
    auth: { kind: "cli" }
  }, "Update the repository.", env, {
    repoPath: sandbox.repoPath,
    artifactDir,
    role: "dev",
    executor: "patch"
  });

  assert.equal(first.effort, "high");
  const firstArgs = (await fs.readFile(argsLog, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(firstArgs.length, 2);
  assert.ok(firstArgs.some((args) => args.includes('model_reasoning_effort="xhigh"')));
  assert.ok(firstArgs.some((args) => args.includes('reasoning.effort="xhigh"')));
  assert.ok(firstArgs.some((args) => args.includes('model_reasoning_effort="high"')));
  assert.ok(firstArgs.some((args) => args.includes('reasoning.effort="high"')));

  const capabilityCachePath = path.join(sandbox.repoPath, ".orchestrum", "control", "provider-capabilities.json");
  const capabilityCache = JSON.parse(await fs.readFile(capabilityCachePath, "utf8")) as {
    effortSupport?: Array<{ vendor?: string; model?: string; supportedEfforts?: string[] }>;
  };
  const codexEntry = capabilityCache.effortSupport?.find((entry) => entry.vendor === "codex" && entry.model === "gpt-5");
  assert.deepEqual(codexEntry?.supportedEfforts, ["minimal", "low", "medium", "high"]);

  await fs.writeFile(argsLog, "", "utf8");
  const second = await completeWithProvider({
    vendor: "codex",
    transport: "cli",
    profileId: "codex-cli-balanced",
    effort: "max",
    auth: { kind: "cli" }
  }, "Update the repository again.", env, {
    repoPath: sandbox.repoPath,
    artifactDir,
    role: "dev",
    executor: "patch"
  });

  assert.equal(second.effort, "high");
  const secondArgs = (await fs.readFile(argsLog, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(secondArgs.length, 1);
  assert.ok(secondArgs[0]?.includes('model_reasoning_effort="high"'));
  assert.ok(secondArgs[0]?.includes('reasoning.effort="high"'));
  assert.ok(!secondArgs[0]?.includes('reasoning.effort="xhigh"'));
});

test("audit repo context ignores generated cache directories", async () => {
  const sandbox = await createMissionSandbox("mission-audit-context-ignore");
  const cli = await createMockCliSuite();
  await fs.mkdir(path.join(sandbox.repoPath, ".mypy_cache", "3.12"), { recursive: true });
  await fs.mkdir(path.join(sandbox.repoPath, "artifacts"), { recursive: true });
  await fs.writeFile(path.join(sandbox.repoPath, ".mypy_cache", "3.12", "cache.data.json"), "{\"noise\":true}\n", "utf8");
  await fs.writeFile(path.join(sandbox.repoPath, "artifacts", "report.json"), "{\"artifact\":true}\n", "utf8");
  await fs.writeFile(path.join(sandbox.repoPath, "src", "service.ts"), "export const service = true;\n", "utf8");
  const originalEnv = {
    ORCHESTRUM_CLAUDE_BIN: process.env.ORCHESTRUM_CLAUDE_BIN,
    MOCK_CLAUDE_AUTH: process.env.MOCK_CLAUDE_AUTH
  };
  process.env.ORCHESTRUM_CLAUDE_BIN = cli.claude;
  process.env.MOCK_CLAUDE_AUTH = "1";

  try {
    const result = await runMissionDetailed({
      templateId: "audit-only",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Audit the repo context without generated cache noise.",
      agents: [
        {
          id: "audit-claude",
          name: "audit claude",
          role: "audit",
          provider: {
            vendor: "claude",
            transport: "cli",
            profileId: "claude-cli-sonnet",
            auth: { kind: "cli" }
          },
          capabilities: {
            fs: true,
            network: true,
            shell: false
          }
        }
      ]
    });

    assert.equal(result.ok, true);
    const prompt = await fs.readFile(path.join(result.runDir, "nodes", "audit", "prompt.md"), "utf8");
    assert.doesNotMatch(prompt, /\.mypy_cache/);
    assert.doesNotMatch(prompt, /artifacts\/report\.json/);
    assert.match(prompt, /src\/service\.ts/);
  } finally {
    process.env.ORCHESTRUM_CLAUDE_BIN = originalEnv.ORCHESTRUM_CLAUDE_BIN;
    process.env.MOCK_CLAUDE_AUTH = originalEnv.MOCK_CLAUDE_AUTH;
  }
});

test("feature-dev mission completes with OpenAI-backed agents", async () => {
  const sandbox = await createMissionSandbox("mission-openai");
  await enablePassingValidationScripts(sandbox.repoPath);
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
    assert.equal(result.run.status, "completed");
    assert.equal(result.run.graph.category, "implementation");
    assert.equal(result.run.graph.defaultGoalHint, "Describe the feature change, target files, and any constraints.");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "implement")?.phase, "implement");
    assert.ok((result.run.graph.nodes.find((node) => node.id === "implement")?.acceptanceCriteria?.length ?? 0) > 0);
    assert.match(await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8"), /false/);
    assert.ok((result.run.totalTokens ?? 0) > 0);
    assert.ok(fsSync.existsSync(path.join(result.runDir, "nodes", "implement", "git.diff")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("mission template catalog exposes structured metadata", () => {
  const bugfixTemplate = listMissionTemplates().find((template) => template.name === "bugfix-hotpatch");
  const deliveryTemplate = listMissionTemplates().find((template) => template.name === "delivery-sprint");
  const docsTemplate = listMissionTemplates().find((template) => template.name === "docs-sync");
  const remediationTemplate = listMissionTemplates().find((template) => template.name === "delivery-remediation-loop");
  assert.ok(bugfixTemplate);
  assert.ok(deliveryTemplate);
  assert.ok(docsTemplate);
  assert.ok(remediationTemplate);
  assert.equal(bugfixTemplate?.category, "bugfix");
  assert.equal(docsTemplate?.category, "documentation");
  assert.equal(deliveryTemplate?.category, "delivery");
  assert.equal(deliveryTemplate?.nodeCount, 4);
  assert.equal(remediationTemplate?.nodeCount, 4);
  assert.ok((deliveryTemplate?.recommendedRoles?.length ?? 0) >= 2);
  assert.ok((deliveryTemplate?.outcomes?.length ?? 0) >= 1);
});
