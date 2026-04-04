export type ProviderVendor = "codex" | "copilot" | "claude" | "cursor" | "openai" | "ollama" | "llama.cpp";
export type ProviderTransport = "cli" | "api" | "local_http";
export type ProviderEffort = "minimal" | "low" | "medium" | "high" | "max";

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
  modelEffortSupport?: Array<{
    model: string;
    supportedEfforts: string[];
    updatedAt?: string;
    source?: string;
  }>;
  profiles: ProviderProfile[];
  capabilities: ProviderCapabilitySummary;
};

export type ProviderDiscoveryRecord = {
  vendor: ProviderVendor;
  label: string;
  transports: ProviderDiscoveryTransport[];
  preferredTransport?: ProviderTransport | null;
};

export type ProviderDiscoveryState = "connected" | "detected" | "missing";

export const PROVIDER_DISCOVERY_ORDER: ProviderVendor[] = [
  "codex",
  "copilot",
  "claude",
  "cursor",
  "openai",
  "ollama",
  "llama.cpp"
];

export function vendorLabel(vendor: ProviderVendor): string {
  switch (vendor) {
    case "codex":
      return "Codex";
    case "copilot":
      return "GitHub Copilot";
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
  if (normalized.includes("pm") || normalized.includes("plan")) {
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

export function providerDiscoveryState(transport: ProviderDiscoveryTransport | null): ProviderDiscoveryState {
  if (!transport) return "missing";
  if (transport.configured) return "connected";
  if (transport.available) return "detected";
  return "missing";
}

export function providerDiscoveryBadgeLabel(transport: ProviderDiscoveryTransport | null): string {
  const state = providerDiscoveryState(transport);
  if (state === "connected") return "Usable now";
  if (state === "detected") return "Needs setup";
  return "Not detected";
}

export function providerDiscoverySummaryLabel(transport: ProviderDiscoveryTransport | null): string {
  const state = providerDiscoveryState(transport);
  if (state === "connected") return `${transportLabel(transport?.transport ?? "cli")} connected on this machine`;
  if (state === "detected") return `${transportLabel(transport?.transport ?? "cli")} was found, but still needs sign-in or setup`;
  return "No usable local transport was detected";
}

export function providerDiscoveryExplanation(transport: ProviderDiscoveryTransport | null): string {
  const state = providerDiscoveryState(transport);
  if (state === "connected") return "Orchestrum can route work here immediately.";
  if (state === "detected") return "The tool exists, but auth or runtime setup still blocks execution.";
  return "Orchestrum could not find an installed or reachable transport for this provider.";
}

export function providerDiscoveryTransportLabel(transport: ProviderDiscoveryTransport): string {
  const state = providerDiscoveryState(transport);
  if (state === "connected") return "usable now";
  if (state === "detected") return "detected";
  return "not found";
}

export function orderProviderDiscovery(records: ProviderDiscoveryRecord[]): ProviderDiscoveryRecord[] {
  const order = new Map(PROVIDER_DISCOVERY_ORDER.map((vendor, index) => [vendor, index]));
  return [...records].sort((left, right) => {
    const leftIndex = order.get(left.vendor) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.vendor) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function hasConfiguredLocalProvider(records: ProviderDiscoveryRecord[]): boolean {
  return records.some((record) =>
    record.transports.some((transport) => transport.configured && (transport.transport === "cli" || transport.transport === "local_http"))
  );
}

export function hasAnyLocalProvider(records: ProviderDiscoveryRecord[]): boolean {
  return records.some((record) =>
    record.transports.some((transport) => transport.available && (transport.transport === "cli" || transport.transport === "local_http"))
  );
}

export function profileLabel(record: ProviderDiscoveryRecord | undefined, provider: ProviderSpec): string {
  const match = record?.transports
    .flatMap((transport) => transport.profiles)
    .find((profile) => profile.id === provider.profileId);
  return match?.label ?? provider.modelOverride ?? provider.profileId ?? "Default";
}
