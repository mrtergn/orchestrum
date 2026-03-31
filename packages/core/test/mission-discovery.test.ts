import { test } from "vitest";
import assert from "node:assert/strict";
import { completeWithProvider, defaultProviderForRole, discoverMissionProviders } from "../src/mission/providers.js";
import { createMissionSandbox, createMockCliSuite } from "./missionTestUtils.js";

test("provider URL validation blocks unknown API hosts", async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_API_BASE_URL;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_API_BASE_URL = "https://malicious.internal/v1";

  try {
    await assert.rejects(
      () => completeWithProvider({
        vendor: "openai",
        transport: "api",
        auth: { kind: "api_key", secretRef: "OPENAI_API_KEY" }
      }, "ping", process.env),
      /host is not allowed/
    );
  } finally {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
    process.env.OPENAI_API_BASE_URL = originalBaseUrl;
  }
});

test("provider discovery reports CLI and API readiness", async () => {
  const sandbox = await createMissionSandbox("mission-provider-discovery");
  const cli = await createMockCliSuite();
  const env = {
    ...process.env,
    ORCHESTRUM_CODEX_BIN: cli.codex,
    ORCHESTRUM_COPILOT_BIN: cli.copilot,
    ORCHESTRUM_CLAUDE_BIN: cli.claude,
    ORCHESTRUM_CURSOR_BIN: cli.cursor,
    MOCK_CODEX_AUTH: "1",
    MOCK_COPILOT_AUTH: "1",
    MOCK_CLAUDE_AUTH: "1",
    MOCK_CURSOR_AUTH: "1",
    COPILOT_GITHUB_TOKEN: "github_pat_test"
  };

  const providers = await discoverMissionProviders({
    cwd: sandbox.repoPath,
    env,
    apiSecrets: { openai: true, claude: false }
  });

  const codex = providers.find((provider) => provider.vendor === "codex");
  const copilot = providers.find((provider) => provider.vendor === "copilot");
  const claude = providers.find((provider) => provider.vendor === "claude");
  const cursor = providers.find((provider) => provider.vendor === "cursor");
  const openai = providers.find((provider) => provider.vendor === "openai");

  assert.equal(codex?.transports.find((transport) => transport.transport === "cli")?.configured, true);
  assert.equal(copilot?.transports.find((transport) => transport.transport === "cli")?.configured, true);
  assert.equal(cursor?.transports.find((transport) => transport.transport === "cli")?.configured, true);
  assert.equal(claude?.transports.find((transport) => transport.transport === "cli")?.configured, true);
  assert.equal(openai?.transports.find((transport) => transport.transport === "api")?.configured, true);
  assert.deepEqual(cursor?.transports.find((transport) => transport.transport === "cli")?.models?.slice(0, 2), ["sonnet-4", "gpt-5"]);
});

test("copilot discovery stays detected without env auth", async () => {
  const sandbox = await createMissionSandbox("mission-provider-discovery-copilot");
  const cli = await createMockCliSuite();
  const env = {
    ...process.env,
    ORCHESTRUM_COPILOT_BIN: cli.copilot,
    MOCK_COPILOT_AUTH: "1",
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    COPILOT_PROVIDER_BASE_URL: undefined,
    COPILOT_PROVIDER_BEARER_TOKEN: undefined,
    COPILOT_PROVIDER_API_KEY: undefined
  };

  const providers = await discoverMissionProviders({
    cwd: sandbox.repoPath,
    env
  });

  const copilot = providers.find((provider) => provider.vendor === "copilot");
  const transport = copilot?.transports.find((entry) => entry.transport === "cli");
  assert.equal(transport?.available, true);
  assert.equal(transport?.configured, false);
  assert.match(transport?.reason ?? "", /interactive login is verified at first run/i);
});

test("default provider routing prefers copilot for dev and general roles", () => {
  const dev = defaultProviderForRole("dev");
  const general = defaultProviderForRole("research");
  const pm = defaultProviderForRole("pm");
  const audit = defaultProviderForRole("audit");

  assert.equal(dev.vendor, "copilot");
  assert.equal(dev.transport, "cli");
  assert.equal(dev.profileId, "copilot-cli-gpt54");
  assert.equal(dev.fallback?.vendor, "codex");

  assert.equal(general.vendor, "copilot");
  assert.equal(general.transport, "cli");
  assert.equal(general.profileId, "copilot-cli-gpt54-mini");
  assert.equal(general.fallback?.vendor, "codex");

  assert.equal(pm.vendor, "claude");
  assert.equal(audit.vendor, "claude");
});
