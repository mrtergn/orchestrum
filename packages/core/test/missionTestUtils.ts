import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { MissionAgent, MissionProviderSpec } from "../src/mission/types.js";

const execFileAsync = promisify(execFile);

export async function createMissionSandbox(prefix: string, fileOverride?: {
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
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: repoPath });
  await execFileAsync("git", ["config", "core.eol", "lf"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  return { rootDir, repoPath, runsDir };
}

export function buildAgents(provider: "openai" | "claude"): MissionAgent[] {
  return [
    missionAgent("pm", providerSpec(provider)),
    missionAgent("dev", providerSpec(provider)),
    missionAgent("audit", providerSpec(provider))
  ];
}

export function buildDeliveryAgents(provider: "openai" | "claude"): MissionAgent[] {
  return [
    missionAgent("pm", providerSpec(provider)),
    missionAgent("audit", providerSpec(provider))
  ];
}

export function buildCliFeatureAgents(): MissionAgent[] {
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

export async function createMockCliSuite() {
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

export function mockProviderFetch(provider: "openai" | "claude", responses: Array<{
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

export function wrapDiff(diffText: string): string {
  return `\`\`\`diff\n${diffText}\n\`\`\``;
}

export function singleLineDiff(filePath: string, before: string, after: string): string {
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}
