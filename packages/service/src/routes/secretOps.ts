import type express from "express";
import {
  discoverMissionProviders,
  getSecret,
  listSecrets,
  setSecret,
  unsetSecret
} from "@orchestrum/core";

export function registerSecretOpsRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    useKeychain: boolean;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  }
): void {
  const secretsListRoutes = ["/secrets", "/api/secrets"] as const;
  for (const route of secretsListRoutes) {
    app.get(route, async (req, res) => {
      const scope = req.query.scope === "workspace" ? "workspace" : "global";
      const workspacePath =
        scope === "workspace" ? await options.resolveWorkspacePath(req.query.workspace as string | undefined) : null;
      if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
      const names = await listSecrets(scope, workspacePath ?? undefined);
      const keysToReport = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
      const keyStatus: Record<string, boolean> = {};
      for (const keyName of keysToReport) {
        const hasStoredName = names.includes(keyName);
        const hasEnv = Boolean(process.env[keyName]);
        const value = await getSecret({
          name: keyName,
          scope,
          repoPath: workspacePath ?? undefined,
          useKeychain: options.useKeychain
        }).catch(() => null);
        keyStatus[keyName] = hasStoredName || hasEnv || Boolean(value);
      }
      res.json({
        scope,
        keys: keyStatus,
        names,
        keychainEnabled: options.useKeychain,
        encryptionMode: options.useKeychain ? "os-keychain" : "encrypted-file"
      });
    });
  }

  const setSecretRoutes = ["/secrets", "/api/secrets/set"] as const;
  for (const route of setSecretRoutes) {
    app.post(route, async (req, res) => {
      const scope = req.body?.scope === "workspace" ? "workspace" : "global";
      const keyName = String(req.body?.keyName ?? req.body?.name ?? "");
      const value = String(req.body?.value ?? "");
      const passphrase = req.body?.passphrase ? String(req.body.passphrase) : undefined;
      const workspacePath = scope === "workspace" ? await options.resolveWorkspacePath(req.body?.workspaceId) : null;
      if (!keyName || !value) return res.status(400).json({ error: "keyName and value required" });
      if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
      try {
        await setSecret({
          name: keyName,
          value,
          scope,
          repoPath: workspacePath ?? undefined,
          passphrase,
          useKeychain: options.useKeychain
        });
        res.json({ ok: true });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "Failed to set secret" });
      }
    });
  }

  const unsetSecretRoutes = ["/secrets/unset", "/api/secrets/unset"] as const;
  for (const route of unsetSecretRoutes) {
    app.post(route, async (req, res) => {
      const scope = req.body?.scope === "workspace" ? "workspace" : "global";
      const keyName = String(req.body?.keyName ?? req.body?.name ?? "");
      const passphrase = req.body?.passphrase ? String(req.body.passphrase) : undefined;
      const workspacePath = scope === "workspace" ? await options.resolveWorkspacePath(req.body?.workspaceId) : null;
      if (!keyName) return res.status(400).json({ error: "keyName required" });
      if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
      try {
        await unsetSecret({
          name: keyName,
          scope,
          repoPath: workspacePath ?? undefined,
          passphrase,
          useKeychain: options.useKeychain
        });
        res.json({ ok: true });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "Failed to unset secret" });
      }
    });
  }

  app.post("/api/secrets/test", async (req, res) => {
    const provider = String(req.body?.vendor ?? req.body?.provider ?? "openai").toLowerCase();
    const transport = req.body?.transport
      ? String(req.body.transport).toLowerCase()
      : (provider === "openai" ? "api" : provider === "claude" ? "api" : "cli");
    const scope = req.body?.scope === "workspace" ? "workspace" : "global";
    const workspacePath = scope === "workspace" ? await options.resolveWorkspacePath(req.body?.workspaceId) : null;
    if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const passphrase = req.body?.passphrase ? String(req.body.passphrase) : undefined;
    if (transport !== "api") {
      const discovery = await buildProviderDiscovery({
        rootDir: options.rootDir,
        workspacePath: workspacePath ?? undefined,
        scope,
        passphrase,
        useKeychain: options.useKeychain
      });
      const record = discovery.find((entry) => entry.vendor === provider);
      const match = record?.transports.find((entry) => entry.transport === transport);
      if (!match) {
        return res.status(400).json({ ok: false, error: `Unsupported provider transport: ${provider}/${transport}` });
      }
      if (!match.available) {
        return res.status(400).json({ ok: false, provider, transport, error: match.reason ?? "Provider transport is unavailable." });
      }
      if (!match.configured) {
        return res.status(400).json({ ok: false, provider, transport, error: match.reason ?? "Provider transport is not configured." });
      }
      return res.json({
        ok: true,
        provider,
        transport,
        model: match.profiles.find((profile) => profile.recommended)?.model ?? match.models?.[0] ?? undefined
      });
    }
    const secretName =
      provider === "claude"
        ? "ANTHROPIC_API_KEY"
        : provider === "openai"
          ? "OPENAI_API_KEY"
          : "";
    if (!secretName) {
      return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }
    const apiKey = await getSecret({
      name: secretName,
      scope,
      repoPath: workspacePath ?? undefined,
      passphrase,
      useKeychain: options.useKeychain
    }).catch(() => null);
    if (!apiKey) {
      return res.status(400).json({ ok: false, error: `${secretName} is not configured.` });
    }
    const testResult = provider === "claude"
      ? await testClaudeConnection(apiKey)
      : await testOpenAiConnection(apiKey);
    if (!testResult.ok) {
      return res.status(400).json(testResult);
    }
    res.json(testResult);
  });

  app.get("/api/providers/discover", async (req, res) => {
    const scope = req.query.scope === "workspace" ? "workspace" : "global";
    const workspacePath = scope === "workspace" ? await options.resolveWorkspacePath(req.query.workspace as string | undefined) : null;
    if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const discovery = await buildProviderDiscovery({
      rootDir: options.rootDir,
      workspacePath: workspacePath ?? undefined,
      scope,
      useKeychain: options.useKeychain
    });
    res.json({ providers: discovery });
  });
}

async function buildProviderDiscovery(options: {
  rootDir: string;
  workspacePath?: string;
  scope: "workspace" | "global";
  passphrase?: string;
  useKeychain?: boolean;
}) {
  const [openAiKey, claudeKey] = await Promise.all([
    getSecret({
      name: "OPENAI_API_KEY",
      scope: options.scope,
      repoPath: options.workspacePath,
      passphrase: options.passphrase,
      useKeychain: options.useKeychain
    }).catch(() => null),
    getSecret({
      name: "ANTHROPIC_API_KEY",
      scope: options.scope,
      repoPath: options.workspacePath,
      passphrase: options.passphrase,
      useKeychain: options.useKeychain
    }).catch(() => null)
  ]);

  return discoverMissionProviders({
    cwd: options.workspacePath ?? options.rootDir,
    env: process.env,
    apiSecrets: {
      openai: Boolean(openAiKey),
      claude: Boolean(claudeKey)
    }
  });
}

async function testOpenAiConnection(apiKey: string): Promise<{ ok: boolean; provider: string; model?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401) {
        return { ok: false, provider: "openai", error: "Authentication failed. Check OPENAI_API_KEY." };
      }
      return { ok: false, provider: "openai", error: `OpenAI API returned ${response.status}.` };
    }
    const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    const model = payload.data?.[0]?.id;
    return { ok: true, provider: "openai", model };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, provider: "openai", error: "Connection timed out." };
    }
    return { ok: false, provider: "openai", error: "Unable to reach OpenAI API." };
  } finally {
    clearTimeout(timeout);
  }
}

async function testClaudeConnection(apiKey: string): Promise<{ ok: boolean; provider: string; model?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401) {
        return { ok: false, provider: "claude", error: "Authentication failed. Check ANTHROPIC_API_KEY." };
      }
      return { ok: false, provider: "claude", error: `Anthropic API returned ${response.status}.` };
    }
    return { ok: true, provider: "claude", model: "claude-3-5-sonnet-latest" };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, provider: "claude", error: "Connection timed out." };
    }
    return { ok: false, provider: "claude", error: "Unable to reach Anthropic API." };
  } finally {
    clearTimeout(timeout);
  }
}
