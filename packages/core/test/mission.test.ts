import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  completeWithProvider,
  discoverMissionProviders,
  importMissionNodeInput,
  loadMissionRun,
  resumeMissionRun,
  runMissionDetailed,
  type MissionAgent,
  type MissionProviderSpec
} from "../src/index.js";
import { ClaudeProvider } from "../src/runner/providers/claude.js";

const execFileAsync = promisify(execFile);

test("claude provider normalizes usage", { concurrency: false }, async () => {
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

test("claude provider surfaces auth failures", { concurrency: false }, async () => {
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

test("provider discovery reports CLI and API readiness", { concurrency: false }, async () => {
  const sandbox = await createMissionSandbox("mission-provider-discovery");
  const cli = await createMockCliSuite();
  const env = {
    ...process.env,
    ORCHESTRUM_CODEX_BIN: cli.codex,
    ORCHESTRUM_CLAUDE_BIN: cli.claude,
    ORCHESTRUM_CURSOR_BIN: cli.cursor,
    MOCK_CODEX_AUTH: "1",
    MOCK_CLAUDE_AUTH: "1",
    MOCK_CURSOR_AUTH: "1"
  };

  const providers = await discoverMissionProviders({
    cwd: sandbox.repoPath,
    env,
    apiSecrets: { openai: true, claude: false }
  });

  const codex = providers.find((provider) => provider.vendor === "codex");
  const claude = providers.find((provider) => provider.vendor === "claude");
  const cursor = providers.find((provider) => provider.vendor === "cursor");
  const openai = providers.find((provider) => provider.vendor === "openai");

  assert.equal(codex?.transports.find((transport) => transport.transport === "cli")?.configured, true);
  assert.equal(cursor?.transports.find((transport) => transport.transport === "cli")?.configured, true);
  assert.equal(claude?.transports.find((transport) => transport.transport === "cli")?.configured, true);
  assert.equal(openai?.transports.find((transport) => transport.transport === "api")?.configured, true);
  assert.deepEqual(cursor?.transports.find((transport) => transport.transport === "cli")?.models?.slice(0, 2), ["sonnet-4", "gpt-5"]);
});

test("codex CLI adapter runs non-interactively", { concurrency: false }, async () => {
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

test("feature-dev mission completes with OpenAI-backed agents", { concurrency: false }, async () => {
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

test("feature-dev mission pauses for approval and resumes with Claude-backed agents", { concurrency: false }, async () => {
  const sandbox = await createMissionSandbox("mission-claude-approval", {
    relativePath: path.join(".github", "workflows", "ci.yml"),
    initialContent: "name: ci\n"
  });
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = mockProviderFetch("claude", [
    { text: "Protect workflow update." },
    { text: wrapDiff(singleLineDiff(".github/workflows/ci.yml", "name: ci", "name: ci # OPENAI_API_KEY=test")) }
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
    assert.equal(resumed.run.status, "finished");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, ".github", "workflows", "ci.yml"), "utf8"), /OPENAI_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

test("feature-dev mission completes with CLI-backed agents", { concurrency: false }, async () => {
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
      agents: buildCliFeatureAgents()
    });

    assert.equal(result.ok, true);
    assert.equal(result.run.status, "finished");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8"), /false/);
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

test("feature-dev mission falls back from Claude CLI to Claude API", { concurrency: false }, async () => {
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

test("delivery-sprint mission waits for import and resumes after completed handoff", { concurrency: false }, async () => {
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
    assert.ok(fsSync.existsSync(path.join(firstPass.runDir, "nodes", "handoff_export", "packet.md")));

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

test("delivery-sprint mission fails when imported handoff is blocked", { concurrency: false }, async () => {
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

async function createMissionSandbox(prefix: string, fileOverride?: {
  relativePath: string;
  initialContent: string;
}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const repoPath = path.join(rootDir, "repo");
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: prefix, version: "1.0.0" }, null, 2), "utf8");
  await fs.writeFile(path.join(repoPath, "README.md"), "# Demo\n", "utf8");
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");
  if (fileOverride) {
    await fs.mkdir(path.join(repoPath, path.dirname(fileOverride.relativePath)), { recursive: true });
    await fs.writeFile(path.join(repoPath, fileOverride.relativePath), fileOverride.initialContent, "utf8");
  }
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  return { rootDir, repoPath, runsDir };
}

function buildAgents(provider: "openai" | "claude"): MissionAgent[] {
  return [
    missionAgent("pm", providerSpec(provider)),
    missionAgent("dev", providerSpec(provider)),
    missionAgent("audit", providerSpec(provider))
  ];
}

function buildDeliveryAgents(provider: "openai" | "claude"): MissionAgent[] {
  return [
    missionAgent("pm", providerSpec(provider)),
    missionAgent("audit", providerSpec(provider))
  ];
}

function buildCliFeatureAgents(): MissionAgent[] {
  return [
    missionAgent("pm", {
      vendor: "claude",
      transport: "cli",
      profileId: "claude-cli-sonnet",
      auth: { kind: "cli" },
      fallback: {
        vendor: "claude",
        transport: "api",
        profileId: "claude-api-sonnet",
        auth: { kind: "api_key", secretRef: "ANTHROPIC_API_KEY" }
      }
    }),
    missionAgent("dev", {
      vendor: "cursor",
      transport: "cli",
      profileId: "cursor-cli-sonnet",
      auth: { kind: "cli" }
    }),
    missionAgent("audit", {
      vendor: "claude",
      transport: "cli",
      profileId: "claude-cli-sonnet",
      auth: { kind: "cli" },
      fallback: {
        vendor: "claude",
        transport: "api",
        profileId: "claude-api-sonnet",
        auth: { kind: "api_key", secretRef: "ANTHROPIC_API_KEY" }
      }
    })
  ];
}

function missionAgent(role: string, provider: MissionProviderSpec): MissionAgent {
  return {
    id: `${provider.vendor}-${role}`,
    name: `${role} ${provider.vendor}`,
    role,
    provider,
    capabilities: {
      fs: true,
      network: true,
      shell: false
    }
  };
}

function providerSpec(provider: "openai" | "claude"): MissionProviderSpec {
  if (provider === "claude") {
    return {
      vendor: "claude",
      transport: "api",
      profileId: "claude-api-sonnet",
      modelOverride: "claude-3-5-sonnet-latest",
      auth: { kind: "api_key", secretRef: "ANTHROPIC_API_KEY" }
    };
  }
  return {
    vendor: "openai",
    transport: "api",
    profileId: "openai-api-gpt5",
    modelOverride: "gpt-4.1-mini",
    auth: { kind: "api_key", secretRef: "OPENAI_API_KEY" }
  };
}

async function createMockCliSuite() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-cli-bin-"));
  const scripts = {
    codex: path.join(binDir, "mock-codex.cjs"),
    claude: path.join(binDir, "mock-claude.cjs"),
    cursor: path.join(binDir, "mock-cursor.cjs")
  };

  await writeExecutable(scripts.codex, createMockCliScript("codex"));
  await writeExecutable(scripts.claude, createMockCliScript("claude"));
  await writeExecutable(scripts.cursor, createMockCliScript("cursor"));

  return scripts;
}

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

function createMockCliScript(vendor: "codex" | "claude" | "cursor"): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const vendor = ${JSON.stringify(vendor)};
const stdin = (() => {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
})();
const prompt = stdin.trim() || args[args.length - 1] || "";
const authKey = vendor === "codex" ? "MOCK_CODEX_AUTH" : vendor === "claude" ? "MOCK_CLAUDE_AUTH" : "MOCK_CURSOR_AUTH";
const authenticated = process.env[authKey] !== "0";

if (vendor === "codex" && args.includes("--version")) {
  console.log("codex-cli 1.0.0");
  process.exit(0);
}
if (vendor === "claude" && args.includes("-v")) {
  console.log("claude-cli 1.0.0");
  process.exit(0);
}
if (vendor === "cursor" && args.includes("-v")) {
  console.log("cursor-agent 1.0.0");
  process.exit(0);
}

if (vendor === "codex" && args[0] === "login" && args[1] === "status") {
  console.log(authenticated ? "Logged in" : "Not logged in");
  process.exit(0);
}
if (vendor === "claude" && args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ authenticated, status: authenticated ? "authenticated" : "unauthenticated" }));
  process.exit(0);
}
if (vendor === "cursor" && args[0] === "agent" && args[1] === "status") {
  console.log(authenticated ? "Logged in as cursor-user" : "Not logged in");
  process.exit(0);
}
if (vendor === "cursor" && args[0] === "agent" && args[1] === "models") {
  console.log("sonnet-4\\ngpt-5");
  process.exit(0);
}

if (vendor === "codex" && args[0] === "exec") {
  if (!authenticated) {
    console.error("Not logged in");
    process.exit(1);
  }
  const outputIndex = args.indexOf("-o");
  if (outputIndex >= 0 && args[outputIndex + 1]) {
    fs.writeFileSync(args[outputIndex + 1], "codex execution complete\\n", "utf8");
  }
  if (args.includes("--full-auto")) {
    const repoIndex = args.indexOf("-C");
    const repoPath = repoIndex >= 0 ? args[repoIndex + 1] : process.cwd();
    fs.writeFileSync(path.join(repoPath, "src", "index.ts"), "export const ok = false;\\n", "utf8");
  }
  console.log(JSON.stringify({ text: "codex execution complete", usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
  process.exit(0);
}

if (vendor === "claude" && args[0] === "-p") {
  if (!authenticated) {
    console.error("Not logged in");
    process.exit(1);
  }
  const output = prompt.includes("Produce JSON ONLY")
    ? JSON.stringify({ blocking: false, issues: [] })
    : "Implementation plan ready.";
  console.log(JSON.stringify({ result: output, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } }));
  process.exit(0);
}

if (vendor === "cursor" && args[0] === "agent" && args.includes("-p")) {
  if (!authenticated) {
    console.error("Not logged in");
    process.exit(1);
  }
  if (args.includes("--force")) {
    const workspaceIndex = args.indexOf("--workspace");
    const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.cwd();
    fs.writeFileSync(path.join(workspace, "src", "index.ts"), "export const ok = false;\\n", "utf8");
  }
  console.log(JSON.stringify({ text: "cursor implementation complete", usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }));
  process.exit(0);
}

console.log(JSON.stringify({ text: vendor + " noop" }));
`;
}

function mockProviderFetch(provider: "openai" | "claude", responses: Array<{
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}>) {
  const queue = [...responses];
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("localhost:11434") || url.includes("localhost:8080")) {
      return new Response("unavailable", { status: 503 });
    }
    const next = queue.shift();
    assert.ok(next, `Unexpected ${provider} fetch call: ${String(input)}`);
    if (provider === "openai") {
      assert.match(url, /\/responses$/);
      return new Response(JSON.stringify({
        output_text: next.text,
        usage: next.usage ?? { input_tokens: 9, output_tokens: 4, total_tokens: 13 }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    assert.match(url, /\/messages$/);
    return new Response(JSON.stringify({
      content: [{ type: "text", text: next.text }],
      usage: next.usage ?? { input_tokens: 9, output_tokens: 4 }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function wrapDiff(diffText: string): string {
  return `\`\`\`diff\n${diffText}\n\`\`\``;
}

function singleLineDiff(filePath: string, before: string, after: string): string {
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}
