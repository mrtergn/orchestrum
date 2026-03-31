import { test } from "vitest";
import assert from "node:assert/strict";
import { completeWithProvider, discoverMissionProviders } from "../src/mission/providers.js";
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
