import type { LlmUsage } from "../runner/cost.js";
import type { ChangeState, RunState, ValidationState } from "../runner/types.js";
import type { PauseReason, RunVerdict } from "../types/status.js";

export const PROVIDER_VENDORS = ["codex", "copilot", "claude", "cursor", "openai", "ollama", "llama.cpp"] as const;
export type ProviderVendor = typeof PROVIDER_VENDORS[number];
export type CanonicalProvider = ProviderVendor;

export const PROVIDER_TRANSPORTS = ["cli", "api", "local_http"] as const;
export type ProviderTransport = typeof PROVIDER_TRANSPORTS[number];

export const PROVIDER_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type ProviderEffort = typeof PROVIDER_EFFORT_LEVELS[number];

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

export type ProviderCapabilitySummary = {
  supportsTools: boolean;
  supportsEffort: boolean;
  supportsReadOnlyMode: boolean;
  supportsJsonOutput: boolean;
  supportsModelDiscovery: boolean;
  supportsAuthProbe: boolean;
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

export type MissionAgent = {
  id: string;
  workspaceId?: string;
  name: string;
  role: string;
  tags?: string[];
  specialization?: string;
  seniority?: string;
  capacity?: {
    maxParallelWork?: number;
  };
  runtime?: {
    state?: string;
    currentTaskId?: string;
    currentTaskIds?: string[];
    activeLoad?: number;
  };
  provider: ProviderSpec;
  capabilities?: {
    shell?: boolean;
    fs?: boolean;
    network?: boolean;
  };
};

export const MISSION_TEMPLATE_CATEGORIES = [
  "bugfix",
  "implementation",
  "refactor",
  "hardening",
  "security",
  "delivery",
  "release",
  "documentation"
] as const;
export type MissionTemplateCategory = typeof MISSION_TEMPLATE_CATEGORIES[number];

export const MISSION_NODE_PHASES = ["plan", "implement", "verify", "review", "handoff"] as const;
export type MissionNodePhase = typeof MISSION_NODE_PHASES[number];

export type NodeExecutorKind = "prompt" | "patch" | "audit" | "validate" | "delivery.export" | "delivery.wait";

export type MissionInputRef =
  | "goal"
  | "repo_context"
  | "git_diff"
  | `artifact:${string}:${string}`
  | `literal:${string}`;

export type MissionNodeTemplate = {
  id: string;
  title: string;
  role: string;
  executor: NodeExecutorKind;
  phase?: MissionNodePhase;
  dependsOn?: string[];
  promptPath?: string;
  inputs?: MissionInputRef[];
  targetTool?: "chatgpt" | "claude" | "cursor" | "codex" | "copilot";
  approvalOnDiff?: boolean;
  acceptanceCriteria?: string[];
};

export type MissionTemplate = {
  id: string;
  name: string;
  description: string;
  category: MissionTemplateCategory;
  defaultGoalHint?: string;
  recommendedRoles?: string[];
  outcomes?: string[];
  nodes: MissionNodeTemplate[];
};

export type NodeArtifactRef = {
  name: string;
  path: string;
  mimeType?: string;
};

export type MissionApprovalGate = {
  token: string;
  kind: "diff" | "command" | "governance";
  reason: string;
  status: "pending" | "approved";
};

export type MissionImportFinding = {
  category: string;
  severity: string;
  title: string;
  summary: string;
};

export type MissionNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "waiting_input"
  | "awaiting_approval"
  | "cancelled";

export type MissionNode = {
  id: string;
  title: string;
  role: string;
  executor: NodeExecutorKind;
  phase?: MissionNodePhase;
  dependsOn: string[];
  status: MissionNodeStatus;
  assignedAgentId?: string;
  assignedAgentName?: string;
  providerConfig?: ProviderSpec;
  provider?: CanonicalProvider;
  transport?: ProviderTransport;
  profileId?: string;
  model?: string;
  effort?: ProviderEffort;
  authSource?: string | null;
  exitCode?: number | null;
  promptPath?: string;
  inputs?: MissionInputRef[];
  acceptanceCriteria?: string[];
  targetTool?: "chatgpt" | "claude" | "cursor" | "codex" | "copilot";
  approval?: MissionApprovalGate | null;
  artifacts: NodeArtifactRef[];
  findingCount?: number;
  start?: string;
  end?: string;
  error?: string | null;
  pauseReason?: PauseReason | null;
  change?: ChangeState | null;
  validation?: ValidationState | null;
  verdict?: RunVerdict | null;
};

export type MissionGraph = {
  templateId: string;
  name: string;
  description: string;
  category: MissionTemplateCategory;
  defaultGoalHint?: string;
  recommendedRoles?: string[];
  outcomes?: string[];
  nodes: MissionNode[];
};

export type MissionRun = RunState & {
  kind: "mission";
  missionTemplateId: string;
  graph: MissionGraph;
  repoPath: string;
};

export type NodeExecutorResult = {
  outputText?: string;
  outputJson?: unknown;
  diffText?: string | null;
  artifacts?: NodeArtifactRef[];
  waitingForInput?: boolean;
  blocked?: boolean;
  pauseReason?: PauseReason;
  findingCount?: number;
  approval?: MissionApprovalGate | null;
  provider?: CanonicalProvider;
  transport?: ProviderTransport;
  profileId?: string;
  model?: string;
  effort?: ProviderEffort;
  authSource?: string | null;
  exitCode?: number | null;
  usage?: LlmUsage | null;
  change?: ChangeState | null;
  validation?: ValidationState | null;
  verdict?: RunVerdict | null;
  failureMessage?: string | null;
};

export type MissionRunResult = {
  ok: boolean;
  runId: string;
  runDir: string;
  paused?: boolean;
  run: MissionRun;
};
