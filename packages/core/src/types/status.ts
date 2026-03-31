export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "cached";

export type PauseReason = "awaiting_input" | "awaiting_approval";

export type ChangeStatus =
  | "none"
  | "generated"
  | "apply_pending"
  | "applied"
  | "apply_failed"
  | "validated"
  | "validation_failed"
  | "needs_review";

export type ValidationStatus = "not_requested" | "pending" | "running" | "passed" | "failed" | "unavailable";

export type RunVerdict =
  | "running"
  | "needs_human_review"
  | "ready_for_review"
  | "ready_to_merge"
  | "blocked"
  | "failed";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
