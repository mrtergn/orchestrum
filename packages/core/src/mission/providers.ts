import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAIProvider } from "../runner/providers/openai.js";
import { OllamaProvider } from "../runner/providers/ollama.js";
import { LlamaCppProvider } from "../runner/providers/llamaCpp.js";
import { ClaudeProvider } from "../runner/providers/claude.js";
import { lookupBinary, runBinary } from "../runner/bin.js";
import type { AgentResult } from "../agents/index.js";
import type {
  CanonicalProvider,
  NodeExecutorKind,
  ProviderAuthConfig,
  ProviderCapabilitySummary,
  ProviderDiscoveryRecord,
  ProviderDiscoveryTransport,
  ProviderEffort,
  ProviderProfile,
  ProviderSpec,
  ProviderTransport,
  ProviderVendor
} from "./types.js";

export type ProviderExecutionOptions = {
  repoPath?: string;
  artifactDir?: string;
  role?: string;
  executor?: NodeExecutorKind;
  timeoutMs?: number;
  apiSecrets?: Partial<Record<"openai" | "claude", boolean>>;
};

export type ProviderExecutionResult = AgentResult & {
  vendor: ProviderVendor;
  transport: ProviderTransport;
  profileId?: string;
  model: string;
  effort?: ProviderEffort;
  authSource?: string | null;
  exitCode?: number | null;
  binaryPath?: string | null;
  nativeWrite: boolean;
};

type SupportedTransport = {
  transport: ProviderTransport;
  capabilities: ProviderCapabilitySummary;
};

type ResolvedProviderExecution = {
  vendor: ProviderVendor;
  transport: ProviderTransport;
  profileId?: string;
  model: string;
  effort?: ProviderEffort;
  auth: ProviderAuthConfig;
  authSource?: string | null;
  binaryPath?: string | null;
  nativeWrite: boolean;
  role?: string;
  executor?: NodeExecutorKind;
};

const CLI_VENDOR_BINARIES: Partial<Record<ProviderVendor, string>> = {
  codex: "codex",
  claude: "claude",
  cursor: "cursor"
};

const CLI_ENV_BINARIES: Partial<Record<ProviderVendor, string>> = {
  codex: "ORCHESTRUM_CODEX_BIN",
  claude: "ORCHESTRUM_CLAUDE_BIN",
  cursor: "ORCHESTRUM_CURSOR_BIN"
};

const PROVIDER_CAPABILITIES: Record<ProviderVendor, SupportedTransport[]> = {
  codex: [{
    transport: "cli",
    capabilities: {
      supportsTools: true,
      supportsEffort: false,
      supportsReadOnlyMode: true,
      supportsJsonOutput: true,
      supportsModelDiscovery: false,
      supportsAuthProbe: true
    }
  }],
  claude: [
    {
      transport: "cli",
      capabilities: {
        supportsTools: true,
        supportsEffort: true,
        supportsReadOnlyMode: true,
        supportsJsonOutput: true,
        supportsModelDiscovery: false,
        supportsAuthProbe: true
      }
    },
    {
      transport: "api",
      capabilities: {
        supportsTools: false,
        supportsEffort: false,
        supportsReadOnlyMode: false,
        supportsJsonOutput: false,
        supportsModelDiscovery: false,
        supportsAuthProbe: false
      }
    }
  ],
  cursor: [{
    transport: "cli",
    capabilities: {
      supportsTools: true,
      supportsEffort: false,
      supportsReadOnlyMode: true,
      supportsJsonOutput: true,
      supportsModelDiscovery: true,
      supportsAuthProbe: true
    }
  }],
  openai: [{
    transport: "api",
    capabilities: {
      supportsTools: false,
      supportsEffort: false,
      supportsReadOnlyMode: false,
      supportsJsonOutput: false,
      supportsModelDiscovery: false,
      supportsAuthProbe: false
    }
  }],
  ollama: [{
    transport: "local_http",
    capabilities: {
      supportsTools: false,
      supportsEffort: false,
      supportsReadOnlyMode: false,
      supportsJsonOutput: false,
      supportsModelDiscovery: false,
      supportsAuthProbe: false
    }
  }],
  "llama.cpp": [{
    transport: "local_http",
    capabilities: {
      supportsTools: false,
      supportsEffort: false,
      supportsReadOnlyMode: false,
      supportsJsonOutput: false,
      supportsModelDiscovery: false,
      supportsAuthProbe: false
    }
  }]
};

const PROVIDER_LABELS: Record<ProviderVendor, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  openai: "OpenAI",
  ollama: "Ollama",
  "llama.cpp": "llama.cpp"
};

const KNOWN_API_HOSTS: Record<"openai" | "claude", RegExp[]> = {
  openai: [/^api\.openai\.com$/i],
  claude: [/^api\.anthropic\.com$/i]
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: "codex-cli-balanced",
    vendor: "codex",
    transport: "cli",
    label: "Balanced",
    description: "General-purpose Codex CLI profile.",
    model: "gpt-5",
    recommended: true,
    roleHints: ["pm", "dev", "audit"]
  },
  {
    id: "claude-cli-sonnet",
    vendor: "claude",
    transport: "cli",
    label: "Sonnet",
    description: "Fast Claude CLI profile for planning and review.",
    model: "sonnet",
    recommended: true,
    roleHints: ["pm", "audit"]
  },
  {
    id: "claude-api-sonnet",
    vendor: "claude",
    transport: "api",
    label: "Anthropic Sonnet",
    description: "API fallback profile for Claude missions.",
    model: "claude-3-5-sonnet-latest",
    recommended: true,
    roleHints: ["pm", "audit"]
  },
  {
    id: "cursor-cli-sonnet",
    vendor: "cursor",
    transport: "cli",
    label: "Sonnet 4",
    description: "Cursor Agent profile tuned for implementation work.",
    model: "sonnet-4",
    recommended: true,
    roleHints: ["dev"]
  },
  {
    id: "openai-api-gpt5",
    vendor: "openai",
    transport: "api",
    label: "GPT-5",
    description: "General-purpose OpenAI API profile.",
    model: "gpt-5",
    recommended: true,
    roleHints: ["pm", "dev", "audit"]
  },
  {
    id: "ollama-local-default",
    vendor: "ollama",
    transport: "local_http",
    label: "Default Local Model",
    description: "Default Ollama HTTP profile.",
    model: "llama3.1:8b",
    recommended: true,
    roleHints: ["pm", "dev", "audit"]
  },
  {
    id: "llama-cpp-local-default",
    vendor: "llama.cpp",
    transport: "local_http",
    label: "Default Local Model",
    description: "Default llama.cpp HTTP profile.",
    model: "local-model",
    recommended: true,
    roleHints: ["pm", "dev", "audit"]
  }
];

const PROFILE_MAP = new Map(PROVIDER_PROFILES.map((profile) => [profile.id, profile]));

export function normalizeCanonicalProvider(input: string | null | undefined): CanonicalProvider {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "codex") return "codex";
  if (normalized === "claude") return "claude";
  if (normalized === "cursor") return "cursor";
  if (normalized === "ollama") return "ollama";
  if (normalized === "llama_cpp" || normalized === "llama.cpp" || normalized === "local") return "llama.cpp";
  return "openai";
}

export function normalizeProviderTransport(input: string | null | undefined): ProviderTransport {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "cli") return "cli";
  if (normalized === "local_http" || normalized === "local-http" || normalized === "local") return "local_http";
  return "api";
}

export function defaultApiKeyRef(provider: ProviderVendor): string | undefined {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "claude") return "ANTHROPIC_API_KEY";
  return undefined;
}

export function listProviderProfiles(vendor?: ProviderVendor, transport?: ProviderTransport): ProviderProfile[] {
  return PROVIDER_PROFILES.filter((profile) => {
    if (vendor && profile.vendor !== vendor) return false;
    if (transport && profile.transport !== transport) return false;
    return true;
  });
}

export function defaultProviderForRole(role?: string): ProviderSpec {
  const normalizedRole = (role ?? "").trim().toLowerCase();
  if (normalizedRole.includes("audit")) {
    return {
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
    };
  }
  if (normalizedRole.includes("dev")) {
    return {
      vendor: "cursor",
      transport: "cli",
      profileId: "cursor-cli-sonnet",
      auth: { kind: "cli" },
      fallback: {
        vendor: "codex",
        transport: "cli",
        profileId: "codex-cli-balanced",
        auth: { kind: "cli" }
      }
    };
  }
  if (normalizedRole.includes("pm") || normalizedRole.includes("plan")) {
    return {
      vendor: "claude",
      transport: "cli",
      profileId: "claude-cli-sonnet",
      auth: { kind: "cli" },
      fallback: {
        vendor: "openai",
        transport: "api",
        profileId: "openai-api-gpt5",
        auth: { kind: "api_key", secretRef: "OPENAI_API_KEY" }
      }
    };
  }
  return {
    vendor: "codex",
    transport: "cli",
    profileId: "codex-cli-balanced",
    auth: { kind: "cli" }
  };
}

export function normalizeMissionProvider(input: unknown, role?: string): ProviderSpec {
  if (!input || typeof input !== "object") return defaultProviderForRole(role);
  const provider = input as Record<string, unknown>;

  if (typeof provider.vendor === "string" || typeof provider.transport === "string") {
    return {
      vendor: normalizeCanonicalProvider(readString(provider.vendor) ?? roleVendorFallback(role)),
      transport: normalizeProviderTransport(readString(provider.transport) ?? inferDefaultTransport(readString(provider.vendor) ?? undefined)),
      profileId: readString(provider.profileId) ?? undefined,
      modelOverride: readString(provider.modelOverride) ?? undefined,
      effort: normalizeEffort(readString(provider.effort)) ?? undefined,
      auth: normalizeAuthConfig(provider.auth, readString(provider.vendor) ?? undefined, readString(provider.transport) ?? undefined),
      fallback: normalizeFallback(provider.fallback)
    };
  }

  if (
    provider.provider !== undefined ||
    provider.type !== undefined ||
    provider.model !== undefined ||
    provider.apiKeyRef !== undefined
  ) {
    throw new Error("Legacy provider schema is not supported. Use vendor/transport/profileId/auth fields.");
  }

  return defaultProviderForRole(role);
}

export async function discoverMissionProviders(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  apiSecrets?: Partial<Record<"openai" | "claude", boolean>>;
} = {}): Promise<ProviderDiscoveryRecord[]> {
  const env = options.env ?? process.env;
  const cwd = options.cwd;

  const records = await Promise.all(Object.keys(PROVIDER_LABELS).map(async (vendorName) => {
    const vendor = vendorName as ProviderVendor;
    const transports = await Promise.all(PROVIDER_CAPABILITIES[vendor].map(async ({ transport, capabilities }) => {
      if (transport === "cli") {
        return discoverCliTransport(vendor, capabilities, cwd, env);
      }
      if (transport === "api") {
        return discoverApiTransport(vendor, capabilities, env, options.apiSecrets);
      }
      return discoverLocalHttpTransport(vendor, capabilities, env);
    }));
    const preferredTransport = transports.find((transport) => transport.configured)?.transport
      ?? transports.find((transport) => transport.available)?.transport
      ?? null;
    return {
      vendor,
      label: PROVIDER_LABELS[vendor],
      transports,
      preferredTransport
    } satisfies ProviderDiscoveryRecord;
  }));

  return records;
}

export async function completeWithProvider(
  spec: ProviderSpec,
  prompt: string,
  env: NodeJS.ProcessEnv,
  options: ProviderExecutionOptions = {}
): Promise<ProviderExecutionResult> {
  const resolved = await resolveProviderExecution(spec, env, options);

  if (resolved.transport === "cli") {
    return completeWithCli(resolved, prompt, env, options);
  }

  if (resolved.vendor === "claude" && resolved.transport === "api") {
    const keyRef = resolved.auth.secretRef ?? defaultApiKeyRef(resolved.vendor) ?? "ANTHROPIC_API_KEY";
    const configuredBaseUrl = firstNonEmptyEnv(env.ANTHROPIC_API_BASE_URL) ?? "https://api.anthropic.com/v1";
    const baseUrl = validateApiBaseUrl(
      configuredBaseUrl,
      "claude",
      configuredBaseUrl === "https://api.anthropic.com/v1" ? "default" : "ANTHROPIC_API_BASE_URL"
    );
    const client = new ClaudeProvider(env[keyRef] ?? "", baseUrl);
    const result = await client.complete({ model: resolved.model, prompt });
    return {
      ...result,
      vendor: resolved.vendor,
      transport: resolved.transport,
      profileId: resolved.profileId,
      model: resolved.model,
      effort: resolved.effort,
      authSource: `api_key:${keyRef}`,
      exitCode: 0,
      nativeWrite: false
    };
  }

  if (resolved.vendor === "ollama" && resolved.transport === "local_http") {
    const endpoint = localHttpEndpointFor("ollama", env);
    const client = new OllamaProvider(endpoint);
    const result = await client.complete({ model: resolved.model, prompt });
    return {
      text: result.text,
      vendor: resolved.vendor,
      transport: resolved.transport,
      profileId: resolved.profileId,
      model: resolved.model,
      effort: resolved.effort,
      authSource: `local_http:${endpoint}`,
      exitCode: 0,
      nativeWrite: false
    };
  }

  if (resolved.vendor === "llama.cpp" && resolved.transport === "local_http") {
    const endpoint = localHttpEndpointFor("llama.cpp", env);
    const client = new LlamaCppProvider(endpoint);
    const result = await client.complete({ model: resolved.model, prompt });
    return {
      text: result.text,
      vendor: resolved.vendor,
      transport: resolved.transport,
      profileId: resolved.profileId,
      model: resolved.model,
      effort: resolved.effort,
      authSource: `local_http:${endpoint}`,
      exitCode: 0,
      nativeWrite: false
    };
  }

  const keyRef = resolved.auth.secretRef ?? defaultApiKeyRef(resolved.vendor) ?? "OPENAI_API_KEY";
  const configuredOpenAiBaseUrl = firstNonEmptyEnv(env.OPENAI_API_BASE_URL, env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1";
  const baseUrl = validateApiBaseUrl(
    configuredOpenAiBaseUrl,
    "openai",
    firstNonEmptyEnv(env.OPENAI_API_BASE_URL) ? "OPENAI_API_BASE_URL" : firstNonEmptyEnv(env.OPENAI_BASE_URL) ? "OPENAI_BASE_URL" : "default"
  );
  const mode = (env.OPENAI_API_MODE as "responses" | "chat" | "auto") ?? "auto";
  const client = new OpenAIProvider(env[keyRef] ?? "", baseUrl, mode);
  const result = await client.complete({ model: resolved.model, prompt });
  return {
    ...result,
    vendor: resolved.vendor,
    transport: resolved.transport,
    profileId: resolved.profileId,
    model: resolved.model,
    effort: resolved.effort,
    authSource: `api_key:${keyRef}`,
    exitCode: 0,
    nativeWrite: false
  };
}

async function resolveProviderExecution(
  spec: ProviderSpec,
  env: NodeJS.ProcessEnv,
  options: ProviderExecutionOptions
): Promise<ResolvedProviderExecution> {
  const normalized = normalizeMissionProvider(spec, options.role);
  const discovery = await discoverMissionProviders({
    cwd: options.repoPath,
    env,
    apiSecrets: options.apiSecrets
  });

  const primary = await resolveCandidate(normalized, discovery, options.role, options.executor);
  if (primary) return primary;

  const providerRecord = discovery.find((entry) => entry.vendor === normalized.vendor);
  const preferredTransport = providerRecord?.preferredTransport;
  if (preferredTransport && preferredTransport !== normalized.transport) {
    const autoFallback = await resolveCandidate({
      ...normalized,
      transport: preferredTransport,
      auth: defaultAuthFor(normalized.vendor, preferredTransport)
    }, discovery, options.role, options.executor);
    if (autoFallback) return autoFallback;
  }

  if (normalized.fallback) {
    const fallback = await resolveCandidate(normalized.fallback, discovery, options.role, options.executor);
    if (fallback) return fallback;
  }

  const transportSummary = discovery.find((entry) => entry.vendor === normalized.vendor)?.transports ?? [];
  const details = transportSummary.map((entry) => `${entry.transport}:${entry.reason ?? (entry.configured ? "ready" : "unavailable")}`).join(", ");
  throw new Error(`Provider ${normalized.vendor}/${normalized.transport} is not available. ${details || "No compatible transport found."}`);
}

async function resolveCandidate(
  spec: Omit<ProviderSpec, "fallback">,
  discovery: ProviderDiscoveryRecord[],
  role?: string,
  executor?: NodeExecutorKind
): Promise<ResolvedProviderExecution | null> {
  const vendor = spec.vendor;
  const transport = spec.transport;
  const providerRecord = discovery.find((entry) => entry.vendor === vendor);
  const transportRecord = providerRecord?.transports.find((entry) => entry.transport === transport);
  if (!transportRecord?.available || !transportRecord.configured) return null;

  const profile = resolveProfile(spec, role);
  const model = spec.modelOverride?.trim() || profile?.model || "";
  if (!model) {
    throw new Error(`Provider ${vendor}/${transport} requires a model or profile.`);
  }

  return {
    vendor,
    transport,
    profileId: spec.profileId ?? profile?.id,
    model,
    effort: transportRecord.capabilities.supportsEffort ? spec.effort : undefined,
    auth: spec.auth ?? defaultAuthFor(vendor, transport),
    authSource: transportRecord.authSource ?? null,
    binaryPath: transportRecord.binaryPath,
    nativeWrite: transport === "cli" && shouldUseNativeWrite(role, executor),
    role,
    executor
  };
}

async function completeWithCli(
  spec: ResolvedProviderExecution,
  prompt: string,
  env: NodeJS.ProcessEnv,
  options: ProviderExecutionOptions
): Promise<ProviderExecutionResult> {
  if (!spec.binaryPath) {
    throw new Error(`No CLI binary resolved for ${spec.vendor}.`);
  }

  const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const artifactDir = options.artifactDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-cli-"));

  if (spec.vendor === "codex") {
    const outputPath = path.join(artifactDir, "codex-last-message.txt");
    const args = [
      "exec",
      "--json",
      "-C",
      repoPath,
      "--skip-git-repo-check",
      "-m",
      spec.model,
      "-o",
      outputPath
    ];
    if (spec.nativeWrite) args.push("--full-auto");
    else args.push("--sandbox", "read-only");
    args.push("-");
    const result = await runBinary(spec.binaryPath, args, {
      cwd: repoPath,
      env,
      stdin: prompt,
      timeoutMs,
      allowNonZeroExit: true
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Codex exited with code ${result.exitCode}.`);
    }
    const output = await fs.readFile(outputPath, "utf8").catch(() => "");
    return {
      text: output.trim() || extractTextFromCliOutput(result.stdout),
      usage: extractUsageFromCliOutput(result.stdout),
      vendor: spec.vendor,
      transport: spec.transport,
      profileId: spec.profileId,
      model: spec.model,
      effort: spec.effort,
      authSource: spec.authSource ?? "cli_session",
      exitCode: result.exitCode,
      binaryPath: spec.binaryPath,
      nativeWrite: spec.nativeWrite
    };
  }

  if (spec.vendor === "claude") {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      spec.model
    ];
    if (spec.effort) {
      args.push("--effort", spec.effort);
    }
    args.push(
      "--permission-mode",
      spec.nativeWrite ? "acceptEdits" : "plan",
      "--add-dir",
      repoPath,
      prompt
    );
    const result = await runBinary(spec.binaryPath, args, {
      cwd: repoPath,
      env,
      timeoutMs,
      allowNonZeroExit: true
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Claude CLI exited with code ${result.exitCode}.`);
    }
    return {
      text: extractTextFromCliOutput(result.stdout),
      usage: extractUsageFromCliOutput(result.stdout),
      vendor: spec.vendor,
      transport: spec.transport,
      profileId: spec.profileId,
      model: spec.model,
      effort: spec.effort,
      authSource: spec.authSource ?? "cli_session",
      exitCode: result.exitCode,
      binaryPath: spec.binaryPath,
      nativeWrite: spec.nativeWrite
    };
  }

  const args = [
    "agent",
    "-p",
    "--output-format",
    "json",
    "--workspace",
    repoPath,
    "--model",
    spec.model
  ];
  if (spec.nativeWrite) args.push("--force");
  else args.push("--plan");
  args.push(prompt);
  const result = await runBinary(spec.binaryPath, args, {
    cwd: repoPath,
    env,
    timeoutMs,
    allowNonZeroExit: true
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Cursor Agent exited with code ${result.exitCode}.`);
  }
  return {
    text: extractTextFromCliOutput(result.stdout),
    usage: extractUsageFromCliOutput(result.stdout),
    vendor: spec.vendor,
    transport: spec.transport,
    profileId: spec.profileId,
    model: spec.model,
    effort: spec.effort,
    authSource: spec.authSource ?? "cli_session",
    exitCode: result.exitCode,
    binaryPath: spec.binaryPath,
    nativeWrite: spec.nativeWrite
  };
}

async function discoverCliTransport(
  vendor: ProviderVendor,
  capabilities: ProviderCapabilitySummary,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<ProviderDiscoveryTransport> {
  const binaryName = CLI_VENDOR_BINARIES[vendor];
  const binaryPath = binaryName ? await resolveCliBinary(vendor, env) : undefined;
  if (!binaryName || !binaryPath) {
    return {
      transport: "cli",
      available: false,
      configured: false,
      reason: `${PROVIDER_LABELS[vendor]} CLI not found on PATH.`,
      profiles: listProviderProfiles(vendor, "cli"),
      capabilities
    };
  }

  const [version, authProbe, models] = await Promise.all([
    probeCliVersion(vendor, binaryPath, cwd, env),
    probeCliAuth(vendor, binaryPath, cwd, env),
    capabilities.supportsModelDiscovery ? probeCliModels(vendor, binaryPath, cwd, env) : Promise.resolve([])
  ]);

  return {
    transport: "cli",
    available: true,
    configured: authProbe.ok,
    reason: authProbe.ok ? undefined : authProbe.reason,
    binaryPath,
    version,
    authSource: authProbe.ok ? "cli_session" : null,
    models: models.length > 0 ? models : undefined,
    profiles: models.length > 0
      ? injectDiscoveredModels(listProviderProfiles(vendor, "cli"), vendor, "cli", models)
      : listProviderProfiles(vendor, "cli"),
    capabilities
  };
}

async function discoverApiTransport(
  vendor: ProviderVendor,
  capabilities: ProviderCapabilitySummary,
  env: NodeJS.ProcessEnv,
  apiSecrets?: Partial<Record<"openai" | "claude", boolean>>
): Promise<ProviderDiscoveryTransport> {
  const secretName = defaultApiKeyRef(vendor);
  const configured = Boolean(secretName && ((apiSecrets && apiSecrets[vendor as "openai" | "claude"]) || env[secretName]));
  return {
    transport: "api",
    available: true,
    configured,
    reason: configured ? undefined : `${secretName ?? "API key"} is not configured.`,
    authSource: configured ? `api_key:${secretName}` : null,
    profiles: listProviderProfiles(vendor, "api"),
    capabilities
  };
}

async function discoverLocalHttpTransport(
  vendor: ProviderVendor,
  capabilities: ProviderCapabilitySummary,
  env: NodeJS.ProcessEnv
): Promise<ProviderDiscoveryTransport> {
  const endpoint = localHttpEndpointFor(vendor, env);
  const configured = await probeLocalHttpEndpoint(vendor, endpoint);
  return {
    transport: "local_http",
    available: configured,
    configured,
    reason: configured ? undefined : `${endpoint} is not responding.`,
    authSource: configured ? `local_http:${endpoint}` : null,
    profiles: listProviderProfiles(vendor, "local_http"),
    capabilities
  };
}

async function resolveCliBinary(vendor: ProviderVendor, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const overrideVar = CLI_ENV_BINARIES[vendor];
  const override = overrideVar ? env[overrideVar] : undefined;
  if (override?.trim()) {
    const resolved = override.trim();
    const exists = await fs.access(resolved).then(() => true).catch(() => false);
    return exists ? resolved : undefined;
  }
  const binaryName = CLI_VENDOR_BINARIES[vendor];
  if (!binaryName) return undefined;
  const detected = await lookupBinary(binaryName, env);
  return detected.path;
}

async function probeCliVersion(vendor: ProviderVendor, binaryPath: string, cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const args = vendor === "codex" ? ["--version"] : ["-v"];
  const result = await runBinary(binaryPath, args, {
    cwd,
    env,
    timeoutMs: 5000,
    allowNonZeroExit: true
  }).catch(() => null);
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || undefined;
}

async function probeCliAuth(
  vendor: ProviderVendor,
  binaryPath: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<{ ok: boolean; reason?: string }> {
  const args =
    vendor === "codex"
      ? ["login", "status"]
      : vendor === "claude"
        ? ["auth", "status", "--json"]
        : ["agent", "status"];
  const result = await runBinary(binaryPath, args, {
    cwd,
    env,
    timeoutMs: 5000,
    allowNonZeroExit: true
  }).catch(() => null);
  if (!result) return { ok: false, reason: `${PROVIDER_LABELS[vendor]} auth probe failed.` };
  const text = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
  if (vendor === "claude") {
    const json = parseJsonLoose(result.stdout);
    const authStatus = readString((json as Record<string, unknown> | null)?.status)?.toLowerCase();
    const authenticated = readBoolean((json as Record<string, unknown> | null)?.authenticated);
    const loggedIn = readBoolean((json as Record<string, unknown> | null)?.loggedIn);
    if (authenticated === true || loggedIn === true || authStatus === "authenticated") return { ok: true };
    return { ok: false, reason: "Claude CLI is installed but not authenticated." };
  }
  if (result.exitCode === 0 && !/(not logged|not authenticated|logged out|unauthenticated)/.test(text)) {
    return { ok: true };
  }
  return { ok: false, reason: `${PROVIDER_LABELS[vendor]} CLI is installed but not authenticated.` };
}

async function probeCliModels(
  vendor: ProviderVendor,
  binaryPath: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  if (vendor !== "cursor") return [];
  const result = await runBinary(binaryPath, ["agent", "models"], {
    cwd,
    env,
    timeoutMs: 5000,
    allowNonZeroExit: true
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => Boolean(line) && !/^available models/i.test(line) && !/^model\s+/i.test(line));
}

async function probeLocalHttpEndpoint(vendor: ProviderVendor, endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const url = vendor === "ollama"
    ? `${endpoint.replace(/\/$/, "")}/api/tags`
    : `${endpoint.replace(/\/$/, "")}/v1/models`;
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveProfile(spec: Omit<ProviderSpec, "fallback">, role?: string): ProviderProfile | undefined {
  if (spec.profileId && PROFILE_MAP.has(spec.profileId)) {
    return PROFILE_MAP.get(spec.profileId);
  }
  const profiles = listProviderProfiles(spec.vendor, spec.transport);
  if (profiles.length === 0) return undefined;
  const roleNeedle = (role ?? "").trim().toLowerCase();
  return profiles.find((profile) => profile.roleHints?.some((hint) => hint === roleNeedle))
    ?? profiles.find((profile) => profile.recommended)
    ?? profiles[0];
}

function defaultAuthFor(vendor: ProviderVendor, transport: ProviderTransport): ProviderAuthConfig {
  if (transport === "cli") return { kind: "cli" };
  if (transport === "api") return { kind: "api_key", secretRef: defaultApiKeyRef(vendor) };
  return { kind: "none" };
}

function normalizeAuthConfig(input: unknown, vendor?: string, transport?: string): ProviderAuthConfig {
  if (!input || typeof input !== "object") {
    return defaultAuthFor(normalizeCanonicalProvider(vendor), normalizeProviderTransport(transport));
  }
  const auth = input as Record<string, unknown>;
  const kind = readString(auth.kind);
  if (kind === "cli") return { kind: "cli" };
  if (kind === "none") return { kind: "none" };
  return {
    kind: "api_key",
    secretRef: readString(auth.secretRef) ?? defaultApiKeyRef(normalizeCanonicalProvider(vendor))
  };
}

function normalizeFallback(input: unknown): Omit<ProviderSpec, "fallback"> | null {
  if (!input || typeof input !== "object") return null;
  const fallback = input as Record<string, unknown>;
  return {
    vendor: normalizeCanonicalProvider(readString(fallback.vendor)),
    transport: normalizeProviderTransport(readString(fallback.transport)),
    profileId: readString(fallback.profileId) ?? undefined,
    modelOverride: readString(fallback.modelOverride) ?? undefined,
    effort: normalizeEffort(readString(fallback.effort)) ?? undefined,
    auth: normalizeAuthConfig(fallback.auth, readString(fallback.vendor) ?? undefined, readString(fallback.transport) ?? undefined)
  };
}

function inferDefaultTransport(vendor?: string): ProviderTransport {
  const normalizedVendor = normalizeCanonicalProvider(vendor);
  return PROVIDER_CAPABILITIES[normalizedVendor][0]?.transport ?? "api";
}

function roleVendorFallback(role?: string): ProviderVendor {
  return defaultProviderForRole(role).vendor;
}

function localHttpEndpointFor(vendor: ProviderVendor, env: NodeJS.ProcessEnv): string {
  if (vendor === "ollama") {
    const raw = firstNonEmptyEnv(env.ORCHESTRUM_OLLAMA_ENDPOINT, env.ORCHESTRUM_LOCAL_LLM_ENDPOINT) ?? "http://localhost:11434";
    return validateLocalHttpEndpoint(raw, "ORCHESTRUM_OLLAMA_ENDPOINT");
  }
  const raw = firstNonEmptyEnv(env.ORCHESTRUM_LLAMA_CPP_ENDPOINT, env.ORCHESTRUM_LOCAL_LLM_ENDPOINT) ?? "http://localhost:8080";
  return validateLocalHttpEndpoint(raw, "ORCHESTRUM_LLAMA_CPP_ENDPOINT");
}

function validateApiBaseUrl(
  input: string,
  vendor: "openai" | "claude",
  source: string
): string {
  const url = parseHttpUrl(input, source);
  const host = url.hostname.toLowerCase();
  const allowed = KNOWN_API_HOSTS[vendor].some((pattern) => pattern.test(host));
  if (!allowed) {
    throw new Error(`${source} host is not allowed: ${host}`);
  }
  return url.toString().replace(/\/$/, "");
}

function validateLocalHttpEndpoint(input: string, source: string): string {
  const url = parseHttpUrl(input, source);
  const host = url.hostname.toLowerCase();
  if (!isLocalHost(host)) {
    throw new Error(`${source} must target localhost/loopback. Received host: ${host}`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseHttpUrl(input: string, source: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${source} must be a valid absolute URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${source} protocol must be http or https.`);
  }
  return parsed;
}

function isLocalHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host)) return true;
  if (host.startsWith("127.")) return true;
  if (host.startsWith("::ffff:127.")) return true;
  return false;
}

function firstNonEmptyEnv(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      const normalized = value.trim();
      if (normalized.toLowerCase() === "undefined" || normalized.toLowerCase() === "null") {
        continue;
      }
      return normalized;
    }
  }
  return undefined;
}

function shouldUseNativeWrite(role?: string, executor?: NodeExecutorKind): boolean {
  const roleNeedle = (role ?? "").trim().toLowerCase();
  if (executor === "patch") return true;
  if (executor === "audit" || executor === "delivery.export" || executor === "delivery.wait") return false;
  if (roleNeedle.includes("dev")) return true;
  return false;
}

function normalizeEffort(input: string | null | undefined): ProviderEffort | null {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "max") {
    return normalized;
  }
  return null;
}

function injectDiscoveredModels(
  profiles: ProviderProfile[],
  vendor: ProviderVendor,
  transport: ProviderTransport,
  models: string[]
): ProviderProfile[] {
  if (models.length === 0) return profiles;
  const knownModels = new Set(profiles.map((profile) => profile.model));
  const nextProfiles = [...profiles];
  for (const model of models) {
    if (knownModels.has(model)) continue;
    nextProfiles.push({
      id: `${vendor}-${transport}-${sanitizeId(model)}`,
      vendor,
      transport,
      label: model,
      description: `Discovered ${PROVIDER_LABELS[vendor]} model.`,
      model
    });
  }
  return nextProfiles;
}

function extractTextFromCliOutput(stdout: string): string {
  const parsed = parseStructuredCliOutput(stdout);
  const text = extractTextValue(parsed);
  return text || stdout.trim();
}

function extractUsageFromCliOutput(stdout: string): AgentResult["usage"] | undefined {
  const parsed = parseStructuredCliOutput(stdout);
  const usage = extractUsageValue(parsed);
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens
  };
}

function parseStructuredCliOutput(stdout: string): unknown {
  const direct = parseJsonLoose(stdout);
  if (direct != null) return direct;
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsedLines = lines
    .map((line) => parseJsonLoose(line))
    .filter((line) => line != null);
  if (parsedLines.length === 1) return parsedLines[0];
  if (parsedLines.length > 1) return parsedLines;
  return stdout.trim();
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const text = extractTextValue(value[index]);
      if (text) return text;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const direct =
    readString(record.text) ??
    readString(record.result) ??
    readString(record.output) ??
    readString(record.output_text) ??
    readString(record.response) ??
    readString(record.message) ??
    readString(record.final);
  if (direct) return direct.trim();
  if (Array.isArray(record.content)) {
    const text = extractTextValue(record.content);
    if (text) return text;
  }
  if (record.message && typeof record.message === "object") {
    const text = extractTextValue(record.message);
    if (text) return text;
  }
  if (record.data && typeof record.data === "object") {
    const text = extractTextValue(record.data);
    if (text) return text;
  }
  return "";
}

function extractUsageValue(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const usage = extractUsageValue(value[index]);
      if (usage) return usage;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.usage && typeof record.usage === "object") {
    return record.usage as Record<string, number>;
  }
  if (record.metrics && typeof record.metrics === "object") {
    return record.metrics as Record<string, number>;
  }
  if (record.data && typeof record.data === "object") {
    return extractUsageValue(record.data);
  }
  return null;
}

function parseJsonLoose(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "model";
}
