import type { RunState, StepState } from "../runner/types.js";

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
