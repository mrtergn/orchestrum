import type { GovernanceProfile, RunKind, RunReadiness, RunState, StepState } from "../runner/types.js";

export const TASK_RUNTIME_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export type TaskRuntimeStatus = typeof TASK_RUNTIME_STATUSES[number];

export type AgentRuntimeState = "active" | "idle" | "sleeping" | "error";

export type WorkflowSummary = {
  name: string;
  agents: Record<string, { provider?: string; model?: string; providers?: string[]; role?: string }>;
  steps: Array<{
    id: string;
    agent?: string;
    phase?: string;
    parallel?: boolean;
    type?: string;
    substeps?: Array<{ id: string; agent?: string; phase?: string; type?: string }>;
  }>;
  loop?: {
    max_rounds?: number;
    max_loop_per_step?: number;
    audit_step_id?: string;
    fix_step_id?: string;
  };
  enable_auto_tests?: boolean;
  security?: { threshold?: number };
};

export type RunSummary = RunState & {
  repoPath?: string;
  workflow?: string;
  error?: string;
};

export type RunDetail = {
  run: RunSummary;
  steps: StepState[];
  workflow: WorkflowSummary | null;
};

export type RunProgressSnapshot = {
  run: RunSummary | null;
  steps: StepState[];
  progress: {
    done: number;
    total: number;
    percent: number;
    remaining: number;
  };
};

export type RunStartOptions = {
  sandbox?: boolean;
  concurrency?: number;
  modelOverrides?: Record<string, string>;
  strategyMode?: string;
  passphrase?: string;
};

export type BrowserRunOptions = {
  baseUrl?: string;
  targetPath?: string;
  iterations?: number;
  intervalMs?: number;
  passphrase?: string;
};

export type BrowserRunRequest = {
  workspaceId: string;
  baseUrl?: string;
  targetPath?: string;
  options?: BrowserRunOptions;
};

export type RunStartRequest = {
  workspaceId: string;
  workflowId: string;
  userGoal?: string;
  runId?: string;
  options?: RunStartOptions;
};

export type RunStartResponse = {
  ok: boolean;
  runId?: string;
  error?: string;
};

export type BrowserRunResponse = RunStartResponse & {
  kind?: Exclude<RunKind, "workflow">;
};

export type RunResumeRequest = {
  workspaceId?: string;
  fromStepId?: string;
};

export type RunResumeResponse = {
  ok: boolean;
  fromStepId?: string;
  error?: string;
};

export type RunActionResponse = {
  ok: boolean;
  error?: string;
};

export type DiagnosticsExportRequest = {
  workspaceId?: string;
  runId?: string;
  outputDir?: string;
};

export type DiagnosticsExportResponse = {
  archive?: string;
  error?: string;
};

export type DoctorSeverity = "info" | "warn" | "error";

export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  severity: DoctorSeverity;
  summary: string;
  details?: string[];
};

export type DoctorReport = {
  generatedAt: string;
  rootDir: string;
  runsDir: string;
  workspaceId?: string;
  checks: DoctorCheck[];
  summary: {
    ok: boolean;
    warnCount: number;
    errorCount: number;
  };
};

export type LearningEntry = {
  id: string;
  timestamp: string;
  category: string;
  insight: string;
  relatedFiles: string[];
  sourceRunId?: string;
  confidence: number;
};

export type LearningsResponse = {
  workspaceId?: string;
  learnings: LearningEntry[];
};

export type DocsSyncResponse = {
  ok: boolean;
  syncedAt?: string;
  summary?: string;
  updatedFiles?: string[];
  changedFiles?: string[];
  error?: string;
};

export type ReleaseReadiness = RunReadiness & {
  workspaceId?: string;
  latestRunId?: string;
  signals?: {
    pendingApprovals: number;
    governanceAlerts: number;
    docsFresh: boolean;
    qualityGateOk: boolean;
  };
};

export type WorkspaceProfileShape = {
  risk_tolerance?: string;
  max_cost_per_run?: number;
  default_strategy?: string;
  sandbox_mode?: string;
  execution_mode?: "inline" | "worktree";
  browser_base_url?: string;
  governance?: GovernanceProfile;
};

export function normalizeTaskStatus(status: string | null | undefined): TaskRuntimeStatus {
  switch ((status ?? "").trim().toLowerCase()) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "running":
    case "active":
      return "running";
    default:
      return "queued";
  }
}

export function normalizeAgentRuntimeState(state: string | null | undefined): AgentRuntimeState {
  switch ((state ?? "").trim().toLowerCase()) {
    case "running":
    case "active":
      return "active";
    case "sleeping":
      return "sleeping";
    case "error":
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export function isAgentRuntimeBusy(state: string | null | undefined): boolean {
  return normalizeAgentRuntimeState(state) === "active";
}
