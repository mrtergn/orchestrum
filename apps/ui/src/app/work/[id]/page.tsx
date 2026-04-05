"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  RunDetail,
  WorkItemDetailResponse,
  WorkItemCyclePlan,
  WorkItemGateRuntime,
  WorkItemHandoffRuntime,
  WorkItemOptimizationSummary,
  WorkItemPlanningDetail,
  WorkItemRecoveryRuntime,
  WorkItemRecord,
  WorkItemReviewSummary,
  WorkItemTeamRuntime,
  WorkItemTeamSelectionLane,
  WorkItemTraceGroup,
  WorkItemTraceSummary,
  WorkItemWorkstreamRuntime,
  WorkPlanTask
} from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";
import {
  MetricStrip,
  NoticePanel,
  SegmentedTabs,
  SurfacePanel
} from "@/components/ui/PagePrimitives";
import { useEventSource } from "@/lib/hooks/useEventSource";
import { type RuntimeAgentRecord } from "@/lib/workRuntime";

function statusClassName(status: string) {
  switch (status) {
    case "running":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "paused":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
    case "blocked":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "ready_for_review":
    case "completed":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "failed":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function statusLabel(status: string) {
  if (status === "paused") return "Paused";
  if (status === "ready_for_review") return "Ready for review";
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function sourceLabel(sourceType: string) {
  switch (sourceType) {
    case "audit":
      return "Audit";
    case "pbi":
      return "Sprint / PBI";
    case "pr_hardening":
      return "PR Hardening";
    case "bug":
      return "Bug";
    default:
      return "Feature";
  }
}

function workItemKindLabel(workItem: WorkItemRecord) {
  if (workItem.recommendedTemplateId === "audit-only") return "Audit";
  return sourceLabel(workItem.brief.sourceType);
}

function coverageClassName(coverage: string) {
  switch (coverage) {
    case "strong":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "fallback":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    default:
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
  }
}

function coverageLabel(coverage: string) {
  if (coverage === "strong") return "Covered";
  if (coverage === "fallback") return "Fallback";
  return "Missing";
}

function reviewGateClassName(gate: string) {
  switch (gate) {
    case "approved":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "changes_requested":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "ready":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function reviewGateLabel(gate: string) {
  if (gate === "approved") return "Approved";
  if (gate === "changes_requested") return "Changes requested";
  if (gate === "ready") return "Ready";
  return "Not ready";
}

function signalClassName(status: string) {
  switch (status) {
    case "passed":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "failed":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    case "blocked":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "pending":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function signalLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function hasActiveExecution(workItem: WorkItemRecord) {
  const activeStatuses = new Set(["queued", "running", "active", "paused"]);
  const runStatus = workItem.linkedRunStatus?.trim().toLowerCase() ?? "";
  const taskStatus = workItem.linkedTaskStatus?.trim().toLowerCase() ?? "";
  return activeStatuses.has(runStatus) || activeStatuses.has(taskStatus);
}

function executionModeLabel(workItem: WorkItemRecord) {
  if (workItem.executionMode === "task_graph" || (workItem.linkedTaskIds?.length ?? 0) > 0) return "Task graph";
  if (workItem.executionMode === "mission" || workItem.linkedRunId) return "Mission run";
  return "Not started";
}

function launchActionLabel(workItem: WorkItemRecord) {
  if (workItem.reviewStatus === "changes_requested") return "Launch remediation";
  if (workItem.linkedRunId || (workItem.linkedTaskIds?.length ?? 0) > 0) return "Relaunch execution";
  return "Launch execution";
}

function cycleStatusClassName(status: string) {
  switch (status) {
    case "approved":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "changes_requested":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "review_ready":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
    case "failed":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    case "blocked":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function cycleStatusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function cyclePlanSourceClassName(source: string) {
  return source === "remediation"
    ? "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200"
    : "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
}

function cyclePlanSourceLabel(source: string) {
  return source === "remediation" ? "Remediation cycle" : "Baseline cycle";
}

function laneRuntimeClassName(status: string) {
  switch (status) {
    case "running":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "paused":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
    case "blocked":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "queued":
    case "planned":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
    case "succeeded":
    case "completed":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "missing":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    case "failed":
    case "cancelled":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function laneRuntimeLabel(status: string) {
  if (status === "missing") return "Missing coverage";
  if (status === "paused") return "Waiting review";
  if (status === "succeeded" || status === "completed") return "Completed";
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function laneBoardStatusRank(status: string) {
  if (status === "running") return 0;
  if (status === "paused") return 1;
  if (status === "blocked" || status === "failed") return 2;
  if (status === "queued" || status === "planned") return 3;
  if (status === "succeeded" || status === "completed") return 4;
  if (status === "omitted" || status === "missing") return 5;
  return 6;
}

function optimizationStatusClassName(status: string) {
  switch (status) {
    case "approved":
    case "converted":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "rejected":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    default:
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
  }
}

function gateStatusClassName(status: string) {
  switch (status) {
    case "passed":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "failed":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    case "blocked":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "pending":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function teamDecisionClassName(decision: string) {
  switch (decision) {
    case "selected":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "standby":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "missing":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function formatEstimatedCost(value: number | null | undefined) {
  if (typeof value !== "number") return "Unknown";
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function providerReadinessClassName(readiness: string | null | undefined) {
  if (readiness === "usable_now") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  if (readiness === "detected_needs_setup") return "border-amber-400/30 bg-amber-400/10 text-amber-200";
  return "border-slate-700 bg-slate-900/60 text-slate-300";
}

function providerReadinessLabel(readiness: string | null | undefined) {
  if (readiness === "usable_now") return "Usable now";
  if (readiness === "detected_needs_setup") return "Needs setup";
  return "Fallback route";
}

type WorkspaceSignalRecord = {
  ts?: string;
  workspaceId: string;
  source: "mission" | "browser" | "work" | "review" | "supervisor" | "plugin" | "execution";
  type: string;
  entityId?: string | null;
  status?: string | null;
  summary?: string | null;
  payload?: Record<string, unknown>;
};

type RunLogResponse = {
  lines?: string[];
};

type RunArtifactListResponse = {
  files?: string[];
};

type RunArtifactContentResponse = {
  content?: string;
  encoding?: string;
  mimeType?: string;
};

type LiveRunStreamPayload = {
  t?: string;
  ts?: number;
  run?: RunDetail["run"] | null;
  steps?: RunDetail["steps"];
  progress?: {
    done: number;
    total: number;
    percent: number;
    remaining: number;
  };
  stepId?: string;
  status?: string;
  summary?: string;
  error?: string;
  nodeId?: string;
};

type LiveStoryBeat = {
  id: string;
  ts: number;
  tone: "info" | "success" | "warning" | "danger";
  label: string;
  summary: string;
  meta: string[];
};

type LiveStageMove = {
  id: string;
  tone: LiveStoryBeat["tone"];
  label: string;
  summary: string;
  meta: string[];
  timeLabel: string;
};

const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "active", "paused"]);
const ATTENTION_TASK_STATUSES = new Set(["blocked", "failed", "cancelled", "canceled"]);

function taskStatusClassName(status: string) {
  if (status === "succeeded" || status === "completed") {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  }
  return statusClassName(status);
}

function formatEventTimestamp(value?: string | null) {
  if (!value) return "Now";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "Now";
  return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function eventTimestampValue(value?: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function liveEventToneClassName(event: WorkspaceSignalRecord) {
  if (event.status === "failed") return "border-rose-400/20 bg-rose-400/10";
  if (event.status === "blocked") return "border-fuchsia-400/20 bg-fuchsia-400/10";
  if (event.status === "paused") return "border-cyan-400/20 bg-cyan-400/10";
  if (event.status === "running" || event.type.endsWith(".started") || event.type === "prompt.sent") {
    return "border-amber-400/20 bg-amber-400/10";
  }
  if (event.type === "response.received" || event.type.endsWith(".completed") || event.status === "completed") {
    return "border-emerald-400/20 bg-emerald-400/10";
  }
  return "border-slate-800 bg-slate-900/40";
}

function liveEventSourceLabel(event: WorkspaceSignalRecord) {
  const type = event.type.replace(/[._]/g, " ");
  if (type === "provider prompt" || type === "prompt sent") return "Prompt";
  if (type === "provider response" || type === "response received") return "Response";
  return type.replace(/\b\w/g, (character) => character.toUpperCase());
}

function readPayloadString(payload: Record<string, unknown> | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function signalRelatesToWorkItem(
  signal: WorkspaceSignalRecord,
  options: {
    workItemId: string;
    taskIds: Set<string>;
    workstreamIds: Set<string>;
    runIds: Set<string>;
  }
) {
  if (signal.entityId === options.workItemId) return true;
  if (signal.entityId && (options.taskIds.has(signal.entityId) || options.workstreamIds.has(signal.entityId) || options.runIds.has(signal.entityId))) {
    return true;
  }
  const payload = signal.payload ?? {};
  const workItemId = readPayloadString(payload, "workItemId");
  if (workItemId === options.workItemId) return true;
  const taskId = readPayloadString(payload, "taskId");
  if (taskId && options.taskIds.has(taskId)) return true;
  const workstreamId = readPayloadString(payload, "workstreamId");
  if (workstreamId && options.workstreamIds.has(workstreamId)) return true;
  const runId = readPayloadString(payload, "runId") ?? readPayloadString(payload, "linkedRunId");
  if (runId && options.runIds.has(runId)) return true;
  const handoffTarget = readPayloadString(payload, "handoffToWorkstreamId");
  if (handoffTarget && options.workstreamIds.has(handoffTarget)) return true;
  return false;
}

function dedupeSignals(signals: WorkspaceSignalRecord[]) {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = [
      signal.type,
      signal.entityId ?? "",
      signal.ts ?? "",
      signal.summary ?? "",
      readPayloadString(signal.payload, "taskId") ?? "",
      readPayloadString(signal.payload, "workstreamId") ?? ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferRunDisplayStatus(detail: RunDetail | null) {
  const runStatus = normalizeRunLikeStatus(detail?.run?.status);
  const stepStatuses = (detail?.steps ?? []).map((step) => normalizeRunLikeStatus(step.status));
  if (runStatus && runStatus !== "running") return runStatus;
  if (stepStatuses.includes("blocked")) return "blocked";
  if (stepStatuses.includes("failed")) return "failed";
  if (stepStatuses.includes("awaiting_approval") || stepStatuses.includes("waiting_input") || stepStatuses.includes("paused")) {
    return "paused";
  }
  if (stepStatuses.length > 0 && stepStatuses.every((status) => status === "completed" || status === "succeeded")) {
    return "completed";
  }
  return runStatus || "pending";
}

function normalizeRunLikeStatus(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function rankLiveRunForFocus(status: string, needsReview: boolean) {
  const normalized = normalizeRunLikeStatus(status);
  if (normalized === "failed" || normalized === "blocked") return 0;
  if (needsReview) return 1;
  if (normalized === "paused" || normalized === "awaiting_approval" || normalized === "waiting_input") return 2;
  if (normalized === "running" || normalized === "active") return 3;
  if (normalized === "queued" || normalized === "pending") return 4;
  if (normalized === "completed" || normalized === "succeeded") return 6;
  return 5;
}

function computeRunProgress(detail: RunDetail | null) {
  const steps = detail?.steps ?? [];
  const total = steps.length;
  const done = steps.filter((step) => {
    const status = normalizeRunLikeStatus(step.status);
    return status === "completed" || status === "succeeded";
  }).length;
  return {
    total,
    done,
    percent: total > 0 ? Math.round((done / total) * 100) : 0
  };
}

function runStepSummary(step: RunDetail["steps"][number]) {
  if (step.error?.trim()) return step.error.trim();
  if (step.validation?.results?.length) {
    const failing = step.validation.results.find((result) => result.ok === false);
    if (failing?.summary) return failing.summary;
  }
  if (step.change?.applyError?.trim()) return step.change.applyError.trim();
  if (typeof step.pauseReason === "string" && step.pauseReason.trim()) {
    return step.pauseReason.replace(/_/g, " ");
  }
  return null;
}

function runStepPriority(status: string) {
  const normalized = normalizeRunLikeStatus(status);
  if (normalized === "running") return 0;
  if (normalized === "blocked" || normalized === "failed") return 1;
  if (normalized === "awaiting_approval" || normalized === "waiting_input" || normalized === "paused") return 2;
  if (normalized === "queued" || normalized === "pending") return 3;
  if (normalized === "completed" || normalized === "succeeded") return 5;
  return 4;
}

function formatRunStreamEvent(payload: LiveRunStreamPayload) {
  const timestamp = typeof payload.ts === "number"
    ? new Date(payload.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : formatEventTimestamp(null);
  const type = typeof payload.t === "string" ? payload.t.replace(/^mission\./, "").replace(/\./g, " ") : "event";
  const detail =
    payload.summary
    ?? payload.error
    ?? payload.status
    ?? payload.nodeId
    ?? payload.stepId
    ?? "";
  return `${timestamp} ${type}${detail ? ` · ${detail}` : ""}`;
}

function liveStoryToneClassName(tone: LiveStoryBeat["tone"]) {
  if (tone === "danger") return "border-rose-400/20 bg-rose-400/10";
  if (tone === "warning") return "border-fuchsia-400/20 bg-fuchsia-400/10";
  if (tone === "success") return "border-emerald-400/20 bg-emerald-400/10";
  return "border-cyan-400/20 bg-cyan-400/10";
}

function missionControlFrameClassName(mode: "active" | "warning" | "danger" | "success" | "idle") {
  switch (mode) {
    case "danger":
      return "border-rose-400/30 bg-rose-950/15";
    case "warning":
      return "border-amber-300/25 bg-amber-950/15";
    case "success":
      return "border-emerald-400/20 bg-emerald-950/15";
    case "active":
      return "border-cyan-400/20 bg-cyan-950/15";
    default:
      return "border-slate-800 bg-slate-950/70";
  }
}

function missionControlBadgeClassName(mode: "active" | "warning" | "danger" | "success" | "idle") {
  switch (mode) {
    case "danger":
      return "border-rose-400/30 bg-rose-400/10 text-rose-100";
    case "warning":
      return "border-amber-300/30 bg-amber-300/10 text-amber-100";
    case "success":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
    case "active":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-100";
    default:
      return "border-slate-700 bg-slate-900/70 text-slate-300";
  }
}

function missionControlGlowClassName(mode: "active" | "warning" | "danger" | "success" | "idle") {
  switch (mode) {
    case "danger":
      return "bg-rose-400/20";
    case "warning":
      return "bg-amber-300/20";
    case "success":
      return "bg-emerald-400/20";
    case "active":
      return "bg-cyan-400/20";
    default:
      return "bg-slate-400/10";
  }
}

function missionControlToneClassName(tone: "info" | "success" | "warning" | "danger") {
  switch (tone) {
    case "danger":
      return "border-rose-400/30 bg-rose-400/10 text-rose-100";
    case "warning":
      return "border-amber-300/30 bg-amber-300/10 text-amber-100";
    case "success":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
    default:
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-100";
  }
}

function laneOrchestraCardClassName(status: string, isCurrent: boolean) {
  if (isCurrent) {
    return "border-cyan-300/35 bg-cyan-400/10 shadow-[0_24px_80px_rgba(8,145,178,0.18)]";
  }
  if (status === "blocked" || status === "failed" || status === "cancelled") {
    return "border-rose-400/20 bg-rose-400/10";
  }
  if (status === "paused") {
    return "border-amber-300/20 bg-amber-300/10";
  }
  if (status === "succeeded" || status === "completed") {
    return "border-emerald-400/20 bg-emerald-400/10";
  }
  if (status === "queued" || status === "planned") {
    return "border-slate-700/80 bg-slate-950/70";
  }
  return "border-slate-800 bg-slate-950/70";
}

function laneOrchestraDotClassName(status: string, isCurrent: boolean) {
  if (isCurrent) return "bg-cyan-300 shadow-[0_0_0_6px_rgba(34,211,238,0.16)]";
  if (status === "blocked" || status === "failed" || status === "cancelled") return "bg-rose-300";
  if (status === "paused") return "bg-amber-300";
  if (status === "succeeded" || status === "completed") return "bg-emerald-300";
  if (status === "queued" || status === "planned") return "bg-slate-500";
  return "bg-slate-400";
}

function stepTimestampValue(step: RunDetail["steps"][number]) {
  const value = step.end ?? step.start ?? "";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function pickFocusedRunArtifact(
  files: string[],
  step: RunDetail["steps"][number] | null,
  currentArtifact: string
) {
  if (currentArtifact && files.includes(currentArtifact)) return currentArtifact;
  const preferredNames = [
    step?.change?.diffArtifact ?? "",
    "post-apply.diff",
    "git.diff",
    "pending.diff",
    "suggested_fix.diff",
    "external_patch.diff",
    "apply-error.txt",
    "conflict-summary.md",
    "recovery-guide.md",
    "validation/summary.json",
    "output.md",
    "output.json"
  ].filter(Boolean);
  for (const name of preferredNames) {
    const matched = files.find((file) => file === name || file.endsWith(`/${name}`) || file.endsWith(name));
    if (matched) return matched;
  }
  return files[0] ?? "";
}

function recoveryArtifactKey(artifact: WorkItemRecoveryRuntime["artifacts"][number]) {
  return [artifact.runId ?? "run", artifact.stepId ?? "step", artifact.path].join("::");
}

function pickRecoveryArtifact(
  artifacts: WorkItemRecoveryRuntime["artifacts"],
  currentArtifactKey: string
) {
  if (currentArtifactKey && artifacts.some((artifact) => recoveryArtifactKey(artifact) === currentArtifactKey)) {
    return currentArtifactKey;
  }
  const preferredNames = [
    "output.json",
    "output.md",
    "suggested_fix.diff",
    "conflict-summary.md",
    "recovery-guide.md",
    "git-status.txt",
    "validation/summary.json"
  ];
  for (const name of preferredNames) {
    const matched = artifacts.find((artifact) => artifact.path === name || artifact.path.endsWith(`/${name}`));
    if (matched) return recoveryArtifactKey(matched);
  }
  return artifacts[0] ? recoveryArtifactKey(artifacts[0]) : "";
}

function isAuditFindingRecovery(recovery: { kind?: string | null } | null | undefined) {
  return recovery?.kind === "audit_findings";
}

function isApprovalPauseRecovery(recovery: { kind?: string | null } | null | undefined) {
  return recovery?.kind === "approval_pause";
}

type DetailState = {
  workItem: WorkItemRecord;
  detail: WorkItemPlanningDetail;
  currentPlan: WorkItemCyclePlan | null;
  review: WorkItemReviewSummary;
  optimization: WorkItemOptimizationSummary | null;
  teamRuntime: WorkItemTeamRuntime | null;
  workstreamRuntime: WorkItemWorkstreamRuntime[];
  gateRuntime: WorkItemGateRuntime[];
  teamSelection: WorkItemTeamSelectionLane[];
  traceSummary: WorkItemTraceSummary | null;
  workstreamTrace: WorkItemTraceGroup[];
  handoffRuntime: WorkItemHandoffRuntime[];
  recovery: WorkItemRecoveryRuntime | null;
};

type RelatedTask = {
  id: string;
  title: string;
  type: string;
  status: string;
  assignedToAgentId: string;
  cycleId?: string | null;
  laneId?: string;
  laneLabel?: string;
  workstreamId?: string | null;
  workstreamType?: string | null;
  gateRefs?: string[];
  ownerAgentId?: string | null;
  ownerAgentName?: string | null;
  ownerRole?: string | null;
  dependsOnTaskIds?: string[];
  waitingOnTaskIds?: string[];
  blockedByTaskIds?: string[];
  linkedRunId?: string;
  resultSummary?: string;
};

type DetailView = "summary" | "live" | "inspect";

export default function WorkItemDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { selectedWorkspaceId, setSelectedWorkspaceId, pushToast } = useAppUi();
  const workItemId = typeof params.id === "string" ? params.id : "";
  const queryWorkspaceId = searchParams.get("workspace") ?? "";
  const workspaceId = queryWorkspaceId || selectedWorkspaceId;
  const [state, setState] = useState<DetailState | null>(null);
  const [relatedTasks, setRelatedTasks] = useState<RelatedTask[]>([]);
  const [agents, setAgents] = useState<RuntimeAgentRecord[]>([]);
  const [agentNames, setAgentNames] = useState<Map<string, string>>(new Map());
  const [reviewNote, setReviewNote] = useState("");
  const [reviewNoteDirty, setReviewNoteDirty] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [launchingExecution, setLaunchingExecution] = useState(false);
  const [recoverySubmitting, setRecoverySubmitting] = useState<string | null>(null);
  const [liveSignals, setLiveSignals] = useState<WorkspaceSignalRecord[]>([]);
  const [liveRunSnapshots, setLiveRunSnapshots] = useState<Record<string, RunDetail | null>>({});
  const [liveRunDetail, setLiveRunDetail] = useState<RunDetail | null>(null);
  const [liveRunLogs, setLiveRunLogs] = useState<string[]>([]);
  const [liveRunEvents, setLiveRunEvents] = useState<string[]>([]);
  const [liveRunArtifacts, setLiveRunArtifacts] = useState<string[]>([]);
  const [liveSelectedRunId, setLiveSelectedRunId] = useState("");
  const [liveSelectionPinned, setLiveSelectionPinned] = useState(false);
  const [liveSelectedArtifact, setLiveSelectedArtifact] = useState("");
  const [liveArtifactContent, setLiveArtifactContent] = useState("");
  const [liveArtifactMimeType, setLiveArtifactMimeType] = useState("text/plain");
  const [liveArtifactEncoding, setLiveArtifactEncoding] = useState("utf8");
  const [recoverySelectedArtifactKey, setRecoverySelectedArtifactKey] = useState("");
  const [recoveryArtifactContent, setRecoveryArtifactContent] = useState("");
  const [recoveryArtifactMimeType, setRecoveryArtifactMimeType] = useState("text/plain");
  const [recoveryArtifactEncoding, setRecoveryArtifactEncoding] = useState("utf8");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailView, setDetailView] = useState<DetailView>("live");
  const [liveApprovalSubmitting, setLiveApprovalSubmitting] = useState(false);
  const [liveResumeSubmitting, setLiveResumeSubmitting] = useState(false);
  const [liveSendBackSubmitting, setLiveSendBackSubmitting] = useState(false);

  useEffect(() => {
    if (queryWorkspaceId && queryWorkspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(queryWorkspaceId);
    }
  }, [queryWorkspaceId, selectedWorkspaceId, setSelectedWorkspaceId]);

  useEffect(() => {
    setLiveSignals([]);
    setLiveRunSnapshots({});
    setLiveSelectedRunId("");
    setLiveSelectionPinned(false);
  }, [workItemId]);

  useEffect(() => {
    if (!workItemId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
        const res = await fetch(`/api/work-items/${workItemId}/detail${query}`, { cache: "no-store" });
        const payload = (await res.json().catch(() => ({}))) as Partial<WorkItemDetailResponse> & { error?: string };
        if (!res.ok || !payload.workItem || !payload.detail || !payload.review) {
          throw new Error(payload.error ?? "Work item detail could not be loaded");
        }
        const [tasksRes, agentsRes] = await Promise.all([
          fetch(`/api/tasks?workItem=${encodeURIComponent(payload.workItem.id)}`, { cache: "no-store" }),
          fetch(`/api/agents?workspace=${encodeURIComponent(payload.workItem.workspaceId)}`, { cache: "no-store" })
        ]);
        const tasksPayload = await tasksRes.json().catch(() => ({ tasks: [] }));
        const agentsPayload = await agentsRes.json().catch(() => ({ agents: [] }));
        if (!cancelled) {
          setState({
            workItem: payload.workItem,
            detail: payload.detail,
            currentPlan: payload.currentPlan ?? null,
            review: payload.review,
            optimization: payload.optimization ?? null,
            teamRuntime: payload.teamRuntime ?? null,
            workstreamRuntime: Array.isArray(payload.workstreamRuntime) ? payload.workstreamRuntime : [],
            gateRuntime: Array.isArray(payload.gateRuntime) ? payload.gateRuntime : [],
            teamSelection: Array.isArray(payload.teamSelection) ? payload.teamSelection : [],
            traceSummary: payload.traceSummary ?? null,
            workstreamTrace: Array.isArray(payload.workstreamTrace) ? payload.workstreamTrace : [],
            handoffRuntime: Array.isArray(payload.handoffRuntime) ? payload.handoffRuntime : [],
            recovery: payload.recovery ?? null
          });
          setRelatedTasks(Array.isArray(tasksPayload.tasks) ? tasksPayload.tasks as RelatedTask[] : []);
          const loadedAgents = Array.isArray(agentsPayload.agents) ? agentsPayload.agents as RuntimeAgentRecord[] : [];
          setAgents(loadedAgents);
          setAgentNames(new Map(loadedAgents.map((agent) => [agent.id, agent.name])));
          if (!reviewNoteDirty) {
            setReviewNote(payload.review.operatorNote ?? "");
          }
        }
      } catch (error) {
        if (!cancelled) {
          pushToast({
            tone: "danger",
            title: "Planning board unavailable",
            message: error instanceof Error ? error.message : String(error)
          });
          setState(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pushToast, reviewNoteDirty, workItemId, workspaceId, refreshKey]);

  const tasksByLane = useMemo(() => {
    const map = new Map<string, WorkPlanTask[]>();
    for (const lane of state?.detail.lanes ?? []) {
      map.set(lane.id, []);
    }
    for (const task of state?.detail.tasks ?? []) {
      const bucket = map.get(task.laneId) ?? [];
      bucket.push(task);
      map.set(task.laneId, bucket);
    }
    return map;
  }, [state?.detail.lanes, state?.detail.tasks]);

  const currentPlanTasksByLane = useMemo(() => {
    const map = new Map<string, WorkPlanTask[]>();
    for (const lane of state?.currentPlan?.lanes ?? []) {
      map.set(lane.id, []);
    }
    for (const task of state?.currentPlan?.tasks ?? []) {
      const bucket = map.get(task.laneId) ?? [];
      bucket.push(task);
      map.set(task.laneId, bucket);
    }
    return map;
  }, [state?.currentPlan?.lanes, state?.currentPlan?.tasks]);

  const cycleScopedTasks = useMemo(() => {
    if (!state) return relatedTasks;
    const activeTaskIds = new Set(state.workItem.linkedTaskIds ?? []);
    if (state.workItem.currentCycleId) {
      const scoped = relatedTasks.filter((task) => task.cycleId === state.workItem.currentCycleId || activeTaskIds.has(task.id));
      if (scoped.length > 0) return scoped;
    }
    if (activeTaskIds.size > 0) {
      const scoped = relatedTasks.filter((task) => activeTaskIds.has(task.id));
      if (scoped.length > 0) return scoped;
    }
    return relatedTasks;
  }, [relatedTasks, state]);
  const sortedRelatedTasks = useMemo(
    () => cycleScopedTasks.slice().sort((left, right) => left.title.localeCompare(right.title)),
    [cycleScopedTasks]
  );
  const workstreamRuntimeById = useMemo(
    () => new Map((state?.workstreamRuntime ?? []).map((entry) => [entry.id, entry])),
    [state?.workstreamRuntime]
  );
  const gateRuntimeById = useMemo(
    () => new Map((state?.gateRuntime ?? []).map((entry) => [entry.id, entry])),
    [state?.gateRuntime]
  );
  const traceSummaryByAgentId = useMemo(
    () => new Map((state?.traceSummary?.perAgent ?? []).map((entry) => [entry.agentId, entry])),
    [state?.traceSummary]
  );
  const selectedTeam = useMemo(
    () => (state?.teamSelection ?? []).filter((entry) => entry.decision === "selected" || entry.decision === "standby"),
    [state?.teamSelection]
  );
  const omittedSpecialists = useMemo(
    () => (state?.teamSelection ?? []).filter((entry) => entry.decision === "omitted" || entry.decision === "missing"),
    [state?.teamSelection]
  );
  const relevantTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of cycleScopedTasks) ids.add(task.id);
    for (const taskId of state?.workItem.linkedTaskIds ?? []) ids.add(taskId);
    return ids;
  }, [cycleScopedTasks, state?.workItem.linkedTaskIds]);
  const relevantWorkstreamIds = useMemo(() => {
    const ids = new Set<string>();
    for (const workstream of state?.currentPlan?.workstreams ?? []) ids.add(workstream.id);
    for (const runtime of state?.workstreamRuntime ?? []) ids.add(runtime.id);
    for (const group of state?.workstreamTrace ?? []) {
      if (group.workstreamId) ids.add(group.workstreamId);
    }
    for (const handoff of state?.handoffRuntime ?? []) {
      if (handoff.fromWorkstreamId) ids.add(handoff.fromWorkstreamId);
      if (handoff.toWorkstreamId) ids.add(handoff.toWorkstreamId);
    }
    return ids;
  }, [state?.currentPlan?.workstreams, state?.handoffRuntime, state?.workstreamRuntime, state?.workstreamTrace]);
  const relevantRunIds = useMemo(() => {
    const ids = new Set<string>();
    if (state?.workItem.linkedRunId) ids.add(state.workItem.linkedRunId);
    if (state?.recovery?.runId) ids.add(state.recovery.runId);
    for (const task of cycleScopedTasks) {
      if (task.linkedRunId) ids.add(task.linkedRunId);
    }
    for (const group of state?.workstreamTrace ?? []) {
      for (const trace of group.traces) {
        if (trace.runId) ids.add(trace.runId);
      }
    }
    return ids;
  }, [cycleScopedTasks, state?.recovery?.runId, state?.workItem.linkedRunId, state?.workstreamTrace]);
  const liveEventUrl = state?.workItem.workspaceId
    ? `/api/events?workspace=${encodeURIComponent(state.workItem.workspaceId)}`
    : null;
  const handleLiveSignal = useCallback((event: MessageEvent<string>) => {
    if (!state) return;
    let parsed: WorkspaceSignalRecord | null = null;
    try {
      parsed = JSON.parse(event.data) as WorkspaceSignalRecord;
    } catch {
      parsed = null;
    }
    if (!parsed) return;
    if (parsed.workspaceId !== state.workItem.workspaceId) return;
    if (!signalRelatesToWorkItem(parsed, {
      workItemId: state.workItem.id,
      taskIds: relevantTaskIds,
      workstreamIds: relevantWorkstreamIds,
      runIds: relevantRunIds
    })) {
      return;
    }
    setLiveSignals((current) => dedupeSignals([parsed!, ...current]).slice(0, 60));
  }, [relevantRunIds, relevantTaskIds, relevantWorkstreamIds, state]);

  useEventSource(liveEventUrl, handleLiveSignal);

  const seededTimelineSignals = useMemo<WorkspaceSignalRecord[]>(() => {
    if (!state) return [];
    const fromTraceGroups = state.workstreamTrace.flatMap((group) =>
      group.traces.map((trace) => ({
        ts: trace.ts,
        workspaceId: state.workItem.workspaceId,
        source: (trace.traceType === "provider_prompt" || trace.traceType === "provider_response" ? "mission" : "work") as WorkspaceSignalRecord["source"],
        type:
          trace.traceType === "provider_prompt"
            ? "prompt.sent"
            : trace.traceType === "provider_response"
              ? "response.received"
              : trace.traceType,
        entityId: trace.taskId ?? trace.workstreamId ?? trace.id,
        status: null,
        summary: trace.summary,
        payload: {
          workItemId: state.workItem.id,
          taskId: trace.taskId ?? undefined,
          workstreamId: trace.workstreamId ?? undefined,
          runId: trace.runId ?? undefined,
          traceId: trace.id,
          ownerAgentId: trace.ownerAgentId ?? undefined
        }
      }))
    );
    const fromHandoffs = state.handoffRuntime.map((handoff) => ({
      ts: handoff.at,
      workspaceId: state.workItem.workspaceId,
      source: "work" as const,
      type: "handoff.created",
      entityId: handoff.id,
      status: null,
      summary: handoff.summary,
      payload: {
        workItemId: state.workItem.id,
        workstreamId: handoff.fromWorkstreamId ?? undefined,
        handoffToWorkstreamId: handoff.toWorkstreamId ?? undefined
      }
    }));
    return dedupeSignals([...fromTraceGroups, ...fromHandoffs]).sort(
      (left, right) => eventTimestampValue(right.ts) - eventTimestampValue(left.ts)
    );
  }, [state]);
  const timelineSignals = useMemo(
    () => dedupeSignals([...liveSignals, ...seededTimelineSignals])
      .sort((left, right) => eventTimestampValue(right.ts) - eventTimestampValue(left.ts))
      .slice(0, 18),
    [liveSignals, seededTimelineSignals]
  );
  const recentPromptActivity = useMemo(
    () => (state?.workstreamTrace ?? [])
      .flatMap((group) => group.traces)
      .filter((trace) => ["assignment", "provider_prompt", "provider_response"].includes(trace.traceType))
      .sort((left, right) => eventTimestampValue(right.ts) - eventTimestampValue(left.ts))
      .slice(0, 6),
    [state?.workstreamTrace]
  );
  const liveTasks = useMemo(() => {
    const priority = (status: string) => {
      if (ATTENTION_TASK_STATUSES.has(status)) return 0;
      if (status === "running" || status === "active") return 1;
      if (status === "queued" || status === "paused") return 2;
      if (status === "succeeded" || status === "completed") return 3;
      return 4;
    };
    return cycleScopedTasks.slice().sort((left, right) => {
      const statusDelta = priority(left.status) - priority(right.status);
      if (statusDelta !== 0) return statusDelta;
      return left.title.localeCompare(right.title);
    });
  }, [cycleScopedTasks]);
  const activeSessionTasks = useMemo(
    () => liveTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)),
    [liveTasks]
  );
  const attentionTask = useMemo(
    () => liveTasks.find((task) => ATTENTION_TASK_STATUSES.has(task.status)) ?? null,
    [liveTasks]
  );
  const completedSessionTasks = useMemo(
    () => liveTasks.filter((task) => task.status === "succeeded" || task.status === "completed"),
    [liveTasks]
  );
  const liveCandidateRunIds = useMemo(() => {
    const ids = new Set<string>();
    if (state?.workItem.linkedRunId) ids.add(state.workItem.linkedRunId);
    for (const task of liveTasks) {
      if (task.linkedRunId) ids.add(task.linkedRunId);
    }
    return Array.from(ids);
  }, [liveTasks, state?.workItem.linkedRunId]);
  useEffect(() => {
    if (!state?.workItem.workspaceId || liveCandidateRunIds.length === 0) {
      setLiveRunSnapshots({});
      return;
    }
    let cancelled = false;
    const query = `?workspace=${encodeURIComponent(state.workItem.workspaceId)}`;
    const loadRunSnapshots = async () => {
      const entries = await Promise.all(liveCandidateRunIds.map(async (runId) => {
        try {
          const res = await fetch(`/api/runs/${encodeURIComponent(runId)}${query}`, { cache: "no-store" });
          if (!res.ok) return [runId, null] as const;
          const payload = await res.json().catch(() => null);
          return [runId, (payload ?? null) as RunDetail | null] as const;
        } catch {
          return [runId, null] as const;
        }
      }));
      if (!cancelled) {
        setLiveRunSnapshots(Object.fromEntries(entries) as Record<string, RunDetail | null>);
      }
    };
    void loadRunSnapshots();
    const timer = setInterval(() => {
      void loadRunSnapshots();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveCandidateRunIds, state?.workItem.workspaceId]);
  const preferredLiveRunId = useMemo(() => {
    // 1) Try to follow the current baton by default
    // Identify the active workstream (baton holder) from either teamRuntime or derived workstreamRuntime
    const batonWorkstreamId = (() => {
      const explicit = state?.teamRuntime?.activeWorkstreamId ?? null;
      if (explicit) return explicit;
      const runtimes = (state?.workstreamRuntime ?? []);
      const byPriority = (runtimes
        .find((r) => r.status === "running")
        ?? runtimes.find((r) => r.status === "paused")
        ?? runtimes.find((r) => r.status === "blocked")
        ?? runtimes.find((r) => r.status === "queued")
        ?? runtimes[0]
        ?? null);
      return byPriority?.id ?? null;
    })();

    if (batonWorkstreamId) {
      // Prefer the active child run within the baton workstream when available
      const batonTasks = liveTasks
        .filter((t) => t.workstreamId === batonWorkstreamId && typeof t.linkedRunId === "string" && t.linkedRunId)
        .sort((l, r) => {
          // Attention > Active > Queued > Completed
          const rank = (s: string) => (
            ATTENTION_TASK_STATUSES.has(s) ? 0
              : (s === "running" || s === "active" || s === "paused") ? 1
                : (s === "queued" || s === "pending") ? 2
                  : (s === "succeeded" || s === "completed") ? 4
                    : 3
          );
          const delta = rank(l.status) - rank(r.status);
          if (delta !== 0) return delta;
          return (l.title ?? "").localeCompare(r.title ?? "");
        });
      const batonRunId = batonTasks[0]?.linkedRunId ?? null;
      if (batonRunId && liveCandidateRunIds.includes(batonRunId)) return batonRunId;
    }

    // If baton isn't identifiable, still align to any active child run with a linked run.
    const activeTaskWithRun = activeSessionTasks.find((t) => typeof t.linkedRunId === "string" && t.linkedRunId.trim());
    if (activeTaskWithRun?.linkedRunId && liveCandidateRunIds.includes(activeTaskWithRun.linkedRunId)) {
      return activeTaskWithRun.linkedRunId;
    }

    // 2) Fallback: rank all candidate runs by live status and review need
    const rankedRuns = liveCandidateRunIds
      .map((runId) => {
        const task = liveTasks.find((entry) => entry.linkedRunId === runId) ?? null;
        const snapshot = liveRunSnapshots[runId] ?? null;
        const leadStep = (snapshot?.steps ?? []).find((step) => {
          const status = normalizeRunLikeStatus(step.status);
          return status === "running" || status === "blocked" || status === "failed" || status === "awaiting_approval" || status === "waiting_input";
        }) ?? snapshot?.steps.at(-1) ?? null;
        const pauseReasonRaw = leadStep?.pauseReason ?? snapshot?.run?.pauseReason ?? null;
        const verdictRaw = leadStep?.verdict ?? snapshot?.run?.verdict ?? null;
        const changeStatusRaw = leadStep?.change?.status ?? null;
        const fallbackStatus = normalizeRunLikeStatus(task?.status ?? "pending") || "pending";
        const status = snapshot ? inferRunDisplayStatus(snapshot) : fallbackStatus;
        const needsReview = pauseReasonRaw === "awaiting_approval"
          || verdictRaw === "needs_human_review"
          || changeStatusRaw === "needs_review";
        return {
          runId,
          status,
          needsReview,
          title: task?.title ?? snapshot?.run?.goal ?? runId
        };
      })
      .sort((left, right) => {
        const statusDelta = rankLiveRunForFocus(left.status, left.needsReview) - rankLiveRunForFocus(right.status, right.needsReview);
        if (statusDelta !== 0) return statusDelta;
        return left.title.localeCompare(right.title);
      });
    return rankedRuns[0]?.runId ?? state?.workItem.linkedRunId ?? null;
  }, [activeSessionTasks, liveCandidateRunIds, liveRunSnapshots, liveTasks, state?.workItem.linkedRunId, state?.teamRuntime?.activeWorkstreamId, state?.workstreamRuntime]);
  useEffect(() => {
    if (!preferredLiveRunId) {
      setLiveSelectedRunId("");
      setLiveSelectionPinned(false);
      return;
    }
    if (!liveSelectionPinned) {
      setLiveSelectedRunId(preferredLiveRunId);
    }
  }, [preferredLiveRunId, liveSelectionPinned]);
  useEffect(() => {
    if (!liveSelectionPinned || !liveSelectedRunId) return;
    if (liveCandidateRunIds.includes(liveSelectedRunId)) return;
    setLiveSelectionPinned(false);
    setLiveSelectedRunId(preferredLiveRunId ?? "");
  }, [liveCandidateRunIds, liveSelectedRunId, liveSelectionPinned, preferredLiveRunId]);
  const livePinnedRunIsAvailable = liveSelectionPinned
    && Boolean(liveSelectedRunId)
    && liveCandidateRunIds.includes(liveSelectedRunId);
  const liveFocusedRunId = livePinnedRunIsAvailable ? liveSelectedRunId : preferredLiveRunId;
  const liveFocusedTask = liveFocusedRunId
    ? liveTasks.find((task) => task.linkedRunId === liveFocusedRunId) ?? null
    : null;

  useEffect(() => {
    if (!liveFocusedRunId || !state?.workItem.workspaceId) {
      setLiveRunDetail(null);
      setLiveRunLogs([]);
      setLiveRunEvents([]);
      return;
    }
    setLiveRunLogs([]);
    setLiveRunEvents([]);
    let cancelled = false;
    const query = `?workspace=${encodeURIComponent(state.workItem.workspaceId)}`;
    const loadRun = async () => {
      try {
        const [detailRes, logsRes] = await Promise.all([
          fetch(`/api/runs/${encodeURIComponent(liveFocusedRunId)}${query}`, { cache: "no-store" }),
          fetch(`/api/runs/${encodeURIComponent(liveFocusedRunId)}/logs${query}`, { cache: "no-store" })
        ]);
        if (cancelled) return;
        if (detailRes.ok) {
          const payload = await detailRes.json().catch(() => null);
          setLiveRunDetail((payload ?? null) as RunDetail | null);
        } else {
          setLiveRunDetail(null);
        }
        if (logsRes.ok) {
          const payload = await logsRes.json().catch(() => ({ lines: [] })) as RunLogResponse;
          setLiveRunLogs(Array.isArray(payload.lines) ? payload.lines.slice(-18) : []);
        } else {
          setLiveRunLogs([]);
        }
      } catch {
        if (!cancelled) {
          setLiveRunDetail(null);
          setLiveRunLogs([]);
        }
      }
    };
    void loadRun();
    const timer = setInterval(() => {
      void loadRun();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveFocusedRunId, state?.workItem.workspaceId]);

  const liveRunStreamUrl = liveFocusedRunId && state?.workItem.workspaceId
    ? `/api/runs/${encodeURIComponent(liveFocusedRunId)}/stream?workspace=${encodeURIComponent(state.workItem.workspaceId)}`
    : null;
  const handleLiveRunStream = useCallback((event: MessageEvent<string>) => {
    let payload: LiveRunStreamPayload | null = null;
    try {
      payload = JSON.parse(event.data) as LiveRunStreamPayload;
    } catch {
      payload = null;
    }
    if (!payload || payload.t === "heartbeat") return;
    if (payload.t === "run.snapshot") {
      setLiveRunDetail((current) => {
        if (!current && !payload?.run) return current;
        return {
          run: payload?.run ?? current?.run ?? null,
          steps: Array.isArray(payload?.steps) ? payload.steps : current?.steps ?? [],
          graph: current?.graph ?? null,
          delivery: current?.delivery ?? null
        } as RunDetail;
      });
      return;
    }
    setLiveRunEvents((current) => [formatRunStreamEvent(payload), ...current].slice(0, 20));
  }, []);

  useEventSource(liveRunStreamUrl, handleLiveRunStream);

  const liveFocusedRunSnapshot = liveFocusedRunId ? liveRunSnapshots[liveFocusedRunId] ?? null : null;
  const liveFocusedRunDetail = liveRunDetail?.run?.runId === liveFocusedRunId
    ? liveRunDetail
    : liveFocusedRunSnapshot;
  const liveRunStatus = inferRunDisplayStatus(liveFocusedRunDetail);
  const liveRunProgress = computeRunProgress(liveFocusedRunDetail);
  const liveRunLeadStep = (liveFocusedRunDetail?.steps ?? []).find((step) => {
    const status = normalizeRunLikeStatus(step.status);
    return status === "running" || status === "blocked" || status === "failed" || status === "awaiting_approval" || status === "waiting_input";
  }) ?? liveFocusedRunDetail?.steps.at(-1) ?? null;
  const orderedLiveRunSteps = (liveFocusedRunDetail?.steps ?? [])
    .slice()
    .sort((left, right) => {
      const delta = runStepPriority(left.status) - runStepPriority(right.status);
      if (delta !== 0) return delta;
      const leftTime = Date.parse(left.start ?? left.end ?? "");
      const rightTime = Date.parse(right.start ?? right.end ?? "");
      return Number.isNaN(rightTime) || Number.isNaN(leftTime) ? 0 : rightTime - leftTime;
    });
  const liveChildRuns = useMemo(() => {
    return liveCandidateRunIds
      .map((runId) => {
        const task = liveTasks.find((entry) => entry.linkedRunId === runId) ?? null;
        const snapshot = liveRunSnapshots[runId] ?? null;
        const leadStep = (snapshot?.steps ?? []).find((step) => {
          const status = normalizeRunLikeStatus(step.status);
          return status === "running" || status === "blocked" || status === "failed" || status === "awaiting_approval" || status === "waiting_input";
        }) ?? snapshot?.steps.at(-1) ?? null;
        const pauseReasonRaw = leadStep?.pauseReason ?? snapshot?.run?.pauseReason ?? null;
        const verdictRaw = leadStep?.verdict ?? snapshot?.run?.verdict ?? null;
        const changeStatusRaw = leadStep?.change?.status ?? null;
        const validationStatusRaw = leadStep?.validation?.status ?? null;
        const fallbackStatus = normalizeRunLikeStatus(task?.status ?? "pending") || "pending";
        const status = snapshot ? inferRunDisplayStatus(snapshot) : fallbackStatus;
        const needsReview = pauseReasonRaw === "awaiting_approval"
          || verdictRaw === "needs_human_review"
          || changeStatusRaw === "needs_review";
        return {
          runId,
          task,
          status,
          title: task?.title ?? snapshot?.run?.goal ?? state?.workItem.brief.title ?? runId,
          laneLabel: task?.laneLabel ?? task?.laneId ?? "Child run",
          summary:
            (leadStep ? runStepSummary(leadStep) : null)
            ?? leadStep?.validation?.summary
            ?? leadStep?.change?.applyError
            ?? task?.resultSummary
            ?? snapshot?.run?.error
            ?? snapshot?.run?.goal
            ?? "No child run summary has been recorded yet.",
          pauseLabel: typeof pauseReasonRaw === "string" && pauseReasonRaw.trim()
            ? pauseReasonRaw.replace(/_/g, " ")
            : null,
          changeLabel: changeStatusRaw && changeStatusRaw !== "none"
            ? changeStatusRaw.replace(/_/g, " ")
            : null,
          validationLabel: validationStatusRaw && validationStatusRaw !== "not_requested"
            ? validationStatusRaw.replace(/_/g, " ")
            : null,
          verdictLabel: typeof verdictRaw === "string" && verdictRaw.trim()
            ? verdictRaw.replace(/_/g, " ")
            : null,
          needsReview
        };
      })
      .sort((left, right) => {
        const statusDelta = rankLiveRunForFocus(left.status, left.needsReview) - rankLiveRunForFocus(right.status, right.needsReview);
        if (statusDelta !== 0) return statusDelta;
        return left.title.localeCompare(right.title);
      });
  }, [liveCandidateRunIds, liveRunSnapshots, liveTasks, state?.workItem.brief.title]);
  const liveSelectedRunCard = liveFocusedRunId
    ? liveChildRuns.find((run) => run.runId === liveFocusedRunId) ?? null
    : null;
  const livePreferredRunCard = preferredLiveRunId
    ? liveChildRuns.find((run) => run.runId === preferredLiveRunId) ?? null
    : null;
  const liveFocusFollowsBaton = !livePinnedRunIsAvailable;
  const liveRunningChildRuns = liveChildRuns.filter((run) => run.status === "running" || run.status === "active");
  const liveQueuedChildRuns = liveChildRuns.filter((run) => run.status === "queued" || run.status === "pending");
  const liveRunsAwaitingReview = liveChildRuns.filter((run) => run.needsReview);
  const liveChildExecutionLabel = liveChildRuns.length === 0
    ? "No child runs"
    : `${liveChildRuns.length} child run${liveChildRuns.length === 1 ? "" : "s"}`;
  const liveChildExecutionSummary = [
    liveChildExecutionLabel,
    liveRunningChildRuns.length > 0 ? `${liveRunningChildRuns.length} running` : null,
    liveRunsAwaitingReview.length > 0 ? `${liveRunsAwaitingReview.length} waiting for review` : null,
    liveQueuedChildRuns.length > 0 ? `${liveQueuedChildRuns.length} queued` : null
  ].filter(Boolean).join(" · ");
  const selectedRecoveryArtifact = useMemo(
    () => state?.recovery?.artifacts.find((artifact) => recoveryArtifactKey(artifact) === recoverySelectedArtifactKey) ?? null,
    [recoverySelectedArtifactKey, state?.recovery?.artifacts]
  );

  useEffect(() => {
    if (!liveFocusedRunId || !state?.workItem.workspaceId || !liveRunLeadStep?.stepId) {
      setLiveRunArtifacts([]);
      setLiveSelectedArtifact("");
      setLiveArtifactContent("");
      setLiveArtifactMimeType("text/plain");
      setLiveArtifactEncoding("utf8");
      return;
    }
    let cancelled = false;
    const loadArtifacts = async () => {
      try {
        const query = `?workspace=${encodeURIComponent(state.workItem.workspaceId)}`;
        const res = await fetch(
          `/api/runs/${encodeURIComponent(liveFocusedRunId)}/steps/${encodeURIComponent(liveRunLeadStep.stepId)}/artifacts${query}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          if (!cancelled) {
            setLiveRunArtifacts([]);
            setLiveSelectedArtifact("");
          }
          return;
        }
        const payload = await res.json().catch(() => ({ files: [] })) as RunArtifactListResponse;
        const files = Array.isArray(payload.files) ? payload.files : [];
        if (!cancelled) {
          setLiveRunArtifacts(files);
          setLiveSelectedArtifact((current) => pickFocusedRunArtifact(files, liveRunLeadStep, current));
        }
      } catch {
        if (!cancelled) {
          setLiveRunArtifacts([]);
          setLiveSelectedArtifact("");
        }
      }
    };
    void loadArtifacts();
    return () => {
      cancelled = true;
    };
  }, [liveFocusedRunId, liveRunLeadStep, state?.workItem.workspaceId]);

  useEffect(() => {
    if (!liveFocusedRunId || !state?.workItem.workspaceId || !liveRunLeadStep?.stepId || !liveSelectedArtifact) {
      setLiveArtifactContent("");
      setLiveArtifactMimeType("text/plain");
      setLiveArtifactEncoding("utf8");
      return;
    }
    let cancelled = false;
    const safePath = liveSelectedArtifact
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const loadArtifact = async () => {
      try {
        const query = `?workspace=${encodeURIComponent(state.workItem.workspaceId)}`;
        const res = await fetch(
          `/api/runs/${encodeURIComponent(liveFocusedRunId)}/steps/${encodeURIComponent(liveRunLeadStep.stepId)}/artifacts/${safePath}${query}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          if (!cancelled) {
            setLiveArtifactContent("");
            setLiveArtifactMimeType("text/plain");
            setLiveArtifactEncoding("utf8");
          }
          return;
        }
        const payload = await res.json().catch(() => ({})) as RunArtifactContentResponse;
        if (!cancelled) {
          setLiveArtifactContent(payload.content ?? "");
          setLiveArtifactMimeType(payload.mimeType ?? "text/plain");
          setLiveArtifactEncoding(payload.encoding ?? "utf8");
        }
      } catch {
        if (!cancelled) {
          setLiveArtifactContent("");
          setLiveArtifactMimeType("text/plain");
          setLiveArtifactEncoding("utf8");
        }
      }
    };
    void loadArtifact();
      return () => {
        cancelled = true;
      };
  }, [liveFocusedRunId, liveRunLeadStep, liveSelectedArtifact, state?.workItem.workspaceId]);

  useEffect(() => {
    if (!state?.recovery || state.recovery.artifacts.length === 0) {
      setRecoverySelectedArtifactKey("");
      setRecoveryArtifactContent("");
      setRecoveryArtifactMimeType("text/plain");
      setRecoveryArtifactEncoding("utf8");
      return;
    }
    setRecoverySelectedArtifactKey((current) => pickRecoveryArtifact(state.recovery!.artifacts, current));
  }, [state?.recovery]);

  useEffect(() => {
    if (!selectedRecoveryArtifact || !state?.workItem.workspaceId || !selectedRecoveryArtifact.runId || !selectedRecoveryArtifact.stepId) {
      setRecoveryArtifactContent("");
      setRecoveryArtifactMimeType("text/plain");
      setRecoveryArtifactEncoding("utf8");
      return;
    }
    let cancelled = false;
    const safePath = selectedRecoveryArtifact.path
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const loadArtifact = async () => {
      try {
        const query = `?workspace=${encodeURIComponent(state.workItem.workspaceId)}`;
        const res = await fetch(
          `/api/runs/${encodeURIComponent(selectedRecoveryArtifact.runId ?? "")}/steps/${encodeURIComponent(selectedRecoveryArtifact.stepId ?? "")}/artifacts/${safePath}${query}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          if (!cancelled) {
            setRecoveryArtifactContent("");
            setRecoveryArtifactMimeType("text/plain");
            setRecoveryArtifactEncoding("utf8");
          }
          return;
        }
        const payload = await res.json().catch(() => ({})) as RunArtifactContentResponse;
        if (!cancelled) {
          setRecoveryArtifactContent(payload.content ?? "");
          setRecoveryArtifactMimeType(payload.mimeType ?? "text/plain");
          setRecoveryArtifactEncoding(payload.encoding ?? "utf8");
        }
      } catch {
        if (!cancelled) {
          setRecoveryArtifactContent("");
          setRecoveryArtifactMimeType("text/plain");
          setRecoveryArtifactEncoding("utf8");
        }
      }
    };
    void loadArtifact();
    return () => {
      cancelled = true;
    };
  }, [selectedRecoveryArtifact, state?.workItem.workspaceId]);

  const submitReviewDecision = async (
    decision: "approve" | "send_back",
    options?: { targetRunId?: string | null; targetTaskId?: string | null }
  ) => {
    if (!state) return false;
    setReviewSubmitting(true);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(state.workItem.id)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: state.workItem.workspaceId,
          decision,
          note: reviewNote,
          targetRunId: options?.targetRunId ?? undefined,
          targetTaskId: options?.targetTaskId ?? undefined
        })
      });
      const payload = await res.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        workItem?: WorkItemRecord;
        review?: WorkItemReviewSummary;
      };
      if (!res.ok || !payload.ok || !payload.workItem || !payload.review) {
        throw new Error(payload.error ?? "Review decision could not be saved");
      }
      setState((current) => current ? {
        ...current,
        workItem: payload.workItem ?? current.workItem,
        review: payload.review ?? current.review
      } : current);
      setReviewNote(payload.review.operatorNote ?? reviewNote);
      setReviewNoteDirty(false);
      pushToast({
        tone: decision === "approve" ? "success" : "warning",
        title: decision === "approve" ? "Work item approved" : "Changes requested",
        message: state.workItem.brief.title
      });
      // Fire-and-forget audit record against the live session for traceability.
      const auditRunId = options?.targetRunId || liveFocusedRunId || state.workItem.linkedRunId || null;
      if (auditRunId) {
        void fetch("/api/sessions/decisions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: auditRunId,
            workspaceId: state.workItem.workspaceId,
            decision,
            note: reviewNote && reviewNote.trim() ? reviewNote.trim() : undefined,
            data: options?.targetTaskId ? { targetTaskId: options.targetTaskId } : undefined
          })
        }).catch(() => {});
      }
      setRefreshKey((value) => value + 1);
      return true;
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Review action failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
    } finally {
      setReviewSubmitting(false);
    }
  };

  const launchExecution = async () => {
    if (!state || launchingExecution) return;
    setLaunchingExecution(true);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(state.workItem.id)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: state.workItem.workspaceId })
      });
      const payload = await res.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        workItem?: WorkItemRecord;
      };
      if (!res.ok || !payload.ok || !payload.workItem) {
        throw new Error(payload.error ?? "Execution could not be started");
      }
      setState((current) => current ? { ...current, workItem: payload.workItem ?? current.workItem } : current);
      setDetailView("live");
      pushToast({
        tone: "success",
        title: state.workItem.reviewStatus === "changes_requested" ? "Remediation loop launched" : "Execution launched",
        message: state.workItem.brief.title
      });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Execution launch failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setLaunchingExecution(false);
    }
  };

  const submitOptimizationAction = async (options: {
    kind: "prompt" | "strategy" | "opportunity";
    action: "approve" | "reject" | "convert";
    cycleId: string;
    itemId: string;
    successTitle: string;
  }) => {
    if (!state) return;
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(state.workItem.id)}/optimization`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: state.workItem.workspaceId,
          kind: options.kind,
          action: options.action,
          cycleId: options.cycleId,
          itemId: options.itemId
        })
      });
      const payload = await res.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        createdWorkItem?: WorkItemRecord;
      };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? "Optimization action failed");
      }
      pushToast({
        tone: options.action === "reject" ? "warning" : "success",
        title: options.successTitle,
        message: payload.createdWorkItem?.brief.title ?? state.workItem.brief.title
      });
      setRefreshKey((value) => value + 1);
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Optimization action failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const submitRecoveryAction = async (action: NonNullable<DetailState["recovery"]>["suggestedActions"][number]) => {
    if (!state) return;
    const actionKey = `${action.kind}:${action.runId ?? action.taskId ?? action.label}`;
    setRecoverySubmitting(actionKey);
    try {
      if (action.kind === "resume_run" && action.runId) {
        const res = await fetch(`/api/runs/${encodeURIComponent(action.runId)}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: state.workItem.workspaceId })
        });
        const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
        if (!res.ok || !payload.ok) {
          throw new Error(payload.error ?? "Run resume failed");
        }
        pushToast({
          tone: "success",
          title: "Run resume started",
          message: state.workItem.brief.title
        });
      } else if (action.kind === "retry_task" && action.taskId) {
        const res = await fetch(`/api/tasks/${encodeURIComponent(action.taskId)}/retry`, {
          method: "POST"
        });
        const payload = await res.json().catch(() => ({})) as { task?: { id?: string }; error?: string };
        if (!res.ok || !payload.task) {
          throw new Error(payload.error ?? "Task retry failed");
        }
        pushToast({
          tone: "success",
          title: "Task moved back to queue",
          message: payload.task.id ?? state.workItem.brief.title
        });
      } else if (action.kind === "inspect_artifact" && action.artifactPath) {
        const artifact = state.recovery?.artifacts.find((entry) =>
          entry.path === action.artifactPath
          && (!action.runId || entry.runId === action.runId)
          && (!action.taskId || entry.taskId === action.taskId)
        ) ?? state.recovery?.artifacts.find((entry) => entry.path === action.artifactPath) ?? null;
        if (!artifact) {
          throw new Error("Recovery artifact not found");
        }
        setRecoverySelectedArtifactKey(recoveryArtifactKey(artifact));
        setDetailView("inspect");
        pushToast({
          tone: "info",
          title: "Recovery artifact selected",
          message: artifact.label
        });
      } else {
        return;
      }
      setRefreshKey((value) => value + 1);
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Recovery action failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setRecoverySubmitting(null);
    }
  };

  const approvePausedRun = async (always = false) => {
    if (!state || !liveFocusedRunId || !liveRunLeadStep?.stepId || liveApprovalSubmitting) return;
    setLiveApprovalSubmitting(true);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(liveFocusedRunId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: state.workItem.workspaceId,
          stepId: liveRunLeadStep.stepId,
          always
        })
      });
      const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error ?? "Approval failed");
      pushToast({ tone: "success", title: "Change approved", message: liveFocusedRunId });
      setRefreshKey((v) => v + 1);
    } catch (error) {
      pushToast({ tone: "danger", title: "Approval failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLiveApprovalSubmitting(false);
    }
  };

  const resumePausedRun = async () => {
    if (!state || !liveFocusedRunId || liveResumeSubmitting) return;
    setLiveResumeSubmitting(true);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(liveFocusedRunId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: state.workItem.workspaceId })
      });
      const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error ?? "Run resume failed");
      pushToast({ tone: "success", title: "Run resume started", message: liveFocusedRunId });
      setRefreshKey((v) => v + 1);
    } catch (error) {
      pushToast({ tone: "danger", title: "Resume failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLiveResumeSubmitting(false);
    }
  };

  const sendBackFromLive = async () => {
    if (liveSendBackSubmitting) return;
    setLiveSendBackSubmitting(true);
    try {
      await submitReviewDecision("send_back", {
        targetRunId: liveFocusedRunId,
        targetTaskId: liveFocusedTask?.id ?? null
      });
    } finally {
      setLiveSendBackSubmitting(false);
    }
  };

  if (loading && !state) {
    return (
      <main className="space-y-6">
        <section className="rounded-3xl border border-slate-800 bg-slate-950/60 px-6 py-10 text-center text-sm text-slate-500">
          Loading planning board...
        </section>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="space-y-6">
        <section className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/60 px-6 py-12 text-center">
          <h1 className="text-xl font-semibold text-white">Work item not available</h1>
          <p className="mt-2 text-sm text-slate-500">The work item detail could not be loaded from the current workspace.</p>
          <Link
            href="/work"
            className="mt-5 inline-flex rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
          >
            Back to work
          </Link>
        </section>
      </main>
    );
  }

  const { workItem, detail, currentPlan, review, optimization, teamRuntime, traceSummary, workstreamTrace, handoffRuntime } = state;
  const summaryWorkstreams = (currentPlan?.workstreams ?? []).map((workstream) => ({
    workstream,
    runtime: workstreamRuntimeById.get(workstream.id) ?? null
  }));
  const summaryGates = (currentPlan?.gates ?? []).map((gate) => ({
    gate,
    runtime: gateRuntimeById.get(gate.id) ?? null
  }));
  const currentLiveWorkstreams = summaryWorkstreams
    .slice()
    .sort((left, right) => {
      const leftRank = left.runtime?.status === "running" ? 0 : left.runtime?.status === "paused" ? 1 : left.runtime?.status === "blocked" ? 2 : left.runtime?.status === "queued" ? 3 : 4;
      const rightRank = right.runtime?.status === "running" ? 0 : right.runtime?.status === "paused" ? 1 : right.runtime?.status === "blocked" ? 2 : right.runtime?.status === "queued" ? 3 : 4;
      return leftRank - rightRank;
    });
  const liveLeadWorkstream = currentLiveWorkstreams.find(({ runtime }) => runtime?.status === "running")
    ?? currentLiveWorkstreams.find(({ runtime }) => runtime?.status === "paused")
    ?? currentLiveWorkstreams.find(({ runtime }) => runtime?.status === "blocked")
    ?? currentLiveWorkstreams.find(({ runtime }) => runtime?.status === "queued")
    ?? currentLiveWorkstreams[0]
    ?? null;
  const latestTimelineSignal = timelineSignals[0] ?? null;
  const liveSignalCount = timelineSignals.length;
  const laneFlowCards = (currentPlan?.lanes ?? detail.lanes).map((lane) => {
    const selection = (state.teamSelection ?? []).find((entry) => entry.laneId === lane.id) ?? null;
    const laneWorkstreams = summaryWorkstreams.filter(({ workstream }) => workstream.laneId === lane.id);
    const laneTasks = liveTasks.filter((task) => task.laneId === lane.id);
    const activeTask = laneTasks.find((task) => ATTENTION_TASK_STATUSES.has(task.status))
      ?? laneTasks.find((task) => ACTIVE_TASK_STATUSES.has(task.status))
      ?? laneTasks[0]
      ?? null;
    const primaryRuntime = laneWorkstreams
      .map((entry) => entry.runtime)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => laneBoardStatusRank(left.status) - laneBoardStatusRank(right.status))[0]
      ?? null;
    const nextHandoff = handoffRuntime.find((handoff) =>
      laneWorkstreams.some(({ workstream }) => workstream.id === handoff.fromWorkstreamId)
    ) ?? null;
    const derivedStatus =
      primaryRuntime?.status
      ?? (activeTask
        ? ATTENTION_TASK_STATUSES.has(activeTask.status)
          ? activeTask.status
          : ACTIVE_TASK_STATUSES.has(activeTask.status)
            ? "running"
            : activeTask.status
        : selection?.decision === "missing"
          ? "missing"
          : selection?.decision === "omitted"
            ? "omitted"
            : selection?.decision === "standby"
              ? "planned"
              : "planned");
    return {
      id: lane.id,
      label: lane.label,
      description: lane.description ?? null,
      selection,
      runtime: primaryRuntime,
      tasks: laneTasks,
      activeTask,
      nextHandoff,
      status: derivedStatus,
      ownerName:
        primaryRuntime?.ownerAgentName
        ?? selection?.chosenAgentName
        ?? activeTask?.ownerAgentName
        ?? activeTask?.assignedToAgentId
        ?? "Awaiting assignment",
      isCurrent: liveLeadWorkstream?.workstream.laneId === lane.id
    };
  });
  const pendingOptimizationCount = optimization
    ? optimization.cycles.reduce((total, cycle) => (
        total
        + cycle.promptSuggestions.filter((entry) => entry.status === "pending").length
        + (cycle.strategyRecommendation?.status === "pending" ? 1 : 0)
        + cycle.opportunities.filter((entry) => entry.status === "pending").length
      ), 0)
    : 0;
  const liveSessionNotice = workItem.reviewStatus === "changes_requested"
    ? {
        tone: "warning" as const,
        title: "Remediation is staged from this live session",
        body: "The paused child run was sent back. Review the requested changes, then launch remediation for the next cycle from this page."
      }
    : state.recovery
    ? isApprovalPauseRecovery(state.recovery)
      ? {
          tone: "warning" as const,
          title: liveRunsAwaitingReview.length > 1
            ? `${liveRunsAwaitingReview.length} child runs are waiting for review`
            : "A child run is waiting for review",
          body: liveRunningChildRuns.length > 0
            ? `${liveRunningChildRuns.length} sibling run${liveRunningChildRuns.length === 1 ? " is" : "s are"} still moving; one child run is paused for review. Stay here, select the paused run below, then approve, resume, or send back.`
            : `Session paused for review. Stay here, select the paused run below, then approve, resume, or send back.`
        }
    : isAuditFindingRecovery(state.recovery)
      ? {
          tone: "warning" as const,
          title: "Execution stopped on blocking findings",
          body: `${state.recovery.summary} Open Inspect to review the preserved report and suggested diff before rerunning anything.`
        }
      : {
          tone: "warning" as const,
          title: "Execution stopped and needs a recovery decision",
          body: `${state.recovery.summary} Open Inspect only if you need the raw recovery artifacts or retry controls.`
        }
    : attentionTask
      ? {
          tone: attentionTask.status === "failed" ? "danger" as const : "warning" as const,
          title: `${attentionTask.title} stopped the session`,
          body: attentionTask.resultSummary?.trim()
            || `The current baton is blocked in ${attentionTask.laneLabel ?? attentionTask.laneId ?? "this lane"}. Review the failure summary below before opening raw traces.`
        }
      : liveRunsAwaitingReview.length > 0
        ? {
            tone: "warning" as const,
            title: `${liveRunsAwaitingReview.length} child run${liveRunsAwaitingReview.length === 1 ? " is" : "s are"} waiting for review`,
            body: liveRunningChildRuns.length > 0
              ? `${liveRunningChildRuns.length} sibling run${liveRunningChildRuns.length === 1 ? " is" : "s are"} still moving, but validation cannot clear until the paused diff${liveRunsAwaitingReview.length === 1 ? " is" : "s are"} reviewed. Stay here and select the run that needs a decision.`
              : `This session has paused on reviewable child output. Stay on Live Session, pick the paused run below, and inspect the diff before you decide whether to approve or send it back.`
          }
      : hasActiveExecution(workItem)
        ? {
            tone: "info" as const,
            title: liveLeadWorkstream?.runtime?.ownerAgentName
              ? `${liveLeadWorkstream.runtime.ownerAgentName} currently has the baton`
              : "A live work session is in flight",
            body: liveLeadWorkstream?.runtime?.summary
              ?? teamRuntime?.currentStage
              ?? "Planning, implementation, validation, and handoffs will appear here as the session advances."
          }
        : workItem.status === "ready_for_review"
          ? {
              tone: "success" as const,
              title: "The session is finished and waiting on a human review",
              body: "The current cycle settled. Review the readiness signal and approve or send the work back."
            }
          : {
              tone: "info" as const,
              title: "No live session is running yet",
              body: "Launch execution from this page to watch the team plan, hand off work, and report findings in one place."
            };

  const liveRunNotice = !liveFocusedRunId
    ? null
    : liveRunStatus === "failed"
      ? {
          tone: "danger" as const,
          title: "The selected run failed",
          body: liveFocusedRunDetail?.run?.error
            ?? (liveRunLeadStep ? runStepSummary(liveRunLeadStep) : null)
            ?? "Open the task run only if the step summary below is not enough."
        }
      : liveRunStatus === "blocked"
        ? isAuditFindingRecovery(liveFocusedRunDetail?.run?.recovery)
          ? {
              tone: "warning" as const,
              title: "The selected run returned blocking findings",
              body: liveFocusedRunDetail?.run?.recovery?.summary
                ?? (liveRunLeadStep ? runStepSummary(liveRunLeadStep) : null)
                ?? "The run completed its audit step but reported blocking findings."
            }
          : {
              tone: "warning" as const,
              title: "The selected run is blocked",
              body: liveFocusedRunDetail?.run?.recovery?.summary
                ?? (liveRunLeadStep ? runStepSummary(liveRunLeadStep) : null)
                ?? "The run stopped on a blocking finding, pause, or recovery condition."
            }
        : liveRunStatus === "cancelled"
          ? {
              tone: "warning" as const,
              title: "The selected run was sent back",
              body: liveFocusedRunDetail?.run?.error
                ?? liveFocusedTask?.resultSummary
                ?? "Operator changes were requested for this child run. Launch remediation from the work item when you are ready to continue."
            }
        : liveRunStatus === "paused"
          ? {
              tone: "info" as const,
              title: "The selected run is waiting on input",
              body: liveRunLeadStep ? runStepSummary(liveRunLeadStep) ?? "Approval or input is required before this run can continue." : "Approval or input is required before this run can continue."
            }
          : liveRunStatus === "running"
            ? {
                tone: "info" as const,
                title: "A child run is actively moving",
                body: liveRunLeadStep ? runStepSummary(liveRunLeadStep) ?? "Watch the stream, logs, and step cards below as the specialist works." : "Watch the stream, logs, and step cards below as the specialist works."
              }
            : null;
  const liveLeadValidationResults = (liveRunLeadStep?.validation?.results ?? []).slice(0, 3);
  const liveLeadChangeStatus = liveRunLeadStep?.change?.status ?? null;
  const canApproveChange = liveRunStatus === "paused"
    && Boolean(liveRunLeadStep && (liveRunLeadStep.pauseReason === "awaiting_approval" || liveLeadChangeStatus === "needs_review"));
  const canResumeRun = liveRunStatus === "paused" || liveRunStatus === "interrupted";
  const liveStoryBeats: LiveStoryBeat[] = (() => {
    const beats: LiveStoryBeat[] = [];
    for (const group of state?.workstreamTrace ?? []) {
      for (const trace of group.traces) {
        const ts = eventTimestampValue(trace.ts);
        const agentLabel = trace.ownerAgentName ?? trace.assignmentToAgentName ?? trace.ownerRole ?? "Runtime";
        if (trace.traceType === "assignment") {
          beats.push({
            id: `trace:${trace.id}`,
            ts,
            tone: "info",
            label: `${agentLabel} received work`,
            summary: trace.promptSummary ?? trace.expectedOutput ?? trace.summary,
            meta: [
              trace.laneLabel ?? trace.workstreamTitle ?? "task assignment",
              trace.assignmentToAgentName ?? trace.assignmentToAgentId ?? "assigned",
              trace.providerModel ?? ""
            ].filter(Boolean)
          });
          continue;
        }
        if (trace.traceType === "provider_prompt") {
          beats.push({
            id: `trace:${trace.id}`,
            ts,
            tone: "info",
            label: `${agentLabel} sent a prompt`,
            summary: trace.promptSummary ?? trace.summary,
            meta: [
              trace.providerModel ?? "provider",
              trace.workstreamTitle ?? trace.laneLabel ?? "",
              typeof trace.inputTokens === "number" ? `${trace.inputTokens.toLocaleString()} input tokens` : ""
            ].filter(Boolean)
          });
          continue;
        }
        if (trace.traceType === "provider_response") {
          beats.push({
            id: `trace:${trace.id}`,
            ts,
            tone: "success",
            label: `${agentLabel} answered`,
            summary: trace.responseSummary ?? trace.outputSummary ?? trace.summary,
            meta: [
              trace.providerModel ?? "provider",
              typeof trace.outputTokens === "number" ? `${trace.outputTokens.toLocaleString()} output tokens` : "",
              typeof trace.estimatedCostUsd === "number" ? formatEstimatedCost(trace.estimatedCostUsd) : ""
            ].filter(Boolean)
          });
          continue;
        }
        if (trace.traceType === "handoff") {
          beats.push({
            id: `trace:${trace.id}`,
            ts,
            tone: "info",
            label: "Work handed off",
            summary: trace.summary,
            meta: [
              trace.workstreamTitle ?? trace.laneLabel ?? "",
              trace.handoffToWorkstreamId ?? "",
              trace.assignmentToAgentName ?? trace.assignmentToAgentId ?? ""
            ].filter(Boolean)
          });
          continue;
        }
        if (trace.traceType === "gate_update") {
          const gateStatus = normalizeRunLikeStatus(String(trace.payload?.status ?? ""));
          beats.push({
            id: `trace:${trace.id}`,
            ts,
            tone: gateStatus === "failed" || gateStatus === "blocked" ? "warning" : gateStatus === "succeeded" ? "success" : "info",
            label: "Gate updated",
            summary: trace.summary,
            meta: [
              ...(trace.gateRefs ?? []),
              trace.assignmentToAgentName ?? trace.ownerAgentName ?? "",
              trace.outputSummary ?? ""
            ].filter(Boolean)
          });
        }
      }
    }
    for (const step of orderedLiveRunSteps) {
      const status = normalizeRunLikeStatus(step.status);
      const stepTs = stepTimestampValue(step);
      if (!stepTs) continue;
      if (step.validation && step.validation.status !== "not_requested") {
        const failing = step.validation.results.find((result) => result.ok === false);
        beats.push({
          id: `validation:${step.stepId}:${stepTs}`,
          ts: stepTs,
          tone: step.validation.status === "passed" ? "success" : step.validation.status === "failed" || step.validation.status === "unavailable" ? "warning" : "info",
          label: `${step.stepId} validation ${step.validation.status.replace(/_/g, " ")}`,
          summary: step.validation.summary ?? failing?.summary ?? "Validation finished without a summary.",
          meta: [
            ...step.validation.commands.slice(0, 2),
            step.model ?? "",
            step.provider ?? ""
          ].filter(Boolean)
        });
      }
      if (step.change && step.change.status !== "none") {
        beats.push({
          id: `change:${step.stepId}:${stepTs}`,
          ts: stepTs,
          tone: step.change.status === "applied" || step.change.status === "validated" ? "success" : step.change.status === "apply_failed" || step.change.status === "validation_failed" ? "warning" : "info",
          label: `${step.stepId} diff ${step.change.status.replace(/_/g, " ")}`,
          summary: step.change.applyError ?? runStepSummary(step) ?? "A repository change was recorded for this step.",
          meta: [
            step.provider ?? "",
            step.model ?? "",
            step.change.diffArtifact ?? ""
          ].filter(Boolean)
        });
      }
      if (status === "failed" || status === "blocked") {
        beats.push({
          id: `status:${step.stepId}:${stepTs}`,
          ts: stepTs,
          tone: status === "failed" ? "danger" : "warning",
          label: `${step.stepId} ${status}`,
          summary: runStepSummary(step) ?? "The step stopped without a detailed summary.",
          meta: [
            step.provider ?? "",
            step.model ?? "",
            step.verdict ?? ""
          ].filter(Boolean)
        });
      }
    }
    return beats
      .sort((left, right) => right.ts - left.ts)
      .slice(0, 10);
  })();
  const focusedPromptMoments = recentPromptActivity
    .filter((trace) => (
      liveLeadWorkstream?.workstream.id
        ? trace.workstreamId === liveLeadWorkstream.workstream.id
        : true
    ))
    .slice(0, 3);
  const liveNextHandoffLabel = liveLeadWorkstream?.runtime?.handoffToWorkstreamId
    ?? laneFlowCards.find((lane) => lane.isCurrent)?.nextHandoff?.toWorkstreamId
    ?? null;
  const liveRecentHandoffs = handoffRuntime.slice(0, 3);
  const liveLeadLane = laneFlowCards.find((lane) => lane.isCurrent) ?? laneFlowCards[0] ?? null;
  const liveLeadAgent = liveLeadLane?.selection?.chosenAgentId
    ? agents.find((entry) => entry.id === liveLeadLane.selection?.chosenAgentId) ?? null
    : null;
  const livePromptMoment = focusedPromptMoments.find((trace) => trace.traceType === "provider_prompt")
    ?? focusedPromptMoments.find((trace) => trace.traceType === "assignment")
    ?? focusedPromptMoments.find((trace) => trace.traceType === "provider_response")
    ?? null;
  const livePromptHeading = !livePromptMoment
    ? "Assigned prompt"
    : livePromptMoment.traceType === "assignment"
      ? "Assignment brief"
      : livePromptMoment.traceType === "provider_response"
        ? "Latest response"
        : "Prompt summary";
  const livePromptSummary = livePromptMoment
    ? livePromptMoment.promptSummary
      ?? livePromptMoment.responseSummary
      ?? livePromptMoment.outputSummary
      ?? livePromptMoment.summary
    : "No prompt summary has been recorded for the current baton yet.";
  const liveCommandPreview = (liveRunLeadStep?.validation?.commands ?? []).slice(0, 3);
  const liveChangeLabel = liveLeadChangeStatus ? liveLeadChangeStatus.replace(/_/g, " ") : "No diff yet";
  const liveChangeSummary = liveRunLeadStep?.change?.applyError
    ?? liveRunLeadStep?.change?.diffArtifact
    ?? (liveLeadChangeStatus
      ? "A repository change was recorded for the selected step."
      : "No repository diff has been recorded for the selected step yet.");
  const liveValidationLabel = liveRunLeadStep?.validation && liveRunLeadStep.validation.status !== "not_requested"
    ? liveRunLeadStep.validation.status.replace(/_/g, " ")
    : "Not requested";
  const liveValidationSummary = liveRunLeadStep?.validation?.summary
    ?? liveLeadValidationResults.find((result) => result.summary)?.summary
    ?? (liveRunLeadStep?.validation && liveRunLeadStep.validation.status !== "not_requested"
      ? "Validation ran without a recorded summary."
      : "No validation command has been recorded for the selected step yet.");
  const liveFindingItems = [
    ...(state.recovery?.summary ? [state.recovery.summary] : []),
    ...review.openRisks
  ].filter((item, index, items) => items.indexOf(item) === index).slice(0, 3);
  const liveLastHandoff = liveRecentHandoffs[0] ?? null;
  const liveRequestedModel = liveLeadAgent?.provider?.modelOverride
    ?? liveLeadAgent?.provider?.profileId
    ?? null;
  const liveAppliedModel = liveRunLeadStep?.model
    ?? liveLeadWorkstream?.runtime?.providerModel
    ?? liveLeadAgent?.runtime?.currentModel
    ?? null;
  const liveEffort = liveLeadAgent?.provider?.effort ?? null;
  const liveCurrentFocus = liveSelectedRunCard?.title
    ?? liveFocusedTask?.title
    ?? liveLeadWorkstream?.workstream.title
    ?? "Waiting to start";
  const liveFocusLabel = liveFocusFollowsBaton ? "Following current baton" : "Pinned child run";
  const liveFocusSummary = liveFocusFollowsBaton
    ? liveSelectedRunCard
      ? `Session detail follows ${liveSelectedRunCard.title} automatically as the baton moves.`
      : "Session detail follows the live baton automatically as the cycle moves."
    : livePreferredRunCard
      ? `Pinned to ${liveSelectedRunCard?.title ?? liveFocusedRunId}. Current baton remains with ${livePreferredRunCard.title}.`
      : `Pinned to ${liveSelectedRunCard?.title ?? liveFocusedRunId}.`;
  const reviewReady = review.gate === "ready" || workItem.status === "ready_for_review";
  const liveBatonSummary = (() => {
    const owner = liveLeadWorkstream?.runtime?.ownerAgentName ?? null;
    const lane = liveLeadLane?.label ?? liveLeadWorkstream?.workstream.laneLabel ?? null;
    // If the cycle has settled into review, explain that explicitly.
    if (reviewReady) {
      return `Baton is parked with the Operator for review. Approve or send back to move the cycle.`;
    }
    // If nothing is running, avoid inventing state.
    if (!hasActiveExecution(workItem)) return null;
    // Explain why the baton is held and what moves it next.
    let reason: string | null = null;
    const parallel = liveChildRuns.length > 1 ? `${liveChildExecutionSummary}.` : null;
    if (attentionTask) {
      reason = `Paused on “${attentionTask.title}” in ${attentionTask.laneLabel ?? lane ?? "current lane"}.`;
    } else if (liveRunLeadStep?.validation && liveRunLeadStep.validation.status !== "not_requested" && liveRunLeadStep.validation.status !== "passed") {
      reason = `Waiting on ${liveRunLeadStep.validation.status.replace(/_/g, " ")} validation.`;
    } else if (liveLeadChangeStatus && !["applied", "validated"].includes(liveLeadChangeStatus)) {
      reason = `Working on diff ${liveLeadChangeStatus.replace(/_/g, " ")}.`;
    } else if (liveLeadWorkstream?.runtime?.summary) {
      reason = liveLeadWorkstream.runtime.summary;
    } else if (teamRuntime?.currentStage) {
      reason = teamRuntime.currentStage;
    }
    const next = liveNextHandoffLabel
      ? `Baton moves to ${liveNextHandoffLabel} after this step finishes.`
      : liveRunLeadStep?.pauseReason === "awaiting_approval"
        ? `Awaiting operator approval to proceed.`
        : null;
    const who = owner ?? "Operator";
    const where = lane ? ` in ${lane}` : "";
    return [
      `${who} holds the baton${where}.`,
      parallel ?? undefined,
      reason ?? undefined,
      next ?? undefined
    ].filter(Boolean).join(" ");
  })();
  const liveArtifactPreviewText = liveArtifactContent
    ? liveArtifactContent.slice(0, 1200)
    : "";
  const nextAction = state.recovery
    ? isAuditFindingRecovery(state.recovery)
      ? {
          tone: "warning" as const,
          title: "Review blocking findings before rerunning",
          body: "This work item stopped on blocking findings, not on an agent crash. Open Inspect to read the saved audit report and decide what to fix."
        }
      : {
          tone: "warning" as const,
          title: "Recovery action is the next step",
          body: "This work item has recovery guidance. Open Inspect only if you need retry or resume details."
        }
    : workItem.status === "draft" && !hasActiveExecution(workItem)
      ? {
          tone: "info" as const,
          title: "Launch execution to begin work",
          body: "This item is still a draft. Launch it when the request is ready to move."
        }
      : workItem.reviewStatus === "changes_requested"
        ? {
            tone: "warning" as const,
            title: "Remediation is the next operator action",
            body: "Review requested changes. Launch remediation after confirming the requested direction."
          }
        : workItem.status === "ready_for_review" || review.gate === "ready"
          ? {
              tone: "success" as const,
              title: "Human review is the next step",
              body: "This item is ready for a human decision. Approve it or send it back with a note."
            }
          : hasActiveExecution(workItem) && liveRunsAwaitingReview.length > 0
            ? {
                tone: "warning" as const,
                title: `Review ${liveRunsAwaitingReview.length} child run${liveRunsAwaitingReview.length === 1 ? "" : "s"} to unblock the lane`,
                body: liveRunningChildRuns.length > 0
                  ? `Implementation is still active in parallel, but ${liveRunsAwaitingReview.length} child run${liveRunsAwaitingReview.length === 1 ? " is" : "s are"} paused on reviewable diffs. Select one below, inspect the change, and decide whether it can proceed.`
                  : `The implementation lane is waiting on a human decision. Select the paused child run below and inspect its diff before you approve or send it back.`
              }
          : workItem.status === "blocked" || workItem.status === "failed"
            ? {
                tone: "danger" as const,
                title: "This work item is blocked",
                body: "Inspect the underlying run, task, or recovery guidance to see exactly what needs intervention."
              }
            : hasActiveExecution(workItem)
              ? {
                  tone: "info" as const,
                  title: "Execution is still in progress",
                  body: "Wait for the current cycle to settle. Open Inspect only if the runtime looks stalled."
                }
              : workItem.reviewStatus === "approved" || workItem.status === "completed"
                ? {
                    tone: "success" as const,
                    title: "No immediate action is required",
                    body: "This work item has already been completed or approved."
                  }
                : {
                    tone: "info" as const,
                    title: "Review the current summary",
                    body: "Use Inspect only if the summary no longer explains what is happening."
                  };
  const liveStageMood: "active" | "warning" | "danger" | "success" | "idle" = attentionTask
    ? "danger"
    : workItem.reviewStatus === "changes_requested" || liveRunsAwaitingReview.length > 0
      ? "warning"
      : reviewReady || workItem.reviewStatus === "approved" || workItem.status === "completed"
        ? "success"
        : hasActiveExecution(workItem)
          ? "active"
          : "idle";
  const liveStageLabel = attentionTask
    ? "Intervention needed"
    : workItem.reviewStatus === "changes_requested"
      ? "Remediation staged"
      : liveRunsAwaitingReview.length > 0
        ? liveRunningChildRuns.length > 0
          ? "Review gate live"
          : "Waiting on review"
        : liveRunningChildRuns.length > 1
          ? "Parallel delivery live"
          : reviewReady
            ? "Ready for operator"
            : hasActiveExecution(workItem)
              ? "Team in motion"
              : "Standing by";
  const liveStageHeadline = (() => {
    const owner = liveLeadWorkstream?.runtime?.ownerAgentName ?? liveLeadLane?.ownerName ?? "Operator";
    const lane = liveLeadLane?.label ?? liveLeadWorkstream?.workstream.laneLabel ?? "session";
    if (attentionTask) return `${owner} is blocked in ${lane}`;
    if (workItem.reviewStatus === "changes_requested") return "Remediation has re-entered the stage";
    if (liveRunsAwaitingReview.length > 0) {
      return liveRunningChildRuns.length > 0
        ? `${owner} is holding ${lane} while review catches up`
        : `Review is holding ${lane}`;
    }
    if (reviewReady) return "Human review has the baton";
    if (hasActiveExecution(workItem)) return `${owner} is moving ${lane}`;
    return "Session is ready to launch";
  })();
  const liveStageSummary = liveSessionNotice.body
    ?? liveBatonSummary
    ?? liveLeadWorkstream?.runtime?.summary
    ?? teamRuntime?.currentStage
    ?? "Launch execution from this page to watch the PM, specialists, validation, and audit move in one flow.";
  const liveStageMoves: LiveStageMove[] = liveStoryBeats.length > 0
    ? liveStoryBeats.slice(0, 4).map((beat) => ({
        id: beat.id,
        tone: beat.tone,
        label: beat.label,
        summary: beat.summary,
        meta: beat.meta,
        timeLabel: formatEventTimestamp(new Date(beat.ts).toISOString())
      }))
    : timelineSignals.slice(0, 4).map((signal) => {
        const tone: LiveStoryBeat["tone"] = signal.status === "failed"
          ? "danger"
          : signal.status === "blocked"
            ? "warning"
            : signal.status === "completed" || signal.type.endsWith(".completed")
              ? "success"
              : "info";
        return {
          id: `${signal.source}:${signal.type}:${signal.ts ?? "now"}`,
          tone,
          label: liveEventSourceLabel(signal),
          summary: signal.summary ?? "A runtime signal was recorded for this work item.",
          meta: [
            signal.source,
            readPayloadString(signal.payload, "workstreamId") ?? "",
            readPayloadString(signal.payload, "runId") ?? readPayloadString(signal.payload, "linkedRunId") ?? ""
          ].filter(Boolean),
          timeLabel: formatEventTimestamp(signal.ts)
        };
      });
  const liveMissionControlStats = [
    {
      label: "Baton owner",
      value: liveLeadWorkstream?.runtime?.ownerAgentName ?? "Operator",
      sub: liveLeadLane?.label ?? liveLeadWorkstream?.workstream.laneLabel ?? "No active lane"
    },
    {
      label: "Parallel work",
      value: liveRunningChildRuns.length > 1
        ? `${liveRunningChildRuns.length} live`
        : liveChildRuns.length > 0
          ? liveChildExecutionLabel
          : "Waiting",
      sub: liveChildExecutionSummary
    },
    {
      label: "Validation",
      value: liveValidationLabel,
      sub: liveValidationSummary
    },
    {
      label: "Findings",
      value: liveFindingItems.length > 0 ? `${liveFindingItems.length} open` : "Clear",
      sub: liveFindingItems[0] ?? "No blocking finding is currently flagged by the session truth."
    }
  ];
  const liveSpotlightLane = liveLeadLane ?? laneFlowCards[0] ?? null;
  const liveSupportingLanes = laneFlowCards
    .filter((lane) => lane.id !== liveSpotlightLane?.id)
    .sort((left, right) => {
      const leftRank = laneBoardStatusRank(left.status);
      const rightRank = laneBoardStatusRank(right.status);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.label.localeCompare(right.label);
    });
  const livePausedLaneCount = laneFlowCards.filter((lane) => lane.status === "paused").length;
  const liveBlockedLaneCount = laneFlowCards.filter((lane) => ["blocked", "failed", "cancelled"].includes(lane.status)).length;
  const liveCompletedLaneCount = laneFlowCards.filter((lane) => lane.status === "succeeded" || lane.status === "completed").length;
  const liveTruthRows = [
    {
      label: "Overall state",
      value: `${statusLabel(workItem.status)} · ${workItemKindLabel(workItem)}`
    },
    {
      label: "Baton owner",
      value: `${liveLeadWorkstream?.runtime?.ownerAgentName ?? "Operator"} · ${liveLeadLane?.label ?? liveLeadWorkstream?.workstream.laneLabel ?? "No active lane"}`
    },
    {
      label: "Session focus",
      value: liveFocusedRunId ? `${liveFocusLabel} · ${liveFocusedRunId}` : liveFocusLabel
    },
    {
      label: "Child executions",
      value: liveChildExecutionSummary
    },
    {
      label: "What changed",
      value: liveChangeLabel
    },
    {
      label: "Activity",
      value: `${liveSignalCount} events · ${completedSessionTasks.length} completed task${completedSessionTasks.length === 1 ? "" : "s"}`
    }
  ];
  const liveTruthBriefRows = liveTruthRows.slice(0, 4);
  const liveOperatorFacts = [
    {
      label: "Just changed",
      value: liveStageMoves[0]?.label ?? "Waiting for a fresh move",
      detail: liveStageMoves[0]?.summary ?? "The stage has not emitted a new move yet."
    },
    {
      label: "Session focus",
      value: liveCurrentFocus,
      detail: liveFocusSummary
    }
  ];
  const liveSpotlightSummary = liveSpotlightLane?.activeTask?.title
    ? `${liveSpotlightLane.activeTask.title}${liveSpotlightLane.activeTask.resultSummary ? ` · ${liveSpotlightLane.activeTask.resultSummary}` : ""}`
    : liveSpotlightLane?.runtime?.summary
      ?? liveSpotlightLane?.selection?.selectionReason
      ?? liveSpotlightLane?.description
      ?? "No lane activity recorded yet.";
  const recoverySectionLabel = isAuditFindingRecovery(state?.recovery)
    ? "Blocking Findings"
    : "Recovery Guidance";

  return (
    <main className="space-y-6">
      <section className="rounded-3xl border border-slate-800 bg-slate-950/60 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href="/work"
                className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Back to work
              </Link>
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                {workItemKindLabel(workItem)}
              </span>
              <span className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em] ${statusClassName(workItem.status)}`}>
                {statusLabel(workItem.status)}
              </span>
            </div>
            <h1 className="mt-4 text-2xl font-semibold text-white">{workItem.brief.title}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">{detail.summary}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!hasActiveExecution(workItem) && workItem.reviewStatus !== "approved" && (
              <button
                onClick={() => void launchExecution()}
                disabled={launchingExecution}
                className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {launchingExecution ? "Launching..." : launchActionLabel(workItem)}
              </button>
            )}
            {workItem.linkedRunId && (
              <Link
                href={`/runs/${workItem.linkedRunId}?workspace=${encodeURIComponent(workItem.workspaceId)}`}
                className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20"
              >
                Open linked run
              </Link>
            )}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-right">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Execution route</div>
              <div className="mt-1 text-sm font-medium text-white">{detail.template.name}</div>
              <div className="mt-1 text-xs text-slate-500">{detail.template.id}</div>
            </div>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedTabs
          value={detailView}
          onChange={(value) => setDetailView(value)}
          options={[
            { value: "live", label: "Live Session" },
            { value: "inspect", label: "Inspect" }
          ]}
        />
        <div className="text-sm text-slate-500">
          {detailView === "live"
            ? "Follow the current baton, task handoffs, and runtime events without dropping into raw trace noise."
            : "Open raw traces, evidence, history, and deeper runtime detail only when needed."}
        </div>
      </div>

      {detailView === "summary" ? (
        <>
          <MetricStrip
            items={[
              { label: "Status", value: statusLabel(workItem.status), sub: workItemKindLabel(workItem) },
              { label: "Execution", value: executionModeLabel(workItem), sub: workItem.linkedRunId ?? `${workItem.linkedTaskIds?.length ?? 0} task(s)` },
              { label: "Workstreams", value: summaryWorkstreams.length, sub: currentPlan ? "Current cycle" : "No cycle plan" },
              { label: "Open risks", value: review.openRisks.length, sub: review.gate === "ready" ? "Ready for review" : reviewGateLabel(review.gate) }
            ]}
          />

          <NoticePanel tone={nextAction.tone} title={nextAction.title}>
            {nextAction.body}
          </NoticePanel>

          <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
            <SurfacePanel
              title="Selected team"
              description="The people or lanes chosen for this work item right now."
            >
              <div className="space-y-3">
                {selectedTeam.length > 0 ? selectedTeam.map((selection) => {
                  const trace = selection.chosenAgentId ? traceSummaryByAgentId.get(selection.chosenAgentId) ?? null : null;
                  const agent = selection.chosenAgentId ? agents.find((entry) => entry.id === selection.chosenAgentId) ?? null : null;
                  return (
                    <div key={selection.laneId} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-white">{selection.laneLabel}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {selection.chosenAgentName ?? "Unassigned"} · {selection.chosenRole ?? selection.preferredRole}
                          </div>
                        </div>
                        <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${teamDecisionClassName(selection.decision)}`}>
                          {selection.decision}
                        </span>
                      </div>
                      <div className="mt-3 text-xs leading-5 text-slate-400">
                        {selection.selectionReason || selection.omissionReason || "No selection rationale recorded."}
                      </div>
                      {agent?.runtime?.providerReadiness ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
                          <span className={`rounded-full border px-2.5 py-1 uppercase tracking-[0.16em] ${providerReadinessClassName(agent.runtime.providerReadiness)}`}>
                            {providerReadinessLabel(agent.runtime.providerReadiness)}
                          </span>
                          {agent.runtime.providerReadinessReason ? (
                            <span className="text-slate-500">{agent.runtime.providerReadinessReason}</span>
                          ) : null}
                        </div>
                      ) : null}
                      {trace && (
                        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                          <span>Prompts {trace.promptCount}</span>
                          <span>Estimated cost {formatEstimatedCost(trace.estimatedCostUsd)}</span>
                          {trace.providerModel && <span>Model {trace.providerModel}</span>}
                        </div>
                      )}
                    </div>
                  );
                }) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                    No selected team is recorded yet.
                  </div>
                )}
              </div>
            </SurfacePanel>

            <SurfacePanel
              title="Active workstreams"
              description="The current work lanes and what they are waiting on."
            >
              <div className="space-y-3">
                {summaryWorkstreams.length > 0 ? summaryWorkstreams.map(({ workstream, runtime }) => (
                  <div key={workstream.id} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{workstream.title}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {workstream.laneLabel} · {workstream.type.replace(/_/g, " ")}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${laneRuntimeClassName(runtime?.status ?? "planned")}`}>
                        {laneRuntimeLabel(runtime?.status ?? "planned")}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                      {runtime?.ownerAgentName && <span>{runtime.ownerAgentName}</span>}
                      {runtime?.providerModel && <span>Model {runtime.providerModel}</span>}
                      <span>Prompts {runtime?.promptCount ?? 0}</span>
                      <span>Estimated cost {formatEstimatedCost(runtime?.estimatedCostUsd)}</span>
                    </div>
                    {(runtime?.summary || workstream.description) && (
                      <div className="mt-3 text-xs leading-5 text-slate-400">{runtime?.summary ?? workstream.description}</div>
                    )}
                  </div>
                )) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                    No active cycle workstreams are visible yet.
                  </div>
                )}
              </div>
            </SurfacePanel>

            <SurfacePanel
              title="Gates and readiness"
              description="The operator-facing readiness signal for the current cycle."
            >
              <div className="space-y-3">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium text-white">{review.headline}</div>
                    <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${reviewGateClassName(review.gate)}`}>
                      {reviewGateLabel(review.gate)}
                    </span>
                  </div>
                  {review.openRisks.length > 0 && (
                    <div className="mt-3 space-y-2 text-xs text-slate-400">
                      {review.openRisks.slice(0, 3).map((risk) => (
                        <div key={risk}>• {risk}</div>
                      ))}
                    </div>
                  )}
                </div>

                {summaryGates.length > 0 ? summaryGates.map(({ gate, runtime }) => (
                  <div key={gate.id} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{gate.label}</div>
                        <div className="mt-1 text-xs text-slate-500">{gate.type.replace(/_/g, " ")}</div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${gateStatusClassName(runtime?.status ?? "pending")}`}>
                        {signalLabel(runtime?.status ?? "pending")}
                      </span>
                    </div>
                    <div className="mt-3 text-xs leading-5 text-slate-400">
                      {runtime?.summary ?? runtime?.requiredBecause ?? "No gate evidence has been recorded yet."}
                    </div>
                  </div>
                )) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                    No explicit current-cycle gates were recorded.
                  </div>
                )}
              </div>
            </SurfacePanel>

            <SurfacePanel
              title="Inspect signals"
              description="Only a small hint stays here. Raw traces, evidence, remediation details, and optimization live in Inspect."
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                  <div className="text-lg font-semibold text-white">{traceSummary?.promptCount ?? 0}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">Prompt trace events</div>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                  <div className="text-lg font-semibold text-white">{pendingOptimizationCount}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">Pending optimization items</div>
                </div>
              </div>
              {state.recovery && (
                <div className="mt-4 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-4 py-4 text-sm text-fuchsia-100">
                  Recovery guidance exists for this work item. Open Inspect if you need resume or retry controls.
                </div>
              )}
            </SurfacePanel>
          </section>
        </>
      ) : detailView === "live" ? (
        <>
          {/* ═══ COMMAND STRIP ═══ The single-line scoreboard that reads the room */}
          <section
            className={`relative overflow-hidden rounded-2xl border px-5 py-4 ${missionControlFrameClassName(liveStageMood)} live-baton-breathe`}
          >
            <div
              className="absolute inset-0"
              style={{
                background: liveStageMood === "danger"
                  ? "linear-gradient(90deg, rgba(244,63,94,0.06), transparent 60%)"
                  : liveStageMood === "warning"
                    ? "linear-gradient(90deg, rgba(251,191,36,0.06), transparent 60%)"
                    : liveStageMood === "success"
                      ? "linear-gradient(90deg, rgba(52,211,153,0.06), transparent 60%)"
                      : liveStageMood === "active"
                        ? "linear-gradient(90deg, rgba(34,211,238,0.06), transparent 60%)"
                        : "none"
              }}
            />

            <div className="relative flex flex-wrap items-center justify-between gap-4">
              {/* Left: stage + headline */}
              <div className="flex items-center gap-4 min-w-0">
                {/* Baton indicator orb */}
                <div className="relative flex h-11 w-11 shrink-0 items-center justify-center">
                  <div className={`absolute inset-0 rounded-full ${liveStageMood === "danger" ? "bg-rose-400/20" : liveStageMood === "warning" ? "bg-amber-300/20" : liveStageMood === "success" ? "bg-emerald-400/20" : liveStageMood === "active" ? "bg-cyan-400/20" : "bg-slate-400/10"} ${hasActiveExecution(workItem) ? "live-baton-breathe" : ""}`} />
                  <div className={`relative h-3.5 w-3.5 rounded-full ${liveStageMood === "danger" ? "bg-rose-400" : liveStageMood === "warning" ? "bg-amber-300" : liveStageMood === "success" ? "bg-emerald-400" : liveStageMood === "active" ? "bg-cyan-400" : "bg-slate-500"} ${hasActiveExecution(workItem) ? "live-stage-dot" : ""}`} />
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] ${missionControlBadgeClassName(liveStageMood)}`}>
                      {liveStageLabel}
                    </span>
                    {liveRunningChildRuns.length > 1 ? (
                      <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-cyan-100">
                        {liveRunningChildRuns.length} parallel
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-white sm:text-xl">{liveStageHeadline}</h2>
                </div>
              </div>

              {/* Right: baton owner + primary CTA */}
              <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Baton</div>
                  <div className="text-sm font-medium text-white">
                    {liveLeadWorkstream?.runtime?.ownerAgentName ?? liveLeadLane?.ownerName ?? "Operator"}
                    <span className="text-slate-500"> · </span>
                    <span className="text-slate-300">{liveLeadLane?.label ?? liveLeadWorkstream?.workstream.laneLabel ?? "Idle"}</span>
                  </div>
                </div>

                {reviewReady ? (
                  <button
                    onClick={() => void submitReviewDecision("approve")}
                    disabled={reviewSubmitting || review.gate === "approved"}
                    className="rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Approve
                  </button>
                ) : !hasActiveExecution(workItem) && workItem.reviewStatus !== "approved" ? (
                  <button
                    onClick={() => void launchExecution()}
                    disabled={launchingExecution}
                    className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {launchingExecution ? "Launching…" : launchActionLabel(workItem)}
                  </button>
                ) : canApproveChange ? (
                  <button
                    onClick={() => void approvePausedRun()}
                    disabled={liveApprovalSubmitting}
                    className="rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {liveApprovalSubmitting ? "Approving…" : "Approve change"}
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          {/* ═══ LANE ORCHESTRA ═══ The visual heartbeat: each lane as a station in the flow */}
          {laneFlowCards.length > 0 ? (
            <section className="relative rounded-2xl border border-slate-800/70 bg-slate-950/40 p-4 md:p-5">
              {/* Animated connector line behind cards */}
              <div className="absolute left-8 right-8 top-[52px] hidden h-px xl:block live-connector-flow" />

              <div className="live-baton-rail flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory">
                {laneFlowCards.map((lane, index) => (
                  <div
                    key={lane.id}
                    className={`live-lane-enter relative min-w-[200px] max-w-[260px] flex-shrink-0 snap-start rounded-2xl border px-4 py-4 transition-all duration-300 ${laneOrchestraCardClassName(lane.status, lane.isCurrent)} ${lane.isCurrent ? "live-spotlight-glow" : "motion-safe:hover:-translate-y-1"}`}
                    style={{ animationDelay: `${index * 60}ms` }}
                  >
                    {/* Top: index + status */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold ${lane.isCurrent ? "bg-cyan-400/20 text-cyan-200 border border-cyan-400/30" : "bg-slate-800 text-slate-400 border border-slate-700"}`}>
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="text-sm font-semibold text-white">{lane.label}</span>
                      </div>
                      <span className={`h-2.5 w-2.5 rounded-full ${lane.isCurrent ? "bg-cyan-400 live-stage-dot" : laneOrchestraDotClassName(lane.status, false)}`} />
                    </div>

                    {/* Owner */}
                    <div className="mt-2 text-[11px] text-slate-400">{lane.ownerName}</div>

                    {/* Status badge */}
                    <div className="mt-3">
                      <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.14em] ${laneRuntimeClassName(lane.status)} live-status-pop`}>
                        {lane.isCurrent ? "Baton live" : laneRuntimeLabel(lane.status)}
                      </span>
                    </div>

                    {/* Active task or summary */}
                    <div className="mt-3 text-xs leading-5 text-slate-300 line-clamp-2">
                      {lane.activeTask?.title
                        ? lane.activeTask.title
                        : lane.runtime?.summary
                          ?? lane.description
                          ?? "Waiting"}
                    </div>

                    {/* Meta */}
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-slate-500">
                      {lane.tasks.length > 0 ? <span>{lane.tasks.length} tasks</span> : null}
                      {lane.status === "paused" ? <span className="text-amber-300/70">review</span> : null}
                      {lane.nextHandoff?.toWorkstreamId ? <span>→ next</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* ═══ STAGE: Spotlight + Operator Cue ═══ Two clear halves: what's happening & what to do */}
          <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
            {/* Spotlight: the baton lane in detail */}
            <section className={`relative overflow-hidden rounded-2xl border p-5 backdrop-blur ${liveSpotlightLane ? laneOrchestraCardClassName(liveSpotlightLane.status, liveSpotlightLane.isCurrent) : "border-slate-800 bg-slate-950/70"} ${liveSpotlightLane?.isCurrent ? "live-spotlight-glow" : ""}`}>
              <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />

              {liveSpotlightLane ? (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Baton spotlight</div>
                      <h3 className="mt-2 text-2xl font-semibold text-white">{liveSpotlightLane.label}</h3>
                      <div className="mt-1 text-sm text-slate-300">{liveSpotlightLane.ownerName}</div>
                    </div>
                    <div className="flex gap-2 text-[10px] uppercase tracking-[0.16em]">
                      <span className={`rounded-full border px-2.5 py-1 ${laneRuntimeClassName(liveSpotlightLane.status)}`}>
                        {laneRuntimeLabel(liveSpotlightLane.status)}
                      </span>
                    </div>
                  </div>

                  <div className="text-sm leading-7 text-slate-200">{liveSpotlightSummary}</div>

                  {/* Quick stats: prompt, commands, change, validation - compact row */}
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-white/8 bg-slate-950/60 px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{livePromptHeading}</div>
                      <div className="mt-2 text-xs leading-5 text-white line-clamp-2">{livePromptSummary}</div>
                    </div>
                    <div className="rounded-xl border border-white/8 bg-slate-950/60 px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Commands</div>
                      {liveCommandPreview.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {liveCommandPreview.slice(0, 2).map((cmd) => (
                            <div key={cmd} className="truncate font-mono text-[11px] text-slate-200">{cmd}</div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-slate-500">No commands</div>
                      )}
                    </div>
                    <div className="rounded-xl border border-white/8 bg-slate-950/60 px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Change</div>
                      <div className="mt-2 text-xs font-medium text-white">{liveChangeLabel}</div>
                    </div>
                    <div className="rounded-xl border border-white/8 bg-slate-950/60 px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Validation</div>
                      <div className={`mt-2 text-xs font-medium ${liveValidationLabel === "passed" ? "text-emerald-300" : liveValidationLabel === "failed" ? "text-rose-300" : "text-white"}`}>{liveValidationLabel}</div>
                    </div>
                  </div>

                  {/* Findings row (only if present) */}
                  {liveFindingItems.length > 0 ? (
                    <div className="space-y-2">
                      {liveFindingItems.map((item) => (
                        <div key={item} className="rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-3 text-sm leading-6 text-fuchsia-50">{item}</div>
                      ))}
                    </div>
                  ) : null}

                  {/* Handoff info */}
                  {liveLastHandoff ? (
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span className="text-slate-500">Last handoff:</span>
                      <span>{liveLastHandoff.fromWorkstreamTitle ?? liveLastHandoff.fromWorkstreamId ?? "—"}</span>
                      <span className="text-slate-600">→</span>
                      <span>{liveLastHandoff.toWorkstreamTitle ?? liveLastHandoff.toWorkstreamId ?? "Operator"}</span>
                    </div>
                  ) : null}

                  {/* Child run selector (when multi-run) */}
                  {liveChildRuns.length > 1 ? (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {liveChildRuns.slice(0, 6).map((run) => (
                        <button
                          key={run.runId}
                          type="button"
                          onClick={() => {
                            setLiveSelectedRunId(run.runId);
                            setLiveSelectionPinned(run.runId !== preferredLiveRunId);
                          }}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] transition-colors ${
                            run.runId === liveFocusedRunId
                              ? "border-cyan-300/40 bg-cyan-400/10 text-cyan-100"
                              : "border-slate-700 bg-slate-950/70 text-slate-300 hover:border-slate-600"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${run.status === "running" || run.status === "active" ? "bg-amber-300" : run.status === "paused" ? "bg-cyan-300" : run.status === "completed" || run.status === "succeeded" ? "bg-emerald-300" : run.status === "failed" ? "bg-rose-300" : "bg-slate-400"}`} />
                          {run.laneLabel}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-slate-500">No active lane to spotlight yet.</div>
              )}
            </section>

            {/* Operator Cue: the action panel */}
            <section className="rounded-2xl border border-slate-800/80 bg-slate-950/50 p-5 space-y-5">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Operator cue</div>
                  <span className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] ${missionControlToneClassName(nextAction.tone)}`}>
                    {nextAction.tone}
                  </span>
                </div>
                <div className="mt-2 text-base font-semibold text-white">{nextAction.title}</div>
                <div className="mt-2 text-sm leading-6 text-slate-400">{nextAction.body}</div>
              </div>

              {/* Review form when ready */}
              {reviewReady ? (
                <div className="space-y-3">
                  {review.headline ? (
                    <div className="rounded-xl border border-white/10 bg-slate-900/50 px-3 py-3">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Review snapshot</div>
                      <div className="mt-1.5 text-sm font-medium text-white">{review.headline}</div>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-white/10 bg-slate-950/50 px-3 py-2 text-center">
                      <div className="text-[10px] text-slate-500">Succeeded</div>
                      <div className="mt-1 text-sm font-semibold text-white">{review.totals.succeeded}</div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-slate-950/50 px-3 py-2 text-center">
                      <div className="text-[10px] text-slate-500">Open risks</div>
                      <div className="mt-1 text-sm font-semibold text-white">{review.openRisks.length}</div>
                    </div>
                  </div>
                  <textarea
                    value={reviewNote}
                    onChange={(e) => { setReviewNote(e.target.value); setReviewNoteDirty(true); }}
                    placeholder="Approval notes or follow-ups…"
                    className="h-20 w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => void submitReviewDecision("approve")}
                      disabled={reviewSubmitting || review.gate === "not_ready" || review.gate === "approved"}
                      className="flex-1 rounded-xl border border-emerald-400/40 bg-emerald-400/10 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Approve & close
                    </button>
                    <button
                      onClick={() => void submitReviewDecision("send_back")}
                      disabled={reviewSubmitting || review.gate === "approved"}
                      className="flex-1 rounded-xl border border-fuchsia-400/40 bg-fuchsia-400/10 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-200 transition-colors hover:bg-fuchsia-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Send back
                    </button>
                  </div>
                </div>
              ) : canApproveChange ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-3 text-sm text-amber-100">
                    A change is waiting for approval before the run can continue.
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void approvePausedRun()}
                      disabled={liveApprovalSubmitting}
                      className="flex-1 rounded-xl border border-emerald-400/40 bg-emerald-400/10 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:opacity-50"
                    >
                      {liveApprovalSubmitting ? "Approving…" : "Approve change"}
                    </button>
                    <button
                      onClick={() => void sendBackFromLive()}
                      disabled={liveSendBackSubmitting}
                      className="flex-1 rounded-xl border border-fuchsia-400/40 bg-fuchsia-400/10 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-200 transition-colors hover:bg-fuchsia-400/20 disabled:opacity-50"
                    >
                      Send back
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {!hasActiveExecution(workItem) && workItem.reviewStatus !== "approved" ? (
                    <button
                      onClick={() => void launchExecution()}
                      disabled={launchingExecution}
                      className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
                    >
                      {launchingExecution ? "Launching…" : launchActionLabel(workItem)}
                    </button>
                  ) : null}
                  {canResumeRun ? (
                    <button
                      onClick={() => void resumePausedRun()}
                      disabled={liveResumeSubmitting}
                      className="rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200 transition-colors hover:bg-cyan-400/20 disabled:opacity-50"
                    >
                      {liveResumeSubmitting ? "Resuming…" : "Resume run"}
                    </button>
                  ) : null}
                  {liveFocusedRunId ? (
                    <Link
                      href={`/runs/${liveFocusedRunId}?workspace=${encodeURIComponent(workItem.workspaceId)}`}
                      className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600"
                    >
                      Open run
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setDetailView("inspect")}
                    className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600"
                  >
                    Inspect
                  </button>
                </div>
              )}

              {/* Session truth table */}
              <div className="rounded-xl border border-white/8 bg-slate-950/50 px-4 py-3 space-y-2.5 text-sm">
                {liveTruthBriefRows.map((row, index) => (
                  <div key={row.label} className={`flex items-start justify-between gap-3 ${index < liveTruthBriefRows.length - 1 ? "border-b border-slate-800/60 pb-2.5" : ""}`}>
                    <span className="text-slate-500 text-xs">{row.label}</span>
                    <span className="text-right text-xs text-slate-200">{row.value}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* ═══ STORY FEED ═══ Compact live ticker: the team's recent moves */}
          <section className="rounded-2xl border border-slate-800/70 bg-slate-950/40 p-4">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Story feed</div>
                <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-0.5 text-[10px] text-slate-400">
                  {liveSignalCount} events
                </span>
              </div>
              {latestTimelineSignal ? (
                <span className="text-[10px] text-slate-500">{formatEventTimestamp(latestTimelineSignal.ts)}</span>
              ) : null}
            </div>

            {liveStageMoves.length > 0 ? (
              <div className="space-y-2">
                {liveStageMoves.map((move, index) => (
                  <div
                    key={move.id}
                    className={`live-ticker-slide flex items-start gap-3 rounded-xl border px-3 py-2.5 ${liveStoryToneClassName(move.tone)}`}
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${move.tone === "danger" ? "bg-rose-300" : move.tone === "warning" ? "bg-amber-300" : move.tone === "success" ? "bg-emerald-300" : "bg-cyan-300"} ${index === 0 ? "live-stage-dot" : ""}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-white">{move.label}</span>
                        <span className="flex-shrink-0 text-[10px] text-slate-500">{move.timeLabel}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] leading-5 text-slate-300 line-clamp-1">{move.summary}</div>
                    </div>
                    {move.meta.length > 0 ? (
                      <div className="hidden flex-shrink-0 gap-1.5 text-[10px] text-slate-500 xl:flex">
                        {move.meta.slice(0, 2).map((entry) => (
                          <span key={`${move.id}:${entry}`} className="rounded-full border border-slate-800 px-2 py-0.5">{entry}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-500">
                Story feed populates as prompts, responses, validations, and handoffs flow through.
              </div>
            )}
          </section>

          <section className="grid gap-6 xl:grid-cols-[1fr]">
            <SurfacePanel
              title="Run control and evidence"
              description="Approve, resume, pin, and inspect the child execution that currently matters without leaving Live Session."
            >
                {liveChildRuns.length > 1 ? (
                  <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Child execution</div>
                        <div className="mt-2 text-sm font-medium text-white">{liveChildExecutionSummary}</div>
                        <div className="mt-1 text-xs leading-5 text-slate-400">
                          {liveRunsAwaitingReview.length > 0
                            ? "Review-paused runs remain part of the same work item. Select the one you need to inspect without promoting Runs to the primary surface."
                            : "This work item is using more than one child run. Select the execution you want the session detail to follow."}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em]">
                        <span className={`rounded-full border px-2.5 py-1 ${liveFocusFollowsBaton ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-100"}`}>
                          {liveFocusLabel}
                        </span>
                        {liveSelectedRunCard ? <span className="text-slate-500">{liveSelectedRunCard.runId}</span> : null}
                        {!liveFocusFollowsBaton ? (
                          <button
                            type="button"
                            onClick={() => {
                              setLiveSelectionPinned(false);
                              setLiveSelectedRunId(preferredLiveRunId ?? "");
                            }}
                            className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1 text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                          >
                            Follow current baton
                          </button>
                        ) : (
                          liveFocusedRunId ? (
                            <button
                              type="button"
                              onClick={() => {
                                setLiveSelectionPinned(true);
                                setLiveSelectedRunId(liveFocusedRunId);
                              }}
                              className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1 text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                            >
                              Pin this run
                            </button>
                          ) : null
                        )}
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm leading-6 text-slate-300">
                      {liveFocusSummary}
                    </div>

                    <div className="mt-4 grid gap-3 xl:grid-cols-2">
                      {liveChildRuns.map((run) => {
                        const selected = run.runId === liveFocusedRunId;
                        return (
                          <button
                            key={run.runId}
                            type="button"
                            onClick={() => {
                              setLiveSelectedRunId(run.runId);
                              setLiveSelectionPinned(run.runId !== preferredLiveRunId);
                            }}
                            className={`relative overflow-hidden rounded-[24px] border px-4 py-4 text-left transition-all duration-300 motion-safe:hover:-translate-y-1 ${selected ? "border-cyan-300/40 bg-cyan-400/10 shadow-[0_20px_60px_rgba(8,145,178,0.16)]" : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-900"}`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-white">{run.title}</div>
                                <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                  {run.laneLabel} · {run.runId}
                                </div>
                              </div>
                              <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${taskStatusClassName(run.status)}`}>
                                {statusLabel(run.status)}
                              </span>
                            </div>
                            <div className="mt-3 text-xs leading-5 text-slate-300">{run.summary}</div>
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                              {run.pauseLabel ? <span>{run.pauseLabel}</span> : null}
                              {run.changeLabel ? <span>Diff {run.changeLabel}</span> : null}
                              {run.validationLabel ? <span>Validation {run.validationLabel}</span> : null}
                              {run.verdictLabel ? <span>Verdict {run.verdictLabel}</span> : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {liveFocusedRunId ? (
                  <div className="space-y-4">
                    {liveRunNotice ? (
                      <NoticePanel tone={liveRunNotice.tone} title={liveRunNotice.title}>
                        {liveRunNotice.body}
                      </NoticePanel>
                    ) : null}
                    <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-white">
                            {liveFocusedTask?.title ?? liveFocusedRunDetail?.run?.goal ?? liveFocusedRunId}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            {liveFocusedTask?.laneLabel ?? liveFocusedTask?.laneId ?? "Run"} · {liveFocusedRunId}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${taskStatusClassName(liveRunStatus)}`}>
                            {statusLabel(liveRunStatus)}
                          </span>
                          {canApproveChange && (
                            <button
                              type="button"
                              onClick={() => void approvePausedRun(false)}
                              disabled={liveApprovalSubmitting}
                              className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:opacity-60"
                            >
                              {liveApprovalSubmitting ? "Approving…" : "Approve change"}
                            </button>
                          )}
                          {canResumeRun && (
                            <button
                              type="button"
                              onClick={() => void resumePausedRun()}
                              disabled={liveResumeSubmitting}
                              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:opacity-60"
                            >
                              {liveResumeSubmitting ? "Resuming…" : "Resume run"}
                            </button>
                          )}
                          {canApproveChange && (
                            <button
                              type="button"
                              onClick={() => void sendBackFromLive()}
                              disabled={liveSendBackSubmitting}
                              className="rounded-lg border border-fuchsia-400/40 bg-fuchsia-400/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-fuchsia-200 transition-colors hover:bg-fuchsia-400/20 disabled:opacity-60"
                            >
                              {liveSendBackSubmitting ? "Sending…" : "Send back"}
                            </button>
                          )}
                          <Link
                            href={`/runs/${liveFocusedRunId}?workspace=${encodeURIComponent(workItem.workspaceId)}`}
                            className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                          >
                            Open run
                          </Link>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="text-lg font-semibold text-white">{liveRunProgress.percent}%</div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">Progress</div>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="text-lg font-semibold text-white">{liveRunProgress.done}/{liveRunProgress.total}</div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">Completed steps</div>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="text-lg font-semibold text-white">{liveRunLeadStep?.model ?? "Unknown"}</div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">Current model</div>
                        </div>
                      </div>

                      {liveRunLeadStep ? (
                        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium text-white">{liveRunLeadStep.stepId}</div>
                              <div className="mt-1 text-xs text-slate-500">
                                {liveRunLeadStep.provider ?? "No provider recorded"}
                                {liveRunLeadStep.model ? ` · ${liveRunLeadStep.model}` : ""}
                              </div>
                            </div>
                            <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${taskStatusClassName(liveRunLeadStep.status)}`}>
                              {statusLabel(liveRunLeadStep.status)}
                            </span>
                          </div>
                          {runStepSummary(liveRunLeadStep) ? (
                            <div className="mt-3 text-xs leading-5 text-slate-400">{runStepSummary(liveRunLeadStep)}</div>
                          ) : (
                            <div className="mt-3 text-xs leading-5 text-slate-500">No explicit step summary has been recorded yet.</div>
                          )}
                        </div>
                      ) : null}

                      {focusedPromptMoments.length > 0 ? (
                        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Prompt moments</div>
                          <div className="mt-3 space-y-2">
                            {focusedPromptMoments.map((trace) => (
                              <div key={trace.id} className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="text-xs font-medium text-white">
                                    {trace.traceType.replace(/_/g, " ")}
                                  </div>
                                  <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                    {trace.providerModel ?? "provider"}
                                  </div>
                                </div>
                                <div className="mt-2 text-xs leading-5 text-slate-300">
                                  {trace.promptSummary ?? trace.responseSummary ?? trace.outputSummary ?? trace.summary}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {(liveLeadChangeStatus || (liveRunLeadStep?.validation && liveRunLeadStep.validation.status !== "not_requested")) ? (
                        <div className="mt-4 grid gap-3 lg:grid-cols-2">
                          {liveLeadChangeStatus ? (
                            <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Diff status</div>
                              <div className="mt-2 text-sm font-medium text-white">{liveLeadChangeStatus.replace(/_/g, " ")}</div>
                              <div className="mt-2 text-xs leading-5 text-slate-400">
                                {liveRunLeadStep?.change?.applyError
                                  ?? liveRunLeadStep?.change?.diffArtifact
                                  ?? "A change was recorded for this step, but no extra diff note was attached."}
                              </div>
                            </div>
                          ) : null}

                          {liveRunLeadStep?.validation && liveRunLeadStep.validation.status !== "not_requested" ? (
                            <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Validation</div>
                              <div className="mt-2 text-sm font-medium text-white">
                                {liveRunLeadStep.validation.status.replace(/_/g, " ")}
                              </div>
                              <div className="mt-2 text-xs leading-5 text-slate-400">
                                {liveRunLeadStep.validation.summary ?? "Validation ran without a summary."}
                              </div>
                              {liveLeadValidationResults.length > 0 ? (
                                <div className="mt-3 space-y-2">
                                  {liveLeadValidationResults.map((result) => (
                                    <div key={`${result.command}:${result.exitCode ?? "none"}`} className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                                      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em]">
                                        <span className="text-slate-400">{result.command}</span>
                                        <span className={result.ok ? "text-emerald-300" : "text-rose-300"}>
                                          {result.ok ? "passed" : `failed${result.exitCode != null ? ` (${result.exitCode})` : ""}`}
                                        </span>
                                      </div>
                                      {result.summary ? (
                                        <div className="mt-2 text-xs leading-5 text-slate-400">{result.summary}</div>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {(liveRunArtifacts.length > 0 || (liveRunLeadStep?.validation?.commands?.length ?? 0) > 0) ? (
                        <div className="mt-4 grid gap-3 lg:grid-cols-[0.95fr_1.05fr]">
                          <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Commands and artifacts</div>
                            {(liveRunLeadStep?.validation?.commands?.length ?? 0) > 0 ? (
                              <div className="mt-3 space-y-2">
                                {liveRunLeadStep?.validation?.commands.map((command) => (
                                  <div key={command} className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 font-mono text-xs text-slate-200">
                                    {command}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-3 text-xs text-slate-500">
                                No explicit shell command list was recorded for this step.
                              </div>
                            )}

                            {liveRunArtifacts.length > 0 ? (
                              <div className="mt-4 flex flex-wrap gap-2">
                                {liveRunArtifacts.slice(0, 8).map((artifact) => (
                                  <button
                                    key={artifact}
                                    type="button"
                                    onClick={() => setLiveSelectedArtifact(artifact)}
                                    className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] transition-colors ${
                                      artifact === liveSelectedArtifact
                                        ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                                        : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:bg-slate-900"
                                    }`}
                                  >
                                    {artifact.split("/").at(-1) ?? artifact}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>

                          <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Changes preview</div>
                              {liveSelectedArtifact ? (
                                <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                  {liveSelectedArtifact} · {liveArtifactMimeType}
                                </div>
                              ) : null}
                            </div>
                            {liveSelectedArtifact ? (
                              liveArtifactMimeType.startsWith("image/") ? (
                                <div className="mt-3 rounded-lg border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                                  {liveSelectedArtifact} is an image artifact. Open the task run if you need full image rendering.
                                </div>
                              ) : liveArtifactContent ? (
                                <div className="mt-3 space-y-3">
                                  <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-3 font-mono text-xs leading-6 text-slate-200">
                                    {liveArtifactPreviewText}
                                  </pre>
                                  {liveArtifactContent.length > liveArtifactPreviewText.length ? (
                                    <div className="text-xs text-slate-500">
                                      Preview trimmed. Open Inspect or the task run if you need the full artifact.
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="mt-3 rounded-lg border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                                  Waiting for {liveSelectedArtifact} to be written.
                                </div>
                              )
                            ) : (
                              <div className="mt-3 rounded-lg border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                                No artifact preview is available for this step yet.
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <details className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <summary className="cursor-pointer list-none">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm font-medium text-white">Deep run evidence</div>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                            {orderedLiveRunSteps.length} step{orderedLiveRunSteps.length === 1 ? "" : "s"} · raw logs and stream
                          </div>
                        </div>
                      </summary>

                      <div className="mt-4 space-y-4">
                        <div className="space-y-3">
                          {orderedLiveRunSteps.length > 0 ? orderedLiveRunSteps.slice(0, 6).map((step) => (
                            <div key={step.stepId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <div className="text-sm font-medium text-white">{step.stepId}</div>
                                  <div className="mt-1 text-xs text-slate-500">
                                    {step.provider ?? "No provider"}
                                    {step.model ? ` · ${step.model}` : ""}
                                    {typeof step.costUsd === "number" ? ` · ${formatEstimatedCost(step.costUsd)}` : ""}
                                  </div>
                                </div>
                                <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${taskStatusClassName(step.status)}`}>
                                  {statusLabel(step.status)}
                                </span>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                                {step.change?.status ? <span>Diff {step.change.status}</span> : null}
                                {step.validation?.status ? <span>Validation {step.validation.status.replace(/_/g, " ")}</span> : null}
                                {step.verdict ? <span>Verdict {step.verdict.replace(/_/g, " ")}</span> : null}
                                {step.usage?.total_tokens ? <span>{step.usage.total_tokens.toLocaleString()} tokens</span> : null}
                              </div>
                              <div className="mt-3 text-xs leading-5 text-slate-400">
                                {runStepSummary(step) ?? "No step summary has been recorded yet."}
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                              Step state has not been recorded for this run yet.
                            </div>
                          )}
                        </div>

                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4">
                            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Latest run logs</div>
                            {liveRunLogs.length > 0 ? (
                              <pre className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3 font-mono text-xs leading-6 text-slate-200">
                                {liveRunLogs.join("\n")}
                              </pre>
                            ) : (
                              <div className="mt-3 rounded-xl border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                                No run log lines are available yet.
                              </div>
                            )}
                          </div>

                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4">
                            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Run stream</div>
                            {liveRunEvents.length > 0 ? (
                              <div className="mt-3 max-h-[320px] space-y-2 overflow-auto rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3">
                                {liveRunEvents.map((line, index) => (
                                  <div key={`${line}:${index}`} className="font-mono text-xs leading-6 text-slate-200">
                                    {line}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-3 rounded-xl border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                                Waiting for live run events. New mission activity will stream here as it lands.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </details>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                    No child run is attached to the current baton yet. Once a specialist starts a mission-backed task, the live run will appear here.
                  </div>
                )}
            </SurfacePanel>
          </section>
        </>
      ) : (

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Source Analysis</div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Source</div>
                <div className="mt-2 text-sm font-medium text-white">{detail.sourceSnapshot.label}</div>
                <div className="mt-1 text-xs text-slate-500">{detail.sourceSnapshot.sourcePath ?? "No source file"}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Sprint / PBI</div>
                <div className="mt-2 text-sm font-medium text-white">
                  {detail.sourceSnapshot.pbiId ? `${detail.sourceSnapshot.pbiId} · ${detail.sourceSnapshot.pbiTitle ?? ""}` : "Template-derived"}
                </div>
                <div className="mt-1 text-xs text-slate-500">{detail.sourceSnapshot.sprintName ?? "No sprint context"}</div>
              </div>
            </div>
            {detail.sourceSnapshot.summary && (
              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Parsed summary</div>
                <p className="mt-2 text-sm leading-6 text-slate-300">{detail.sourceSnapshot.summary}</p>
              </div>
            )}
            {detail.sourceSnapshot.warnings.length > 0 && (
              <div className="mt-4 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-fuchsia-200">Parser warnings</div>
                <div className="mt-3 space-y-2 text-sm text-fuchsia-50/90">
                  {detail.sourceSnapshot.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {currentPlan && (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Current Cycle Plan</div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${cyclePlanSourceClassName(currentPlan.source)}`}>
                      {cyclePlanSourceLabel(currentPlan.source)}
                    </span>
                    <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                      {currentPlan.tasks.length} tasks
                    </span>
                    <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                      {currentPlan.lanes.length} lanes
                    </span>
                  </div>
                  <div className="mt-3 text-lg font-medium text-white">{currentPlan.headline ?? "Execution focus"}</div>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">{currentPlan.summary}</p>
                </div>
                {workItem.currentCycleId && (
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-right">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Active cycle</div>
                    <div className="mt-1 text-sm font-medium text-white">
                      {(workItem.cycles ?? []).find((cycle) => cycle.id === workItem.currentCycleId)?.sequence ?? "Draft"}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {(workItem.cycles ?? []).find((cycle) => cycle.id === workItem.currentCycleId)?.kind ?? currentPlan.source}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                    {currentPlan.source === "remediation" ? "Cycle acceptance focus" : "Cycle acceptance criteria"}
                  </div>
                  <div className="mt-3 space-y-2 text-sm text-slate-300">
                    {(
                      currentPlan.source === "remediation" && (workItem.remediationPlan?.acceptanceDelta.length ?? 0) > 0
                        ? workItem.remediationPlan?.acceptanceDelta ?? []
                        : currentPlan.acceptanceCriteria
                    ).length > 0 ? (
                      (
                        currentPlan.source === "remediation" && (workItem.remediationPlan?.acceptanceDelta.length ?? 0) > 0
                          ? workItem.remediationPlan?.acceptanceDelta ?? []
                          : currentPlan.acceptanceCriteria
                      ).map((item) => (
                        <div key={item} className="flex gap-2">
                          <span className="text-emerald-300">•</span>
                          <span>{item}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-slate-500">No explicit cycle acceptance focus.</div>
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                    {currentPlan.source === "remediation" ? "Cycle guardrails" : "Cycle constraints"}
                  </div>
                  <div className="mt-3 space-y-2 text-sm text-slate-300">
                    {(
                      currentPlan.source === "remediation" && (workItem.remediationPlan?.constraintDelta.length ?? 0) > 0
                        ? workItem.remediationPlan?.constraintDelta ?? []
                        : currentPlan.constraints
                    ).length > 0 ? (
                      (
                        currentPlan.source === "remediation" && (workItem.remediationPlan?.constraintDelta.length ?? 0) > 0
                          ? workItem.remediationPlan?.constraintDelta ?? []
                          : currentPlan.constraints
                      ).map((item) => (
                        <div key={item} className="flex gap-2">
                          <span className="text-cyan-300">•</span>
                          <span>{item}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-slate-500">No explicit cycle guardrails.</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-3">
                {currentPlan.lanes.map((lane) => {
                  const tasks = currentPlanTasksByLane.get(lane.id) ?? [];
                  return (
                    <div key={lane.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-white">{lane.label}</div>
                          {lane.description && <div className="mt-1 text-xs text-slate-500">{lane.description}</div>}
                        </div>
                        <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                          {tasks.length}
                        </span>
                      </div>
                      <div className="mt-4 space-y-3">
                        {tasks.length === 0 && (
                          <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-500">
                            No current-cycle tasks in this lane.
                          </div>
                        )}
                        {tasks.map((task) => (
                          <div key={task.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                                {task.kind}
                              </span>
                              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                                {task.source}
                              </span>
                            </div>
                            <div className="mt-3 text-sm font-medium text-white">{task.title}</div>
                            {task.description && (
                              <div className="mt-2 text-sm text-slate-400">{task.description}</div>
                            )}
                            {task.dependsOn.length > 0 && (
                              <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
                                Depends on {task.dependsOn.join(", ")}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {currentPlan.teamAssignments.length > 0 && (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Cycle coverage</div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {currentPlan.teamAssignments.map((assignment) => (
                      <div key={assignment.laneId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium text-white">{assignment.laneLabel}</div>
                            <div className="mt-1 text-xs text-slate-500">{assignment.preferredSpecializations.join(", ") || assignment.preferredRole}</div>
                          </div>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${coverageClassName(assignment.coverage)}`}>
                            {coverageLabel(assignment.coverage)}
                          </span>
                        </div>
                        {assignment.matches[0] && (
                          <div className="mt-3 text-xs text-slate-400">
                            {assignment.matches[0].name} · {assignment.matches[0].specialization} · {assignment.matches[0].seniority}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(currentPlan.workstreams.length > 0 || currentPlan.gates.length > 0) && (
                <div className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Cycle workstreams</div>
                    <div className="mt-3 space-y-2">
                      {currentPlan.workstreams.map((workstream) => (
                        <div key={workstream.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          {(() => {
                            const runtime = workstreamRuntimeById.get(workstream.id) ?? null;
                            return (
                              <>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium text-white">{workstream.title}</div>
                              <div className="mt-1 text-xs text-slate-500">
                                {workstream.laneLabel} · {workstream.type.replace(/_/g, " ")}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {runtime && (
                                <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${laneRuntimeClassName(runtime.status)}`}>
                                  {laneRuntimeLabel(runtime.status)}
                                </span>
                              )}
                              {(runtime?.ownerAgentName ?? workstream.ownerAgentName) && (
                                <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300">
                                  {runtime?.ownerAgentName ?? workstream.ownerAgentName}
                                </span>
                              )}
                            </div>
                          </div>
                          {workstream.description && (
                            <div className="mt-2 text-xs leading-5 text-slate-400">{workstream.description}</div>
                          )}
                          <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                            <span>{workstream.taskIds.length} tasks</span>
                            {workstream.dependsOn.length > 0 && <span>Depends on {workstream.dependsOn.join(", ")}</span>}
                            {workstream.gateRefs.length > 0 && <span>Gates {workstream.gateRefs.join(", ")}</span>}
                            {runtime?.providerModel && <span>Model {runtime.providerModel}</span>}
                            <span>Prompts {runtime?.promptCount ?? 0}</span>
                            <span>Exchanges {runtime?.exchangeCount ?? 0}</span>
                            <span>Estimated cost {formatEstimatedCost(runtime?.estimatedCostUsd)}</span>
                          </div>
                          {runtime?.selectionReason && (
                            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                              Why selected: {runtime.selectionReason}
                            </div>
                          )}
                          {runtime?.summary && (
                            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                              {runtime.summary}
                            </div>
                          )}
                          {(runtime?.lastAssignmentAt || runtime?.lastResponseAt || runtime?.handoffToWorkstreamId) && (
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                              {runtime?.lastAssignmentAt && <span>Last assignment {new Date(runtime.lastAssignmentAt).toLocaleString()}</span>}
                              {runtime?.lastResponseAt && <span>Last response {new Date(runtime.lastResponseAt).toLocaleString()}</span>}
                              {runtime?.handoffToWorkstreamId && <span>Next handoff {runtime.handoffToWorkstreamId}</span>}
                            </div>
                          )}
                              </>
                            );
                          })()}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Cycle gates</div>
                    <div className="mt-3 space-y-2">
                      {currentPlan.gates.length > 0 ? currentPlan.gates.map((gate) => {
                        const runtime = gateRuntimeById.get(gate.id) ?? null;
                        return (
                          <div key={gate.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-white">{gate.label}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {gate.type.replace(/_/g, " ")} · {gate.required ? "required" : "optional"}
                                </div>
                              </div>
                              <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${gateStatusClassName(runtime?.status ?? "missing")}`}>
                                {runtime?.status ?? "missing"}
                              </span>
                            </div>
                            <div className="mt-2 text-xs leading-5 text-slate-400">
                              {runtime?.summary ?? "No gate evidence has been recorded yet."}
                            </div>
                            {runtime?.requiredBecause && (
                              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                                Required because: {runtime.requiredBecause}
                              </div>
                            )}
                            {runtime?.satisfiedBy && (
                              <div className="mt-2 text-xs text-emerald-200">Satisfied by: {runtime.satisfiedBy}</div>
                            )}
                            {runtime?.blockedBy && (
                              <div className="mt-2 text-xs text-amber-200">Blocked by: {runtime.blockedBy}</div>
                            )}
                            {runtime?.riskLevel && (
                              <div className="mt-2 text-xs text-sky-200">
                                Audit risk: <span className="uppercase">{runtime.riskLevel}</span>
                              </div>
                            )}
                            {runtime?.evidenceArtifactSummary && (
                              <div className="mt-2 text-xs text-slate-300">Evidence: {runtime.evidenceArtifactSummary}</div>
                            )}
                            {runtime?.assertionTotals && (
                              <div className="mt-2 text-xs text-slate-300">
                                Scenario assertions: {runtime.assertionTotals.passed}/{runtime.assertionTotals.total} passed
                                {runtime.assertionTotals.failed > 0 ? `, ${runtime.assertionTotals.failed} failed` : ""}
                              </div>
                            )}
                            {runtime?.contractItems && runtime.contractItems.length > 0 && (
                              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Gate contract</div>
                                <ul className="mt-2 space-y-1">
                                  {runtime.contractItems.map((item) => (
                                    <li key={item}>• {item}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {runtime?.riskReasons && runtime.riskReasons.length > 0 && (
                              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Risk reasoning</div>
                                <ul className="mt-2 space-y-1">
                                  {runtime.riskReasons.map((reason) => (
                                    <li key={reason}>• {reason}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                              {runtime?.evidenceTaskIds && runtime.evidenceTaskIds.length > 0 && (
                                <span>Evidence {runtime.evidenceTaskIds.join(", ")}</span>
                              )}
                              {runtime?.evidenceRunId && (
                                <span>Run {runtime.evidenceRunId}</span>
                              )}
                              {runtime?.blockingFindingIds && runtime.blockingFindingIds.length > 0 && (
                                <span>Blocking delivery findings {runtime.blockingFindingIds.length}</span>
                              )}
                            </div>
                          </div>
                        );
                      }) : (
                        <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-500">
                          No explicit cycle gates were planned.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {currentPlan?.source === "remediation" ? "Baseline Planning Board" : "Planning Board"}
            </div>
            <div className="mt-4 grid gap-4 xl:grid-cols-3">
              {detail.lanes.map((lane) => {
                const tasks = tasksByLane.get(lane.id) ?? [];
                return (
                  <div key={lane.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{lane.label}</div>
                        {lane.description && <div className="mt-1 text-xs text-slate-500">{lane.description}</div>}
                      </div>
                      <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                        {tasks.length}
                      </span>
                    </div>
                    <div className="mt-4 space-y-3">
                      {tasks.length === 0 && (
                        <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-500">
                          No planned tasks in this lane.
                        </div>
                      )}
                      {tasks.map((task) => (
                        <div key={task.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                              {task.kind}
                            </span>
                            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                              {task.source}
                            </span>
                          </div>
                          <div className="mt-3 text-sm font-medium text-white">{task.title}</div>
                          {task.description && (
                            <div className="mt-2 text-sm text-slate-400">{task.description}</div>
                          )}
                          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                            <span>ID {task.id}</span>
                            {task.sourceLine && <span>Line {task.sourceLine}</span>}
                          </div>
                          {task.dependsOn.length > 0 && (
                            <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
                              Depends on {task.dependsOn.join(", ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {teamRuntime && (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Supervised Team Runtime</div>
                  <div className="mt-2 text-lg font-medium text-white">{teamRuntime.headline}</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">{teamRuntime.currentStage}</div>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  {[
                    { label: "Active agents", value: teamRuntime.activeAgents },
                    { label: "Blocked lanes", value: teamRuntime.blockedLanes },
                    { label: "Completed", value: teamRuntime.completedLanes },
                    { label: "Missing", value: teamRuntime.missingCoverage }
                  ].map((item) => (
                    <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-center">
                      <div className="text-lg font-semibold text-white">{item.value}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">{item.label}</div>
                    </div>
                  ))}
                </div>
              </div>
              {teamRuntime.nextHandoff && (
                <div className="mt-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
                  Next handoff: {teamRuntime.nextHandoff}
                </div>
              )}
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {teamRuntime.lanes.map((lane) => (
                  <div key={lane.laneId} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{lane.laneLabel}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {lane.ownerAgentName ?? "No specialist matched"}
                          {lane.ownerAgentId ? ` · ${lane.ownerAgentId}` : ""}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${laneRuntimeClassName(lane.status)}`}>
                        {laneRuntimeLabel(lane.status)}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      <span>{lane.workstreamIds.length} workstreams</span>
                      {lane.activeWorkstreamId && <span>Active {lane.activeWorkstreamId}</span>}
                    </div>
                    {lane.activeWorkstreamId && (
                      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3 text-sm text-slate-200">
                        Focus: {lane.activeWorkstreamId}
                      </div>
                    )}
                    {lane.summary && (
                      <div className="mt-3 text-xs leading-5 text-slate-400">{lane.summary}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(selectedTeam.length > 0 || detail.selectionRationale.length > 0 || omittedSpecialists.length > 0) && (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Selected Team</div>
                  <div className="mt-2 text-lg font-medium text-white">Adaptive work-item team for this cycle</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">
                    This team is synthesized from the workspace specialist pool. Omitted and missing lanes stay visible so the operator can audit why the team is narrow or broad.
                  </div>
                </div>
                {traceSummary && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    {[
                      { label: "Prompts", value: traceSummary.promptCount },
                      { label: "Exchanges", value: traceSummary.exchangeCount },
                      { label: "Estimated cost", value: formatEstimatedCost(traceSummary.estimatedCostUsd) }
                    ].map((item) => (
                      <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-center">
                        <div className="text-lg font-semibold text-white">{item.value}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">{item.label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {selectedTeam.length > 0 && (
                <div className="mt-4 grid gap-4 xl:grid-cols-2">
                  {selectedTeam.map((selection) => {
                    const agent = selection.chosenAgentId
                      ? agents.find((entry) => entry.id === selection.chosenAgentId) ?? null
                      : null;
                    const traceAgent = selection.chosenAgentId
                      ? traceSummaryByAgentId.get(selection.chosenAgentId) ?? null
                      : null;
                    return (
                      <div key={selection.laneId} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium text-white">{selection.laneLabel}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {selection.chosenAgentName ?? "No specialist assigned"}
                              {selection.chosenRole ? ` · ${selection.chosenRole}` : ""}
                            </div>
                          </div>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${teamDecisionClassName(selection.decision)}`}>
                            {selection.decision}
                          </span>
                        </div>
                        <div className="mt-3 text-xs leading-5 text-slate-400">
                          {selection.selectionReason ?? selection.omissionReason ?? "The planner did not record an explicit rationale."}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                          {selection.preferredSpecializations.length > 0 && (
                            <span>{selection.preferredSpecializations.join(", ")}</span>
                          )}
                          {agent?.runtime?.providerReadiness && (
                            <span className={`rounded-full border px-2.5 py-1 uppercase tracking-[0.16em] ${providerReadinessClassName(agent.runtime.providerReadiness)}`}>
                              {providerReadinessLabel(agent.runtime.providerReadiness)}
                            </span>
                          )}
                          <span>Model {traceAgent?.providerModel ?? agent?.runtime?.currentModel ?? agent?.provider?.modelOverride ?? "unknown"}</span>
                          <span>Load {agent?.status?.activeLoad ?? agent?.status?.currentTaskIds?.length ?? 0}</span>
                          <span>Prompts {traceAgent?.promptCount ?? agent?.runtime?.promptCount ?? 0}</span>
                          <span>Exchanges {traceAgent?.exchangeCount ?? agent?.runtime?.exchangeCount ?? 0}</span>
                          <span>Estimated cost {formatEstimatedCost(traceAgent?.estimatedCostUsd ?? agent?.runtime?.estimatedCostUsd ?? null)}</span>
                        </div>
                        {agent?.runtime?.providerReadinessReason ? (
                          <div className="mt-3 text-xs text-slate-500">{agent.runtime.providerReadinessReason}</div>
                        ) : null}
                        {selection.expectedWorkstreams.length > 0 && (
                          <div className="mt-3 text-xs text-slate-500">
                            Expected workstreams: {selection.expectedWorkstreams.join(", ")}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {detail.selectionRationale.length > 0 && (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Why This Team</div>
                  <div className="mt-3 space-y-2 text-sm text-slate-300">
                    {detail.selectionRationale.map((reason) => (
                      <div key={reason} className="flex gap-2">
                        <span className="text-cyan-300">•</span>
                        <span>{reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {omittedSpecialists.length > 0 && (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Omitted Specialists</div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {omittedSpecialists.map((selection) => (
                      <div key={selection.laneId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium text-white">{selection.laneLabel}</div>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${teamDecisionClassName(selection.decision)}`}>
                            {selection.decision}
                          </span>
                        </div>
                        <div className="mt-2 text-xs leading-5 text-slate-400">
                          {selection.omissionReason ?? selection.selectionReason ?? "No omission reason was recorded."}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {state.recovery && (
            <div className="rounded-3xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-fuchsia-300/80">{recoverySectionLabel}</div>
                  <div className="mt-2 text-lg font-medium text-white">{state.recovery.headline}</div>
                  <div className="mt-2 text-sm leading-6 text-slate-300">{state.recovery.summary}</div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                    <span>Source {state.recovery.source.replace(/_/g, " ")}</span>
                    <span>Kind {state.recovery.kind.replace(/_/g, " ")}</span>
                    {state.recovery.runId && <span>Run {state.recovery.runId}</span>}
                    {state.recovery.blockingStepTitle && <span>Step {state.recovery.blockingStepTitle}</span>}
                  </div>
                </div>
                <span className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-fuchsia-200">
                  {state.recovery.status.replace(/_/g, " ")}
                </span>
              </div>

              {state.recovery.guidance.length > 0 && (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Operator steps</div>
                  <div className="mt-3 space-y-2 text-sm text-slate-300">
                    {state.recovery.guidance.map((item) => (
                      <div key={item} className="flex gap-2">
                        <span className="text-fuchsia-300">•</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Recovery artifacts</div>
                  <div className="mt-3 space-y-2">
                    {state.recovery.artifacts.length > 0 ? state.recovery.artifacts.map((artifact) => (
                      <button
                        key={`${artifact.source}:${artifact.runId ?? "run"}:${artifact.path}`}
                        type="button"
                        onClick={() => setRecoverySelectedArtifactKey(recoveryArtifactKey(artifact))}
                        className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                          recoveryArtifactKey(artifact) === recoverySelectedArtifactKey
                            ? "border-fuchsia-400/40 bg-fuchsia-400/10"
                            : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-950/90"
                        }`}
                      >
                        <div className="text-sm font-medium text-white">{artifact.label}</div>
                        <div className="mt-1 text-xs text-slate-500">{artifact.path}</div>
                        <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                          {artifact.source}
                          {artifact.runId ? ` · run ${artifact.runId}` : ""}
                          {artifact.taskId ? ` · task ${artifact.taskId}` : ""}
                        </div>
                      </button>
                    )) : (
                      <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-500">
                        No preserved recovery artifacts were recorded for this cycle.
                      </div>
                    )}
                  </div>
                  {selectedRecoveryArtifact ? (
                    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Artifact preview</div>
                        <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                          {selectedRecoveryArtifact.path} · {recoveryArtifactMimeType}
                        </div>
                      </div>
                      {recoveryArtifactMimeType.startsWith("image/") ? (
                        <div className="mt-3 rounded-lg border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                          {selectedRecoveryArtifact.path} is an image artifact. Open the linked run if you need full image rendering.
                        </div>
                      ) : recoveryArtifactContent ? (
                        <pre className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-3 font-mono text-xs leading-6 text-slate-200">
                          {recoveryArtifactContent}
                        </pre>
                      ) : (
                        <div className="mt-3 rounded-lg border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
                          Waiting for {selectedRecoveryArtifact.path} to be available for preview.
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Suggested actions</div>
                  <div className="mt-3 space-y-3">
                    {state.recovery.suggestedActions.map((action) => {
                      const actionKey = `${action.kind}:${action.runId ?? action.taskId ?? action.label}`;
                      const isRunnable =
                        (action.kind === "resume_run" && Boolean(action.runId)) ||
                        (action.kind === "retry_task" && Boolean(action.taskId));
                      const isPreviewable = action.kind === "inspect_artifact" && Boolean(action.artifactPath);
                      return (
                        <div key={actionKey} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="text-sm font-medium text-white">{action.label}</div>
                          <div className="mt-2 text-xs leading-5 text-slate-400">{action.detail}</div>
                          {action.artifactPath && (
                            <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                              Artifact {action.artifactPath}
                            </div>
                          )}
                          {(isRunnable || isPreviewable) && (
                            <button
                              onClick={() => void submitRecoveryAction(action)}
                              disabled={recoverySubmitting === actionKey}
                              className="mt-3 rounded-lg border border-fuchsia-400/40 bg-fuchsia-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-fuchsia-200 transition-colors hover:bg-fuchsia-400/20 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-500"
                            >
                              {action.kind === "resume_run"
                                ? recoverySubmitting === actionKey
                                  ? "Resuming..."
                                  : "Resume run"
                                : action.kind === "retry_task"
                                  ? recoverySubmitting === actionKey
                                    ? "Retrying..."
                                    : "Retry task"
                                  : recoverySubmitting === actionKey
                                    ? "Opening..."
                                    : "Open artifact"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Operator Readiness Signal</div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${reviewGateClassName(review.gate)}`}>
                    {reviewGateLabel(review.gate)}
                  </span>
                  <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                    {review.executionMode ?? "manual"}
                  </span>
                </div>
                <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">{review.headline}</p>
                {review.reviewedAt && (
                  <div className="mt-2 text-xs text-slate-500">Last decision at {new Date(review.reviewedAt).toLocaleString()}</div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  { label: "Succeeded", value: review.totals.succeeded },
                  { label: "Blocked", value: review.totals.blocked },
                  { label: "Failed", value: review.totals.failed }
                ].map((item) => (
                  <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-center">
                    <div className="text-lg font-semibold text-white">{item.value}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">{item.label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {review.signals.map((signal) => (
                <div key={signal.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-white">{signal.label}</div>
                    <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${signalClassName(signal.status)}`}>
                      {signalLabel(signal.status)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-slate-400">{signal.summary}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Open risks</div>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  {review.openRisks.length > 0 ? (
                    review.openRisks.map((risk) => (
                      <div key={risk} className="flex gap-2">
                        <span className="text-fuchsia-300">•</span>
                        <span>{risk}</span>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-500">No open risks are currently flagged by the review gate.</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Operator note</div>
                <textarea
                  value={reviewNote}
                  onChange={(event) => {
                    setReviewNote(event.target.value);
                    setReviewNoteDirty(true);
                  }}
                  placeholder="Capture approval notes, follow-up requests, or known risks."
                  className="mt-3 h-28 w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
                />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void submitReviewDecision("approve")}
                    disabled={reviewSubmitting || review.gate === "not_ready" || review.gate === "approved"}
                    className="rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-500"
                  >
                    Approve & close
                  </button>
                  <button
                    onClick={() => void submitReviewDecision("send_back")}
                    disabled={reviewSubmitting || review.gate === "approved"}
                    className="rounded-xl border border-fuchsia-400/40 bg-fuchsia-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-fuchsia-200 transition-colors hover:bg-fuchsia-400/20 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-500"
                  >
                    Send back
                  </button>
                </div>
              </div>
            </div>
          </div>

          {(workstreamTrace.length > 0 || handoffRuntime.length > 0) && (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Prompt & Cost Trace</div>
                  <div className="mt-2 text-lg font-medium text-white">Assignment, provider, cost, and handoff trail</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">
                    Expand a workstream to inspect the assignment prompt, final provider prompt, final response, and the handoff chain that moved the cycle forward.
                  </div>
                </div>
              </div>

              {handoffRuntime.length > 0 && (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Handoffs</div>
                  <div className="mt-3 space-y-2">
                    {handoffRuntime.map((handoff) => (
                      <div key={handoff.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm font-medium text-white">
                            {handoff.fromWorkstreamTitle ?? handoff.fromWorkstreamId ?? "Unassigned"} → {handoff.toWorkstreamTitle ?? handoff.toWorkstreamId ?? "Operator"}
                          </div>
                          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                            {new Date(handoff.at).toLocaleString()}
                          </div>
                        </div>
                        <div className="mt-2 text-xs leading-5 text-slate-400">{handoff.summary}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {workstreamTrace.length > 0 && (
                <div className="mt-4 space-y-3">
                  {workstreamTrace.map((group) => (
                    <details key={`${group.cycleId ?? "cycle"}:${group.workstreamId ?? "unassigned"}`} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                      <summary className="cursor-pointer list-none">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-white">
                              {group.workstreamTitle ?? group.laneLabel ?? "Cycle trace"}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              {group.ownerAgentName ?? "Unassigned"}
                              {group.laneLabel ? ` · ${group.laneLabel}` : ""}
                              {group.cycleId ? ` · ${group.cycleId}` : ""}
                            </div>
                          </div>
                          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                            {group.traces.length} trace event{group.traces.length !== 1 ? "s" : ""}
                          </div>
                        </div>
                      </summary>
                      <div className="mt-4 space-y-3">
                        {group.traces.map((trace) => (
                          <div key={trace.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300">
                                  {trace.traceType.replace(/_/g, " ")}
                                </span>
                                {trace.providerModel && (
                                  <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300">
                                    {trace.providerModel}
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                                {new Date(trace.ts).toLocaleString()}
                              </div>
                            </div>
                            <div className="mt-2 text-sm text-slate-200">{trace.summary}</div>
                            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                              <span>Prompts {trace.promptCountDelta ?? 0}</span>
                              <span>Exchanges {trace.exchangeCountDelta ?? 0}</span>
                              <span>Estimated cost {formatEstimatedCost(trace.estimatedCostUsd ?? null)}</span>
                            </div>
                            {trace.assignmentPrompt && (
                              <details className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3">
                                <summary className="cursor-pointer text-xs font-medium text-cyan-200">Assignment prompt</summary>
                                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-slate-300">{trace.assignmentPrompt}</pre>
                              </details>
                            )}
                            {trace.promptRaw && (
                              <details className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3">
                                <summary className="cursor-pointer text-xs font-medium text-cyan-200">
                                  Final provider prompt
                                  {trace.promptSummary ? ` · ${trace.promptSummary}` : ""}
                                </summary>
                                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-slate-300">{trace.promptRaw}</pre>
                              </details>
                            )}
                            {trace.responseRaw && (
                              <details className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3">
                                <summary className="cursor-pointer text-xs font-medium text-emerald-200">
                                  Final response
                                  {trace.responseSummary ? ` · ${trace.responseSummary}` : ""}
                                </summary>
                                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-slate-300">{trace.responseRaw}</pre>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}

          {workItem.remediationPlan && (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Remediation Plan</div>
                  <div className="mt-2 text-lg font-medium text-white">{workItem.remediationPlan.summary}</div>
                  {workItem.remediationPlan.note && (
                    <div className="mt-2 text-sm leading-6 text-slate-400">{workItem.remediationPlan.note}</div>
                  )}
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${
                  workItem.remediationPlan.status === "resolved"
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                    : workItem.remediationPlan.status === "launched"
                      ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                      : "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200"
                }`}>
                  {workItem.remediationPlan.status}
                </span>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Target lanes</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {workItem.remediationPlan.laneIds.map((laneId) => (
                      <span key={laneId} className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300">
                        {laneId}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4 text-xs text-slate-500">
                    {workItem.remediationPlan.taskIds.length} remediation task{workItem.remediationPlan.taskIds.length !== 1 ? "s" : ""}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Rationale</div>
                  <div className="mt-3 space-y-2 text-sm text-slate-300">
                    {workItem.remediationPlan.rationale.length > 0 ? (
                      workItem.remediationPlan.rationale.map((item) => (
                        <div key={item} className="flex gap-2">
                          <span className="text-fuchsia-300">•</span>
                          <span>{item}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-slate-500">No synthesized rationale was recorded.</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Planned remediation tasks</div>
                <div className="mt-3 space-y-2">
                  {workItem.remediationPlan.tasks.map((task) => (
                    <div key={task.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                          {task.laneLabel}
                        </span>
                        <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                          {task.kind}
                        </span>
                      </div>
                      <div className="mt-2 text-sm font-medium text-white">{task.title}</div>
                      {task.dependsOn.length > 0 && (
                        <div className="mt-2 text-xs text-slate-500">Depends on {task.dependsOn.join(", ")}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {optimization && optimization.cycles.length > 0 && (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Review Optimization</div>
                  <div className="mt-2 text-lg font-medium text-white">Cycle-derived prompt, strategy, and follow-up suggestions</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">
                    Generated only from completed cycle evidence, review signals, and browser / validation outcomes.
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {[
                    { label: "Prompt suggestions", value: optimization.cycles.reduce((total, cycle) => total + cycle.promptSuggestions.filter((entry) => entry.status === "pending").length, 0) },
                    { label: "Strategies", value: optimization.cycles.reduce((total, cycle) => total + (cycle.strategyRecommendation?.status === "pending" ? 1 : 0), 0) },
                    { label: "Opportunities", value: optimization.cycles.reduce((total, cycle) => total + cycle.opportunities.filter((entry) => entry.status === "pending").length, 0) }
                  ].map((item) => (
                    <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-center">
                      <div className="text-lg font-semibold text-white">{item.value}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">{item.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 space-y-4">
                {optimization.cycles.map((cycle) => (
                  <div key={cycle.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-white">
                          Cycle {cycle.sequence} · {cycle.sourceStatus.replace(/_/g, " ")}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          Generated {new Date(cycle.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${optimizationStatusClassName(cycle.sourceStatus === "approved" ? "approved" : "pending")}`}>
                        {cycle.sourceStatus}
                      </span>
                    </div>

                    {cycle.promptSuggestions.length > 0 && (
                      <div className="mt-4 space-y-2">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Prompt suggestions</div>
                        {cycle.promptSuggestions.map((suggestion) => (
                          <div key={suggestion.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-white">{suggestion.label}</div>
                                <div className="mt-1 text-xs text-slate-500">{suggestion.promptPath}</div>
                              </div>
                              <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${optimizationStatusClassName(suggestion.status)}`}>
                                {suggestion.status}
                              </span>
                            </div>
                            <div className="mt-3 space-y-1 text-xs leading-5 text-slate-400">
                              {suggestion.rationale.map((item) => (
                                <div key={item}>• {item}</div>
                              ))}
                            </div>
                            {suggestion.status === "pending" && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  onClick={() => void submitOptimizationAction({
                                    kind: "prompt",
                                    action: "approve",
                                    cycleId: cycle.id,
                                    itemId: suggestion.id,
                                    successTitle: "Prompt suggestion approved"
                                  })}
                                  className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-emerald-200"
                                >
                                  Approve
                                </button>
                                <button
                                  onClick={() => void submitOptimizationAction({
                                    kind: "prompt",
                                    action: "reject",
                                    cycleId: cycle.id,
                                    itemId: suggestion.id,
                                    successTitle: "Prompt suggestion rejected"
                                  })}
                                  className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-200"
                                >
                                  Reject
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {cycle.strategyRecommendation && (
                      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Strategy recommendation</div>
                            <div className="mt-2 text-sm font-medium text-white">{cycle.strategyRecommendation.mode}</div>
                          </div>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${optimizationStatusClassName(cycle.strategyRecommendation.status)}`}>
                            {cycle.strategyRecommendation.status}
                          </span>
                        </div>
                        <div className="mt-3 space-y-1 text-xs leading-5 text-slate-400">
                          {cycle.strategyRecommendation.rationale.map((item) => (
                            <div key={item}>• {item}</div>
                          ))}
                        </div>
                        {cycle.strategyRecommendation.status === "pending" && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              onClick={() => void submitOptimizationAction({
                                kind: "strategy",
                                action: "approve",
                                cycleId: cycle.id,
                                itemId: cycle.strategyRecommendation!.id,
                                successTitle: "Workspace strategy updated"
                              })}
                              className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-emerald-200"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => void submitOptimizationAction({
                                kind: "strategy",
                                action: "reject",
                                cycleId: cycle.id,
                                itemId: cycle.strategyRecommendation!.id,
                                successTitle: "Strategy recommendation rejected"
                              })}
                              className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-200"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {cycle.opportunities.length > 0 && (
                      <div className="mt-4 space-y-2">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Follow-up opportunities</div>
                        {cycle.opportunities.map((opportunity) => (
                          <div key={opportunity.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-white">{opportunity.title}</div>
                                <div className="mt-1 text-xs text-slate-400">{opportunity.description}</div>
                              </div>
                              <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${optimizationStatusClassName(opportunity.status)}`}>
                                {opportunity.status}
                              </span>
                            </div>
                            <div className="mt-3 text-xs text-slate-500">Risk score {opportunity.riskScore.toFixed(2)}</div>
                            {opportunity.status === "pending" && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  onClick={() => void submitOptimizationAction({
                                    kind: "opportunity",
                                    action: "convert",
                                    cycleId: cycle.id,
                                    itemId: opportunity.id,
                                    successTitle: "Draft work item created"
                                  })}
                                  className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-cyan-200"
                                >
                                  Convert to draft
                                </button>
                                <button
                                  onClick={() => void submitOptimizationAction({
                                    kind: "opportunity",
                                    action: "reject",
                                    cycleId: cycle.id,
                                    itemId: opportunity.id,
                                    successTitle: "Opportunity rejected"
                                  })}
                                  className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-200"
                                >
                                  Reject
                                </button>
                              </div>
                            )}
                            {opportunity.convertedWorkItemId && (
                              <div className="mt-3">
                                <Link
                                  href={`/work/${opportunity.convertedWorkItemId}?workspace=${encodeURIComponent(workItem.workspaceId)}`}
                                  className="inline-flex rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-200"
                                >
                                  Open derived work item
                                </Link>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Execution Queue</div>
            <div className="mt-4 space-y-3">
              {sortedRelatedTasks.length > 0 ? (
                sortedRelatedTasks.map((task) => (
                  <div key={task.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{task.title}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {task.laneLabel ?? task.laneId ?? "General"} · {task.type} · {agentNames.get(task.assignedToAgentId) ?? task.assignedToAgentId}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${statusClassName(task.status)}`}>
                        {statusLabel(task.status)}
                      </span>
                    </div>
                    {task.dependsOnTaskIds && task.dependsOnTaskIds.length > 0 && (
                      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
                        Depends on {task.dependsOnTaskIds.join(", ")}
                      </div>
                    )}
                    {task.waitingOnTaskIds && task.waitingOnTaskIds.length > 0 && (
                      <div className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100">
                        Waiting on {task.waitingOnTaskIds.join(", ")}
                      </div>
                    )}
                    {task.blockedByTaskIds && task.blockedByTaskIds.length > 0 && (
                      <div className="mt-3 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-2 text-xs text-fuchsia-100">
                        Blocked by {task.blockedByTaskIds.join(", ")}
                      </div>
                    )}
                    {task.resultSummary && (
                      <div className="mt-3 text-xs leading-5 text-slate-400">{task.resultSummary}</div>
                    )}
                    {task.linkedRunId && (
                      <div className="mt-3">
                        <Link
                          href={`/runs/${task.linkedRunId}?workspace=${encodeURIComponent(workItem.workspaceId)}`}
                          className="inline-flex rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                        >
                          Open task run
                        </Link>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                  {workItem.executionMode === "task_graph"
                    ? "This work item has not produced execution tasks yet."
                    : "This work item is currently using mission-run execution."}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Team Coverage</div>
            <div className="mt-4 space-y-3">
              {detail.teamAssignments.map((assignment) => (
                <div key={assignment.laneId} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-white">{assignment.laneLabel}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        Role `{assignment.preferredRole}` · prefers {assignment.preferredSpecializations.join(", ")}
                      </div>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${coverageClassName(assignment.coverage)}`}>
                      {coverageLabel(assignment.coverage)}
                    </span>
                  </div>

                  {assignment.note && (
                    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
                      {assignment.note}
                    </div>
                  )}

                  <div className="mt-3 space-y-2">
                    {assignment.matches.length > 0 ? (
                      assignment.matches.map((match) => (
                        <div key={match.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium text-white">{match.name}</div>
                              <div className="mt-1 text-xs text-slate-500">
                                {match.specialization} · {match.seniority} · {match.role}
                              </div>
                            </div>
                            <div className="text-right text-[11px] text-slate-500">
                              <div>{match.state}</div>
                              <div className="mt-1">{match.maxParallelWork} slots</div>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-500">
                        No matching agents configured for this lane yet.
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {(workItem.cycles?.length ?? 0) > 0 && (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Cycle History</div>
              <div className="mt-4 space-y-3">
                {workItem.cycles?.slice().sort((left, right) => right.sequence - left.sequence).map((cycle) => (
                  <div key={cycle.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">
                          Cycle {cycle.sequence} · {cycle.kind}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {cycle.executionMode ?? "manual"} · started {new Date(cycle.startedAt).toLocaleString()}
                          {cycle.endedAt ? ` · ended ${new Date(cycle.endedAt).toLocaleString()}` : ""}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${cycleStatusClassName(cycle.status)}`}>
                        {cycleStatusLabel(cycle.status)}
                      </span>
                    </div>
                    {cycle.summary && (
                      <div className="mt-3 text-xs leading-5 text-slate-400">{cycle.summary}</div>
                    )}
                    {cycle.plan && (
                      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${cyclePlanSourceClassName(cycle.plan.source)}`}>
                            {cyclePlanSourceLabel(cycle.plan.source)}
                          </span>
                          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                            {cycle.plan.tasks.length} tasks
                          </span>
                          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                            {cycle.plan.lanes.length} lanes
                          </span>
                        </div>
                        <div className="mt-3 text-sm font-medium text-white">{cycle.plan.headline ?? cycle.plan.summary}</div>
                        {cycle.plan.acceptanceCriteria.length > 0 && (
                          <div className="mt-2 text-xs leading-5 text-slate-400">
                            {cycle.plan.acceptanceCriteria.slice(0, 3).join(" ")}
                          </div>
                        )}
                      </div>
                    )}
                    {cycle.operatorNote && (
                      <div className="mt-3 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-2 text-xs text-fuchsia-100">
                        {cycle.operatorNote}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                      {cycle.linkedRunId && <span>Run {cycle.linkedRunId}</span>}
                      {(cycle.linkedTaskIds?.length ?? 0) > 0 && <span>{cycle.linkedTaskIds?.length} tasks</span>}
                      <span>Trigger {cycle.trigger}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Acceptance & Constraints</div>
            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-1">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Acceptance criteria</div>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  {detail.acceptanceCriteria.length > 0 ? (
                    detail.acceptanceCriteria.map((item) => (
                      <div key={item} className="flex gap-2">
                        <span className="text-emerald-300">•</span>
                        <span>{item}</span>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-500">No explicit acceptance criteria.</div>
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Constraints</div>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  {detail.constraints.length > 0 ? (
                    detail.constraints.map((item) => (
                      <div key={item} className="flex gap-2">
                        <span className="text-cyan-300">•</span>
                        <span>{item}</span>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-500">No explicit constraints.</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {currentPlan?.source === "remediation" ? "Cycle Execution Outline" : "Execution Outline"}
            </div>
            <div className="mt-4 space-y-3">
              {(currentPlan?.executionSteps ?? detail.executionSteps).map((step) => (
                <div key={step.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                      {step.role}
                    </span>
                    <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                      {step.executor}
                    </span>
                    {step.phase && (
                      <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                        {step.phase}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-sm font-medium text-white">{step.title}</div>
                  {step.dependsOn.length > 0 && (
                    <div className="mt-2 text-xs text-slate-500">Depends on {step.dependsOn.join(", ")}</div>
                  )}
                  {step.acceptanceCriteria.length > 0 && (
                    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
                      {step.acceptanceCriteria.join(" ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      )}
      <style jsx>{`
        @keyframes liveStageFloat {
          0%, 100% {
            transform: translate3d(0, 0, 0);
            opacity: 0.3;
          }
          50% {
            transform: translate3d(0, 14px, 0);
            opacity: 0.5;
          }
        }

        @keyframes liveBatonPulse {
          0%, 100% {
            opacity: 0.72;
            box-shadow: 0 0 0 0 rgba(34, 211, 238, 0);
            transform: scale(1);
          }
          50% {
            opacity: 1;
            box-shadow: 0 0 0 10px rgba(34, 211, 238, 0);
            transform: scale(1.05);
          }
        }

        @keyframes liveSignalSweep {
          0% {
            transform: translateY(-50%) translateX(-10%);
            opacity: 0;
          }
          18% {
            opacity: 0.72;
          }
          55% {
            opacity: 0.4;
          }
          100% {
            transform: translateY(-50%) translateX(260%);
            opacity: 0;
          }
        }

        @keyframes liveCorePulse {
          0%, 100% {
            transform: scale(0.88);
            opacity: 0.55;
          }
          50% {
        @keyframes liveRailFlow {
          0% {
            transform: translateX(-14%);
            opacity: 0;
          }
          18% {
            opacity: 0.74;
          }
          62% {
            opacity: 0.38;
          }
          100% {
            transform: translateX(118%);
            opacity: 0;
          }
        }
            transform: scale(1.02);
            opacity: 0.95;
          }
        .live-baton-rail {
          position: relative;
          scrollbar-width: none;
        }
        .live-baton-rail::-webkit-scrollbar {
          display: none;
        }
        .live-baton-rail::before {
          content: "";
          position: absolute;
          left: 1.5rem;
          right: 1.5rem;
          top: 2.7rem;
          height: 1px;
          background: linear-gradient(90deg, rgba(51, 65, 85, 0.22), rgba(125, 211, 252, 0.28), rgba(51, 65, 85, 0.22));
          pointer-events: none;
        }
        .live-baton-rail::after {
          content: "";
          position: absolute;
          left: 1.5rem;
          top: 2.7rem;
          height: 1px;
          width: min(18%, 180px);
          min-width: 110px;
          background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.82), transparent);
          animation: liveRailFlow 5.4s ease-in-out infinite;
          pointer-events: none;
        }
        .live-baton-node {
          isolation: isolate;
        }
        .live-baton-node::before {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), transparent 48%);
          opacity: 0.85;
          pointer-events: none;
        }
        }

        .live-stage-float {
          animation: liveStageFloat 10s ease-in-out infinite;
        }

        .live-stage-glow {
          animation: liveStageFloat 8s ease-in-out infinite;
        }

        .live-stage-dot {
          animation: liveBatonPulse 2.6s ease-in-out infinite;
        }

        .live-baton-core {
          animation: liveCorePulse 2.8s ease-in-out infinite;
        }

        .live-stage-track::before {
          content: "";
          position: absolute;
          left: 6%;
          right: 6%;
          top: 50%;
          height: 1px;
          background: linear-gradient(90deg, rgba(51, 65, 85, 0.2), rgba(125, 211, 252, 0.25), rgba(51, 65, 85, 0.2));
          transform: translateY(-50%);
        }

        .live-stage-track::after {
          content: "";
          position: absolute;
          left: 6%;
          width: 28%;
          top: 50%;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.78), transparent);
          transform: translateY(-50%);
          animation: liveSignalSweep 4.6s ease-in-out infinite;
        }

        .live-stage-current::after {
          content: "";
          position: absolute;
          inset: -1px;
          border-radius: 24px;
          border: 1px solid rgba(125, 211, 252, 0.25);
          box-shadow: 0 0 0 0 rgba(34, 211, 238, 0);
          animation: liveBatonPulse 2.9s ease-in-out infinite;
          pointer-events: none;
        }

        @media (max-width: 1535px) {
          .live-stage-track::before,
          .live-stage-track::after {
            display: none;
          }
        }
        @media (max-width: 767px) {
          .live-baton-rail::before,
          .live-baton-rail::after {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .live-stage-float,
          .live-stage-glow,
          .live-stage-dot,
          .live-baton-core,
          .live-stage-current::after,
          .live-stage-track::after,
          .live-baton-rail::after {
            animation: none;
          }
        }
      `}</style>
    </main>
  );
}
