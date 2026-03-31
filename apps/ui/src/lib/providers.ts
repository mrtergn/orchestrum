export type ProviderVendor = "codex" | "claude" | "cursor" | "openai" | "ollama" | "llama.cpp";
export type ProviderTransport = "cli" | "api" | "local_http";
export type ProviderEffort = "low" | "medium" | "high" | "max";

export type ProviderAuthConfig = {
  kind: "cli" | "api_key" | "none";
  secretRef?: string;
};

export type ProviderSpec = {
  vendor: ProviderVendor;
  transport: ProviderTransport;
  profileId?: string;
  modelOverride?: string;
  effort?: ProviderEffort;
  auth?: ProviderAuthConfig | null;
  fallback?: Omit<ProviderSpec, "fallback"> | null;
};

export type ProviderProfile = {
  id: string;
  vendor: ProviderVendor;
  transport: ProviderTransport;
  label: string;
  description: string;
  model: string;
  recommended?: boolean;
  roleHints?: string[];
};

export type ProviderCapabilitySummary = {
  supportsTools: boolean;
  supportsEffort: boolean;
  supportsReadOnlyMode: boolean;
  supportsJsonOutput: boolean;
  supportsModelDiscovery: boolean;
  supportsAuthProbe: boolean;
};

export type ProviderDiscoveryTransport = {
  transport: ProviderTransport;
  available: boolean;
  configured: boolean;
  reason?: string;
  binaryPath?: string;
  version?: string;
  authSource?: string | null;
  models?: string[];
  profiles: ProviderProfile[];
  capabilities: ProviderCapabilitySummary;
};

export type ProviderDiscoveryRecord = {
  vendor: ProviderVendor;
  label: string;
  transports: ProviderDiscoveryTransport[];
  preferredTransport?: ProviderTransport | null;
};

export function vendorLabel(vendor: ProviderVendor): string {
  switch (vendor) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "openai":
      return "OpenAI";
    case "ollama":
      return "Ollama";
    default:
      return "llama.cpp";
  }
}

export function transportLabel(transport: ProviderTransport): string {
  if (transport === "cli") return "CLI";
  if (transport === "api") return "API";
  return "Local HTTP";
}

export function defaultProviderForRole(role: string): ProviderSpec {
  const normalized = role.trim().toLowerCase();
  if (normalized.includes("audit")) {
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
  if (normalized.includes("dev")) {
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

export function providerSummary(provider: ProviderSpec): string {
  const model = provider.modelOverride?.trim() || provider.profileId || "default";
  return `${vendorLabel(provider.vendor)} · ${transportLabel(provider.transport)} · ${model}`;
}

export function preferredTransport(record: ProviderDiscoveryRecord): ProviderDiscoveryTransport | null {
  if (record.preferredTransport) {
    return record.transports.find((entry) => entry.transport === record.preferredTransport) ?? null;
  }
  return record.transports.find((entry) => entry.configured) ?? record.transports.find((entry) => entry.available) ?? null;
}

export function profileLabel(record: ProviderDiscoveryRecord | undefined, provider: ProviderSpec): string {
  const match = record?.transports
    .flatMap((transport) => transport.profiles)
    .find((profile) => profile.id === provider.profileId);
  return match?.label ?? provider.modelOverride ?? provider.profileId ?? "Default";
}
