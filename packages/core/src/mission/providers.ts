import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAIProvider } from "../runner/providers/openai.js";
import { OllamaProvider } from "../runner/providers/ollama.js";
import { LlamaCppProvider } from "../runner/providers/llamaCpp.js";
import { ClaudeProvider } from "../runner/providers/claude.js";
import { lookupBinary, runBinary } from "../runner/bin.js";
import { getWorkspaceProviderCapabilitiesPath } from "../runner/control.js";
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

type CliReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

type ProviderCapabilityCacheEntry = {
  vendor: ProviderVendor;
  transport: "cli";
  model: string;
  supportedEfforts: CliReasoningEffort[];
  updatedAt: string;
  source: "error_response" | "probe";
};

type ProviderCapabilityCache = {
  version: 1;
  effortSupport: ProviderCapabilityCacheEntry[];
};

const CLI_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const CLI_VENDOR_BINARIES: Partial<Record<ProviderVendor, string>> = {
  codex: "codex",
  copilot: "copilot",
  claude: "claude",
  cursor: "cursor"
};

const CLI_ENV_BINARIES: Partial<Record<ProviderVendor, string>> = {
  codex: "ORCHESTRUM_CODEX_BIN",
  copilot: "ORCHESTRUM_COPILOT_BIN",
  claude: "ORCHESTRUM_CLAUDE_BIN",
  cursor: "ORCHESTRUM_CURSOR_BIN"
};

const PROVIDER_CAPABILITIES: Record<ProviderVendor, SupportedTransport[]> = {
  codex: [{
    transport: "cli",
    capabilities: {
      supportsTools: true,
      supportsEffort: true,
      supportsReadOnlyMode: true,
      supportsJsonOutput: true,
      supportsModelDiscovery: false,
      supportsAuthProbe: true
    }
  }],
  copilot: [{
    transport: "cli",
    capabilities: {
      supportsTools: true,
      supportsEffort: true,
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
      supportsModelDiscovery: true,
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
      supportsModelDiscovery: true,
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
      supportsModelDiscovery: true,
      supportsAuthProbe: false
    }
  }]
};

const PROVIDER_LABELS: Record<ProviderVendor, string> = {
  codex: "Codex",
  copilot: "GitHub Copilot",
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
const COPILOT_GITHUB_AUTH_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const COPILOT_BYOK_AUTH_ENV_KEYS = ["COPILOT_PROVIDER_BEARER_TOKEN", "COPILOT_PROVIDER_API_KEY"] as const;
const COPILOT_READ_ONLY_TOOLS = "view,glob,rg";
const COPILOT_WRITE_TOOLS = "view,glob,rg,edit,create,bash,read_bash,write_bash,stop_bash,list_bash";

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
    id: "copilot-cli-gpt54",
    vendor: "copilot",
    transport: "cli",
    label: "GPT-5.4",
    description: "General-purpose Copilot CLI profile for implementation work.",
    model: "gpt-5.4",
    recommended: true,
    roleHints: ["dev"]
  },
  {
    id: "copilot-cli-gpt54-mini",
    vendor: "copilot",
    transport: "cli",
    label: "GPT-5.4 Mini",
    description: "Lighter Copilot CLI profile for general-purpose tasks.",
    model: "gpt-5.4-mini",
    roleHints: ["general", "custom"]
  },
  {
    id: "copilot-cli-gpt53-codex",
    vendor: "copilot",
    transport: "cli",
    label: "GPT-5.3 Codex",
    description: "Code-heavy Copilot CLI profile tuned for patch work.",
    model: "gpt-5.3-codex",
    roleHints: ["dev"]
  },
  {
    id: "copilot-cli-sonnet46",
    vendor: "copilot",
    transport: "cli",
    label: "Claude Sonnet 4.6",
    description: "Copilot CLI profile optimized for planning and reviews.",
    model: "claude-sonnet-4.6",
    roleHints: ["pm", "audit"]
  },
  {
    id: "copilot-cli-opus46",
    vendor: "copilot",
    transport: "cli",
    label: "Claude Opus 4.6",
    description: "Higher-depth Copilot CLI profile for complex review work.",
    model: "claude-opus-4.6",
    roleHints: ["pm", "audit"]
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

function emptyProviderCapabilityCache(): ProviderCapabilityCache {
  return {
    version: 1,
    effortSupport: []
  };
}

export function normalizeCanonicalProvider(input: string | null | undefined): CanonicalProvider {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "codex") return "codex";
  if (normalized === "copilot") return "copilot";
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
      vendor: "copilot",
      transport: "cli",
      profileId: "copilot-cli-gpt54",
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
    vendor: "copilot",
    transport: "cli",
    profileId: "copilot-cli-gpt54-mini",
    auth: { kind: "cli" },
    fallback: {
      vendor: "codex",
      transport: "cli",
      profileId: "codex-cli-balanced",
      auth: { kind: "cli" }
    }
  };
}

export function normalizeMissionProvider(input: unknown, role?: string): ProviderSpec {
  if (!input || typeof input !== "object") return defaultProviderForRole(role);
  const provider = input as Record<string, unknown>;

  if (typeof provider.vendor === "string" || typeof provider.transport === "string") {
    return repairNormalizedProviderSpec({
      vendor: normalizeCanonicalProvider(readString(provider.vendor) ?? roleVendorFallback(role)),
      transport: normalizeProviderTransport(readString(provider.transport) ?? inferDefaultTransport(readString(provider.vendor) ?? undefined)),
      profileId: readString(provider.profileId) ?? undefined,
      modelOverride: normalizeProviderModelOverride(
        normalizeCanonicalProvider(readString(provider.vendor) ?? roleVendorFallback(role)),
        normalizeProviderTransport(readString(provider.transport) ?? inferDefaultTransport(readString(provider.vendor) ?? undefined)),
        readString(provider.modelOverride) ?? undefined
      ),
      effort: normalizeEffort(readString(provider.effort)) ?? undefined,
      auth: normalizeAuthConfig(provider.auth, readString(provider.vendor) ?? undefined, readString(provider.transport) ?? undefined),
      fallback: normalizeFallback(provider.fallback)
    }, role);
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
  apiKeys?: Partial<Record<"openai" | "claude", string>>;
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
        return discoverApiTransport(vendor, capabilities, env, options.apiSecrets, options.apiKeys);
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
  const normalized = normalizeMissionProvider(spec, options.role);
  const discovery = await discoverMissionProviders({
    cwd: options.repoPath,
    env,
    apiSecrets: options.apiSecrets
  });
  const candidates = buildProviderExecutionCandidates(normalized, options.role);
  const attemptedExecutions = new Set<string>();
  const executionErrors: string[] = [];
  let resolvedAnyCandidate = false;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const resolved = await resolveProviderExecutionCandidate(candidate, discovery, options.role, options.executor);
    if (!resolved) continue;
    resolvedAnyCandidate = true;
    const attemptKey = resolvedProviderAttemptKey(resolved);
    if (attemptedExecutions.has(attemptKey)) continue;
    attemptedExecutions.add(attemptKey);
    try {
      const timeoutMs = resolveExecutionTimeoutMs({
        requestedTimeoutMs: options.timeoutMs,
        executor: options.executor,
        resolved,
        hasFallbackRemaining: index < candidates.length - 1
      });
      return await executeResolvedProvider(resolved, prompt, env, { ...options, timeoutMs });
    } catch (error) {
      executionErrors.push(formatProviderExecutionError(resolved, error));
    }
  }

  if (!resolvedAnyCandidate) {
    throw await buildProviderUnavailableError(normalized, discovery);
  }

  if (executionErrors.length === 1) {
    throw new Error(executionErrors[0]);
  }

  if (executionErrors.length > 1) {
    throw new Error(executionErrors.join(" Fallbacks exhausted. "));
  }

  throw await buildProviderUnavailableError(normalized, discovery);
}

async function executeResolvedProvider(
  resolved: ResolvedProviderExecution,
  prompt: string,
  env: NodeJS.ProcessEnv,
  options: ProviderExecutionOptions = {}
): Promise<ProviderExecutionResult> {
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

function buildProviderExecutionCandidates(
  spec: ProviderSpec,
  role?: string
): Array<Omit<ProviderSpec, "fallback">> {
  const candidates: Array<Omit<ProviderSpec, "fallback">> = [];
  const seen = new Set<string>();
  const appendCandidate = (input: ProviderSpec | null | undefined) => {
    if (!input) return;
    const repaired = repairNormalizedProviderSpec(input, role);
    const key = providerSpecCandidateKey(repaired);
    if (!seen.has(key)) {
      seen.add(key);
      const { fallback: _fallback, ...candidate } = repaired;
      candidates.push(candidate);
    }
    if (repaired.fallback) {
      appendCandidate({ ...repaired.fallback, fallback: null });
    }
  };

  appendCandidate(spec);
  const roleDefault = defaultProviderForRole(role);
  appendCandidate(roleDefault);
  return candidates;
}

function providerSpecCandidateKey(spec: ProviderSpec): string {
  return [
    spec.vendor,
    spec.transport,
    spec.profileId ?? "",
    spec.modelOverride ?? "",
    spec.effort ?? "",
    spec.auth?.kind ?? "",
    spec.auth?.secretRef ?? ""
  ].join("|");
}

function resolvedProviderAttemptKey(spec: ResolvedProviderExecution): string {
  return [
    spec.vendor,
    spec.transport,
    spec.profileId ?? "",
    spec.model,
    spec.effort ?? "",
    spec.binaryPath ?? "",
    spec.authSource ?? ""
  ].join("|");
}

async function resolveProviderExecutionCandidate(
  spec: Omit<ProviderSpec, "fallback">,
  discovery: ProviderDiscoveryRecord[],
  role?: string,
  executor?: NodeExecutorKind
): Promise<ResolvedProviderExecution | null> {
  const direct = await resolveCandidate(spec, discovery, role, executor);
  if (direct) return direct;

  const providerRecord = discovery.find((entry) => entry.vendor === spec.vendor);
  const preferredTransport = providerRecord?.preferredTransport;
  if (preferredTransport && preferredTransport !== spec.transport) {
    return resolveCandidate(
      repairNormalizedProviderSpec({
        ...spec,
        transport: preferredTransport,
        auth: defaultAuthFor(spec.vendor, preferredTransport),
        fallback: null
      }, role),
      discovery,
      role,
      executor
    );
  }

  return null;
}

async function buildProviderUnavailableError(
  spec: ProviderSpec,
  discovery: ProviderDiscoveryRecord[]
): Promise<Error> {
  const transportSummary = discovery.find((entry) => entry.vendor === spec.vendor)?.transports ?? [];
  const details = transportSummary.map((entry) => `${entry.transport}:${entry.reason ?? (entry.configured ? "ready" : "unavailable")}`).join(", ");
  return new Error(`Provider ${spec.vendor}/${spec.transport} is not available. ${details || "No compatible transport found."}`);
}

function resolveExecutionTimeoutMs(options: {
  requestedTimeoutMs?: number;
  executor?: NodeExecutorKind;
  resolved: ResolvedProviderExecution;
  hasFallbackRemaining: boolean;
}): number | undefined {
  if (typeof options.requestedTimeoutMs === "number" && options.requestedTimeoutMs > 0) {
    return options.requestedTimeoutMs;
  }
  if (!options.hasFallbackRemaining) return undefined;
  if (options.executor === "audit" && options.resolved.transport === "cli" && options.resolved.vendor === "codex") {
    return 90_000;
  }
  if (options.executor === "audit" && options.resolved.transport === "cli") {
    return 180_000;
  }
  return undefined;
}

function formatProviderExecutionError(
  resolved: ResolvedProviderExecution,
  error: unknown
): string {
  const detail = error instanceof Error ? error.message.trim() : String(error);
  return `${formatProviderLabel(resolved)} failed: ${detail}`;
}

function formatProviderLabel(resolved: ResolvedProviderExecution): string {
  return `${PROVIDER_LABELS[resolved.vendor]} ${resolved.transport}${resolved.model ? ` (${resolved.model})` : ""}`;
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
  if (!transportRecord?.available || !canExecuteTransport(vendor, transportRecord)) return null;
  const repairedSpec = repairProviderSpecForTransport(spec, transportRecord, role);

  const profile =
    vendor === "copilot" && !repairedSpec.profileId && !repairedSpec.modelOverride?.trim()
      ? undefined
      : resolveProfile(repairedSpec, role);
  const model = repairedSpec.modelOverride?.trim() || profile?.model || "";
  if (!model && vendor !== "copilot") {
    throw new Error(`Provider ${vendor}/${transport} requires a model or profile.`);
  }

  return {
    vendor,
    transport,
    profileId: repairedSpec.profileId ?? profile?.id,
    model,
    effort: transportRecord.capabilities.supportsEffort ? repairedSpec.effort : undefined,
    auth: repairedSpec.auth ?? defaultAuthFor(vendor, transport),
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
  const binaryPath = spec.binaryPath;

  const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const artifactDir = options.artifactDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-cli-"));

  if (spec.vendor === "codex") {
    const cachedSupportedEfforts = await loadCachedSupportedCliEfforts(repoPath, spec.vendor, spec.model);
    let reasoningEffort = selectPreferredCliEffort(
      resolveCodexReasoningEffort(spec.effort),
      cachedSupportedEfforts
    );
    const outputPath = path.join(artifactDir, "codex-last-message.txt");
    const runCodexWithEffort = async (effort: CliReasoningEffort) => {
      const args = [
        "exec",
        "--json",
        "-C",
        repoPath,
        "--skip-git-repo-check",
        "-m",
        spec.model,
        "-c",
        `model_reasoning_effort="${effort}"`,
        "-c",
        `reasoning.effort="${effort}"`,
        "-o",
        outputPath
      ];
      if (spec.nativeWrite) args.push("--full-auto");
      else args.push("--sandbox", "read-only");
      args.push("-");
      return runBinary(binaryPath, args, {
        cwd: repoPath,
        env,
        stdin: prompt,
        timeoutMs,
        allowNonZeroExit: true
      });
    };

    let result = await runCodexWithEffort(reasoningEffort);
    if (result.exitCode !== 0) {
      const supportedEfforts = parseSupportedCliReasoningEfforts(result.stdout, result.stderr);
      if (supportedEfforts.length > 0) {
        await persistSupportedCliEfforts(repoPath, spec.vendor, spec.model, supportedEfforts, "error_response");
        const fallbackEffort = selectCliFallbackEffort(reasoningEffort, supportedEfforts);
        if (fallbackEffort && fallbackEffort !== reasoningEffort) {
          reasoningEffort = fallbackEffort;
          result = await runCodexWithEffort(reasoningEffort);
        }
      }
    }
    if (result.exitCode !== 0) {
      throw new Error(extractCliError(result.stdout, result.stderr) || `Codex exited with code ${result.exitCode}.`);
    }
    const output = await fs.readFile(outputPath, "utf8").catch(() => "");
    return {
      text: output.trim() || extractTextFromCliOutput(result.stdout),
      usage: extractUsageFromCliOutput(result.stdout),
      vendor: spec.vendor,
      transport: spec.transport,
      profileId: spec.profileId,
      model: spec.model,
      effort: toProviderEffort(reasoningEffort),
      authSource: spec.authSource ?? "cli_session",
      exitCode: result.exitCode,
      binaryPath: spec.binaryPath,
      nativeWrite: spec.nativeWrite
    };
  }

  if (spec.vendor === "copilot") {
    const runCopilotWithEffort = async (reasoningEffort?: ReturnType<typeof mapCopilotEffort>) => {
      const args = [
        "--output-format",
        "json",
        "--no-ask-user",
        "--allow-all-tools",
        "--add-dir",
        repoPath,
        "--available-tools",
        spec.nativeWrite ? COPILOT_WRITE_TOOLS : COPILOT_READ_ONLY_TOOLS
      ];
      if (spec.model) {
        args.push("--model", spec.model);
      }
      if (reasoningEffort) {
        args.push("--reasoning-effort", reasoningEffort);
      }
      args.push("-p", prompt);
      return runBinary(binaryPath, args, {
        cwd: repoPath,
        env,
        timeoutMs,
        allowNonZeroExit: true
      });
    };
    const requestedEffort = spec.effort ? mapCopilotEffort(spec.effort) : undefined;
    const cachedSupportedEfforts = requestedEffort
      ? await loadCachedSupportedCliEfforts(repoPath, spec.vendor, spec.model)
      : null;
    let effectiveEffort = requestedEffort
      ? selectPreferredCliEffort(requestedEffort, cachedSupportedEfforts)
      : undefined;
    let result = await runCopilotWithEffort(effectiveEffort);
    if (result.exitCode !== 0 && effectiveEffort) {
      const supportedEfforts = parseSupportedCliReasoningEfforts(result.stdout, result.stderr);
      if (supportedEfforts.length > 0) {
        await persistSupportedCliEfforts(repoPath, spec.vendor, spec.model, supportedEfforts, "error_response");
      }
      const fallbackEffort = selectCliFallbackEffort(effectiveEffort, supportedEfforts);
      if (fallbackEffort && fallbackEffort !== effectiveEffort) {
        result = await runCopilotWithEffort(fallbackEffort);
        effectiveEffort = fallbackEffort;
      }
    }
    if (result.exitCode !== 0) {
      throw new Error(extractCliError(result.stdout, result.stderr) || `GitHub Copilot CLI exited with code ${result.exitCode}.`);
    }
    return {
      text: extractTextFromCliOutput(result.stdout),
      usage: extractUsageFromCliOutput(result.stdout),
      vendor: spec.vendor,
      transport: spec.transport,
      profileId: spec.profileId,
      model: spec.model,
      effort: effectiveEffort ? unmapCopilotEffort(effectiveEffort) : spec.effort,
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
      throw new Error(extractCliError(result.stdout, result.stderr) || `Claude CLI exited with code ${result.exitCode}.`);
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
    throw new Error(extractCliError(result.stdout, result.stderr) || `Cursor Agent exited with code ${result.exitCode}.`);
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
  const modelEffortSupport = capabilities.supportsEffort && cwd
    ? await loadCachedModelEffortSupport(cwd, vendor)
    : [];

  return {
    transport: "cli",
    available: true,
    configured: authProbe.ok,
    reason: authProbe.ok ? undefined : authProbe.reason,
    binaryPath,
    version,
    authSource: authProbe.authSource ?? (authProbe.ok ? "cli_session" : null),
    models: models.length > 0 ? models : undefined,
    modelEffortSupport: modelEffortSupport.length > 0 ? modelEffortSupport : undefined,
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
  apiSecrets?: Partial<Record<"openai" | "claude", boolean>>,
  apiKeys?: Partial<Record<"openai" | "claude", string>>
): Promise<ProviderDiscoveryTransport> {
  const secretName = defaultApiKeyRef(vendor);
  const configured = Boolean(secretName && ((apiSecrets && apiSecrets[vendor as "openai" | "claude"]) || env[secretName]));
  const apiKey = vendor === "openai" || vendor === "claude" ? apiKeys?.[vendor] : undefined;
  const models =
    configured && capabilities.supportsModelDiscovery && typeof apiKey === "string" && apiKey.trim().length > 0
      ? await probeApiModels(vendor, apiKey, env)
      : [];
  return {
    transport: "api",
    available: true,
    configured,
    reason: configured ? undefined : `${secretName ?? "API key"} is not configured.`,
    authSource: configured ? `api_key:${secretName}` : null,
    models: models.length > 0 ? models : undefined,
    profiles: models.length > 0
      ? injectDiscoveredModels(listProviderProfiles(vendor, "api"), vendor, "api", models)
      : listProviderProfiles(vendor, "api"),
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
  const models = configured && capabilities.supportsModelDiscovery
    ? await probeLocalHttpModels(vendor, endpoint)
    : [];
  return {
    transport: "local_http",
    available: configured,
    configured,
    reason: configured ? undefined : `${endpoint} is not responding.`,
    authSource: configured ? `local_http:${endpoint}` : null,
    models: models.length > 0 ? models : undefined,
    profiles: models.length > 0
      ? injectDiscoveredModels(listProviderProfiles(vendor, "local_http"), vendor, "local_http", models)
      : listProviderProfiles(vendor, "local_http"),
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
  const args = vendor === "codex" || vendor === "copilot" ? ["--version"] : ["-v"];
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
): Promise<{ ok: boolean; reason?: string; authSource?: string | null }> {
  if (vendor === "copilot") {
    return detectCopilotCliAuth(env);
  }
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
    if (authenticated === true || loggedIn === true || authStatus === "authenticated") {
      return { ok: true, authSource: "cli_session" };
    }
    return { ok: false, reason: "Claude CLI is installed but not authenticated." };
  }
  if (result.exitCode === 0 && !/(not logged|not authenticated|logged out|unauthenticated)/.test(text)) {
    return { ok: true, authSource: "cli_session" };
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
  return sanitizeDiscoveredModels(
    result.stdout
      .split(/\r?\n/)
      .map((line) => normalizeDiscoveredModelId(line))
      .filter((line): line is string => Boolean(line))
  );
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

async function probeApiModels(
  vendor: ProviderVendor,
  apiKey: string,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  if (vendor !== "openai") return [];
  const configuredBaseUrl = firstNonEmptyEnv(env.OPENAI_API_BASE_URL, env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1";
  const baseUrl = validateApiBaseUrl(
    configuredBaseUrl,
    "openai",
    firstNonEmptyEnv(env.OPENAI_API_BASE_URL) ? "OPENAI_API_BASE_URL" : firstNonEmptyEnv(env.OPENAI_BASE_URL) ? "OPENAI_BASE_URL" : "default"
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) return [];
    const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    return sanitizeDiscoveredModels((payload.data ?? []).map((entry) => readString(entry.id) ?? ""));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function probeLocalHttpModels(vendor: ProviderVendor, endpoint: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    if (vendor === "ollama") {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, { signal: controller.signal });
      if (!response.ok) return [];
      const payload = (await response.json().catch(() => ({}))) as { models?: Array<{ name?: string }> };
      return sanitizeDiscoveredModels((payload.models ?? []).map((entry) => readString(entry.name) ?? ""));
    }
    if (vendor === "llama.cpp") {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/models`, { signal: controller.signal });
      if (!response.ok) return [];
      const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
      return sanitizeDiscoveredModels((payload.data ?? []).map((entry) => readString(entry.id) ?? ""));
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function canExecuteTransport(vendor: ProviderVendor, transport: ProviderDiscoveryTransport): boolean {
  if (!transport.available) return false;
  if (transport.configured) return true;
  return vendor === "copilot" && transport.transport === "cli";
}

function detectCopilotCliAuth(env: NodeJS.ProcessEnv): { ok: boolean; reason?: string; authSource?: string | null } {
  for (const key of COPILOT_GITHUB_AUTH_ENV_KEYS) {
    if (firstNonEmptyEnv(env[key])) {
      return { ok: true, authSource: `env:${key}` };
    }
  }
  if (firstNonEmptyEnv(env.COPILOT_PROVIDER_BASE_URL)) {
    const authKey = COPILOT_BYOK_AUTH_ENV_KEYS.find((key) => Boolean(firstNonEmptyEnv(env[key])));
    return {
      ok: true,
      authSource: authKey ? `env:${authKey}` : "env:COPILOT_PROVIDER_BASE_URL"
    };
  }
  return {
    ok: false,
    reason: "Copilot CLI was found, but discovery only treats env-based auth or BYOK as connected. Interactive login is verified at first run."
  };
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
  const vendor = normalizeCanonicalProvider(readString(fallback.vendor));
  const transport = normalizeProviderTransport(readString(fallback.transport));
  return repairNormalizedProviderSpec({
    vendor,
    transport,
    profileId: readString(fallback.profileId) ?? undefined,
    modelOverride: normalizeProviderModelOverride(vendor, transport, readString(fallback.modelOverride) ?? undefined),
    effort: normalizeEffort(readString(fallback.effort)) ?? undefined,
    auth: normalizeAuthConfig(fallback.auth, readString(fallback.vendor) ?? undefined, readString(fallback.transport) ?? undefined)
  });
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
  if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "max") {
    return normalized;
  }
  return null;
}

function mapCopilotEffort(effort: ProviderEffort): CliReasoningEffort {
  if (effort === "max") return "xhigh";
  return effort;
}

function unmapCopilotEffort(effort: CliReasoningEffort): ProviderEffort {
  if (effort === "xhigh") return "max";
  return effort;
}

function selectCliFallbackEffort(
  requested: CliReasoningEffort,
  supported: CliReasoningEffort[]
): CliReasoningEffort | null {
  if (supported.length === 0 || supported.includes(requested)) return null;
  const fallbackPriority: CliReasoningEffort[] =
    requested === "xhigh"
      ? ["high", "medium", "low", "minimal"]
      : requested === "high"
        ? ["medium", "low", "minimal", "xhigh"]
        : requested === "medium"
          ? ["high", "low", "minimal", "xhigh"]
          : requested === "low"
            ? ["minimal", "medium", "high", "xhigh"]
            : ["low", "medium", "high", "xhigh"];
  return fallbackPriority.find((effort) => supported.includes(effort)) ?? null;
}

function selectPreferredCliEffort(
  requested: CliReasoningEffort,
  supported: CliReasoningEffort[] | null
): CliReasoningEffort {
  if (!supported?.length || supported.includes(requested)) return requested;
  return selectCliFallbackEffort(requested, supported) ?? requested;
}

function parseSupportedCliReasoningEfforts(stdout: string, stderr: string): CliReasoningEffort[] {
  const text = `${stdout}\n${stderr}`;
  const supportedText = text.match(/Supported values are:?\s*([\s\S]*?)(?:\.(?:\s|$)|\n|$)/i)?.[1] ?? "";
  const matches = Array.from(
    supportedText.matchAll(/'((?:minimal|low|medium|high|xhigh))'/gi)
  ).map((entry) => entry[1]?.toLowerCase() ?? "");
  return Array.from(
    new Set(
      matches
        .map((value) => normalizeCliReasoningEffort(value))
        .filter((value): value is CliReasoningEffort => Boolean(value))
    )
  );
}

function normalizeCliReasoningEffort(input: string | null | undefined): CliReasoningEffort | null {
  const normalized = (input ?? "").trim().toLowerCase();
  return CLI_REASONING_EFFORTS.includes(normalized as CliReasoningEffort)
    ? normalized as CliReasoningEffort
    : null;
}

function sanitizeDiscoveredModels(models: string[]): string[] {
  return Array.from(
    new Set(
      models
        .map((model) => normalizeDiscoveredModelId(model))
        .filter((model): model is string => Boolean(model))
    )
  ).sort((left, right) => left.localeCompare(right));
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

function extractCliError(stdout: string, stderr: string): string {
  const structured = parseStructuredCliOutput(stdout);
  const structuredMessage = extractErrorValue(structured);
  return structuredMessage || stderr.trim() || stdout.trim();
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

function repairNormalizedProviderSpec(spec: ProviderSpec, role?: string): ProviderSpec {
  const profiles = listProviderProfiles(spec.vendor, spec.transport);
  const validProfile = spec.profileId && profiles.some((profile) => profile.id === spec.profileId)
    ? spec.profileId
    : undefined;
  const normalizedModel = normalizeProviderModelOverride(spec.vendor, spec.transport, spec.modelOverride);
  const derivedProfile = !validProfile && normalizedModel
    ? profiles.find((profile) => profile.model === normalizedModel)?.id
    : undefined;
  return {
    ...spec,
    profileId: validProfile ?? derivedProfile ?? undefined,
    modelOverride: normalizedModel,
    effort: normalizeProviderEffort(spec.vendor, spec.effort),
    fallback: spec.fallback ? repairNormalizedProviderSpec({ ...spec.fallback, fallback: null }, role) : null
  };
}

function repairProviderSpecForTransport(
  spec: Omit<ProviderSpec, "fallback">,
  transport: ProviderDiscoveryTransport,
  role?: string
): Omit<ProviderSpec, "fallback"> {
  const profiles = transport.profiles;
  const explicitSelection = Boolean(spec.profileId || spec.modelOverride);
  const normalizedModel = normalizeProviderModelOverride(spec.vendor, spec.transport, spec.modelOverride);
  const validProfile = spec.profileId && profiles.some((profile) => profile.id === spec.profileId)
    ? spec.profileId
    : undefined;
  const profileFromModel = !validProfile && normalizedModel
    ? profiles.find((profile) => profile.model === normalizedModel)?.id
    : undefined;
  const allowedModels = new Set(
    [...profiles.map((profile) => profile.model), ...(transport.models ?? [])]
      .map((model) => normalizeProviderModelOverride(spec.vendor, spec.transport, model))
      .filter((model): model is string => Boolean(model))
  );
  const allowCustomModel =
    spec.vendor === "openai"
    || spec.transport === "local_http";
  let nextModel = normalizedModel;
  if (!allowCustomModel && nextModel && allowedModels.size > 0 && !allowedModels.has(nextModel)) {
    nextModel = undefined;
  }
  let nextProfileId = validProfile ?? profileFromModel ?? undefined;
  if (explicitSelection && !nextProfileId && !nextModel) {
    const roleDefault = defaultProviderForRole(role);
    if (roleDefault.vendor === spec.vendor && roleDefault.transport === spec.transport && roleDefault.profileId) {
      nextProfileId = roleDefault.profileId;
    } else {
      nextProfileId = profiles.find((profile) => profile.recommended)?.id ?? profiles[0]?.id;
    }
  }
  return {
    ...spec,
    profileId: nextProfileId,
    modelOverride: nextModel,
    effort: transport.capabilities.supportsEffort ? normalizeProviderEffort(spec.vendor, spec.effort) : undefined
  };
}

function normalizeProviderEffort(_vendor: ProviderVendor, effort: ProviderEffort | undefined): ProviderEffort | undefined {
  if (!effort) return undefined;
  return effort;
}

function resolveCodexReasoningEffort(effort: ProviderEffort | undefined): CliReasoningEffort {
  if (!effort) return "medium";
  if (effort === "max") return "xhigh";
  return effort;
}

function toProviderEffort(effort: CliReasoningEffort | undefined): ProviderEffort | undefined {
  if (!effort) return undefined;
  if (effort === "xhigh") return "max";
  return effort;
}

async function loadCachedModelEffortSupport(repoPath: string, vendor: ProviderVendor): Promise<Array<{
  model: string;
  supportedEfforts: string[];
  updatedAt?: string;
  source?: string;
}>> {
  const cache = await loadProviderCapabilityCache(repoPath);
  return cache.effortSupport
    .filter((entry) => entry.vendor === vendor && entry.transport === "cli")
    .map((entry) => ({
      model: entry.model,
      supportedEfforts: entry.supportedEfforts,
      updatedAt: entry.updatedAt,
      source: entry.source
    }))
    .sort((left, right) => left.model.localeCompare(right.model));
}

async function loadCachedSupportedCliEfforts(
  repoPath: string | undefined,
  vendor: ProviderVendor,
  model: string
): Promise<CliReasoningEffort[] | null> {
  if (!repoPath) return null;
  const normalizedModel = normalizeDiscoveredModelId(model) ?? model.trim();
  if (!normalizedModel) return null;
  const cache = await loadProviderCapabilityCache(repoPath);
  const match = cache.effortSupport.find((entry) =>
    entry.vendor === vendor
    && entry.transport === "cli"
    && entry.model === normalizedModel
  );
  return match?.supportedEfforts?.length ? match.supportedEfforts : null;
}

async function persistSupportedCliEfforts(
  repoPath: string | undefined,
  vendor: ProviderVendor,
  model: string,
  supportedEfforts: CliReasoningEffort[],
  source: ProviderCapabilityCacheEntry["source"]
): Promise<void> {
  if (!repoPath) return;
  const normalizedModel = normalizeDiscoveredModelId(model) ?? model.trim();
  const normalizedEfforts = Array.from(new Set(
    supportedEfforts
      .map((value) => normalizeCliReasoningEffort(value))
      .filter((value): value is CliReasoningEffort => Boolean(value))
  ));
  if (!normalizedModel || normalizedEfforts.length === 0) return;

  const cache = await loadProviderCapabilityCache(repoPath);
  const nextEntry: ProviderCapabilityCacheEntry = {
    vendor,
    transport: "cli",
    model: normalizedModel,
    supportedEfforts: normalizedEfforts,
    updatedAt: new Date().toISOString(),
    source
  };
  const nextEntries = cache.effortSupport.filter((entry) => !(
    entry.vendor === vendor
    && entry.transport === "cli"
    && entry.model === normalizedModel
  ));
  nextEntries.push(nextEntry);

  const nextCache: ProviderCapabilityCache = {
    version: 1,
    effortSupport: nextEntries.sort((left, right) => {
      if (left.vendor !== right.vendor) return left.vendor.localeCompare(right.vendor);
      return left.model.localeCompare(right.model);
    })
  };

  const filePath = getWorkspaceProviderCapabilitiesPath(repoPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(nextCache, null, 2), "utf8");
}

async function loadProviderCapabilityCache(repoPath: string): Promise<ProviderCapabilityCache> {
  const filePath = getWorkspaceProviderCapabilitiesPath(repoPath);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object") return emptyProviderCapabilityCache();
  const record = parsed as Record<string, unknown>;
  const effortSupport = Array.isArray(record.effortSupport)
    ? record.effortSupport
      .map((entry) => normalizeCapabilityCacheEntry(entry))
      .filter((entry): entry is ProviderCapabilityCacheEntry => Boolean(entry))
    : [];
  return {
    version: 1,
    effortSupport
  };
}

function normalizeCapabilityCacheEntry(input: unknown): ProviderCapabilityCacheEntry | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const vendor = readString(record.vendor);
  const transport = readString(record.transport);
  const model = normalizeDiscoveredModelId(readString(record.model) ?? "") ?? readString(record.model);
  const supportedEfforts = Array.isArray(record.supportedEfforts)
    ? record.supportedEfforts
      .map((value) => normalizeCliReasoningEffort(readString(value) ?? undefined))
      .filter((value): value is CliReasoningEffort => Boolean(value))
    : [];
  const source = readString(record.source);
  if (!vendor || !PROVIDER_LABELS[vendor as ProviderVendor] || transport !== "cli" || !model || supportedEfforts.length === 0) {
    return null;
  }
  return {
    vendor: vendor as ProviderVendor,
    transport: "cli",
    model,
    supportedEfforts,
    updatedAt: readString(record.updatedAt) ?? new Date(0).toISOString(),
    source: source === "probe" ? "probe" : "error_response"
  };
}

function normalizeProviderModelOverride(
  vendor: ProviderVendor,
  transport: ProviderTransport,
  input: string | null | undefined
): string | undefined {
  const normalized = normalizeDiscoveredModelId(input ?? "");
  if (!normalized) return undefined;
  const profiles = listProviderProfiles(vendor, transport);
  const knownModels = new Set(profiles.map((profile) => profile.model));
  const allowCustomModel = vendor === "openai" || transport === "local_http" || vendor === "cursor";
  if (!allowCustomModel && knownModels.size > 0 && !knownModels.has(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeDiscoveredModelId(input: string): string | undefined {
  const stripped = stripAnsi(input).trim().replace(/^[-*]\s*/, "");
  if (!stripped) return undefined;
  if (/^(loading models|available models|model\s+|tip:)/i.test(stripped)) return undefined;
  const candidate = stripped.includes(" - ")
    ? stripped.split(" - ", 1)[0]?.trim() ?? ""
    : stripped;
  if (!candidate) return undefined;
  if (!/^[a-z0-9][a-z0-9._:+/-]*$/i.test(candidate)) return undefined;
  return candidate;
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
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
    readString(record.content) ??
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

function extractErrorValue(value: unknown): string {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const error = extractErrorValue(value[index]);
      if (error) return error;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const direct =
    readString(record.error) ??
    readString(record.message) ??
    readString(record.summary);
  if (direct && /error|quota|failed|denied|unauthorized|auth/i.test(direct)) {
    return direct;
  }
  if (readString(record.type) === "session.error" && record.data && typeof record.data === "object") {
    const dataMessage = readString((record.data as Record<string, unknown>).message);
    if (dataMessage) return dataMessage;
  }
  if (record.data && typeof record.data === "object") {
    const error = extractErrorValue(record.data);
    if (error) return error;
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
