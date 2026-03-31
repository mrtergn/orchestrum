export type TaskRuntimeStatus = "queued" | "running" | "paused" | "blocked" | "succeeded" | "failed" | "cancelled";
export type AgentRuntimeState = "active" | "idle" | "sleeping" | "error";

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
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
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

export function runStatusTone(status: string | null | undefined): string {
  switch ((status ?? "").trim().toLowerCase()) {
    case "running":
      return "text-amber-300 border-amber-400/30 bg-amber-400/10";
    case "completed":
    case "finished":
      return "text-emerald-300 border-emerald-400/30 bg-emerald-400/10";
    case "paused":
      return "text-cyan-300 border-cyan-400/30 bg-cyan-400/10";
    case "blocked":
      return "text-fuchsia-300 border-fuchsia-400/30 bg-fuchsia-400/10";
    case "failed":
      return "text-rose-300 border-rose-400/30 bg-rose-400/10";
    case "cancelled":
      return "text-slate-300 border-slate-500/30 bg-slate-500/10";
    case "interrupted":
      return "text-cyan-300 border-cyan-400/30 bg-cyan-400/10";
    default:
      return "text-slate-400 border-slate-700 bg-slate-900/40";
  }
}

export function isAgentBusy(state: string | null | undefined): boolean {
  return normalizeAgentRuntimeState(state) === "active";
}
