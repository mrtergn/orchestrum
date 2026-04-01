"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  WorkItemDetailResponse,
  WorkItemCyclePlan,
  WorkItemPlanningDetail,
  WorkItemRecord,
  WorkItemReviewSummary,
  WorkPlanTask
} from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";
import {
  buildWorkItemTeamRuntime,
  type RuntimeAgentRecord,
  type WorkItemLaneRuntimeStatus
} from "@/lib/workRuntime";

function statusClassName(status: string) {
  switch (status) {
    case "running":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
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
  if (status === "ready_for_review") return "Ready for review";
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function sourceLabel(sourceType: string) {
  switch (sourceType) {
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

function laneRuntimeClassName(status: WorkItemLaneRuntimeStatus) {
  switch (status) {
    case "running":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "blocked":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "waiting":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
    case "completed":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "missing":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function laneRuntimeLabel(status: WorkItemLaneRuntimeStatus) {
  if (status === "missing") return "Missing coverage";
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

type DetailState = {
  workItem: WorkItemRecord;
  detail: WorkItemPlanningDetail;
  currentPlan: WorkItemCyclePlan | null;
  review: WorkItemReviewSummary;
};

type RelatedTask = {
  id: string;
  title: string;
  type: string;
  status: string;
  assignedToAgentId: string;
  laneId?: string;
  laneLabel?: string;
  dependsOnTaskIds?: string[];
  waitingOnTaskIds?: string[];
  blockedByTaskIds?: string[];
  linkedRunId?: string;
  resultSummary?: string;
};

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
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (queryWorkspaceId && queryWorkspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(queryWorkspaceId);
    }
  }, [queryWorkspaceId, selectedWorkspaceId, setSelectedWorkspaceId]);

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
            review: payload.review
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

  const sortedRelatedTasks = useMemo(
    () => relatedTasks.slice().sort((left, right) => left.title.localeCompare(right.title)),
    [relatedTasks]
  );

  const teamRuntime = useMemo(() => {
    if (!state) return null;
    const activePlan = state.currentPlan ?? {
      lanes: state.detail.lanes,
      tasks: state.detail.tasks,
      teamAssignments: state.detail.teamAssignments
    };
    return buildWorkItemTeamRuntime({
      lanes: activePlan.lanes,
      assignments: activePlan.teamAssignments,
      plannedTasks: activePlan.tasks,
      tasks: relatedTasks,
      agents,
      review: state.review
    });
  }, [agents, relatedTasks, state]);

  const submitReviewDecision = async (decision: "approve" | "send_back") => {
    if (!state) return;
    setReviewSubmitting(true);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(state.workItem.id)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: state.workItem.workspaceId,
          decision,
          note: reviewNote
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
      setRefreshKey((value) => value + 1);
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Review action failed",
        message: error instanceof Error ? error.message : String(error)
      });
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
            Back to intake
          </Link>
        </section>
      </main>
    );
  }

  const { workItem, detail, currentPlan, review } = state;

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
                Back to intake
              </Link>
              {workItem.brief.sourceType === "pbi" && detail.sourceSnapshot.sourcePath && (
                <Link
                  href={`/work/sprint?workspace=${encodeURIComponent(workItem.workspaceId)}&sourcePath=${encodeURIComponent(detail.sourceSnapshot.sourcePath)}`}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400 transition-colors hover:border-slate-600 hover:bg-slate-900"
                >
                  Open sprint
                </Link>
              )}
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                {sourceLabel(workItem.brief.sourceType)}
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
            {(workItem.linkedTaskIds?.length ?? 0) > 0 && (
              <Link
                href={`/tasks?workItem=${encodeURIComponent(workItem.id)}`}
                className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Open tasks
              </Link>
            )}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-right">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Mission template</div>
              <div className="mt-1 text-sm font-medium text-white">{detail.template.name}</div>
              <div className="mt-1 text-xs text-slate-500">{detail.template.id}</div>
            </div>
          </div>
        </div>
      </section>

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
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Agile Team Runtime</div>
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
                          {lane.owner?.name ?? lane.ownerMatch?.name ?? "No agent matched"}
                          {(lane.owner?.profile?.specialization ?? lane.ownerMatch?.specialization)
                            ? ` · ${lane.owner?.profile?.specialization ?? lane.ownerMatch?.specialization}`
                            : ""}
                          {(lane.owner?.profile?.seniority ?? lane.ownerMatch?.seniority)
                            ? ` · ${lane.owner?.profile?.seniority ?? lane.ownerMatch?.seniority}`
                            : ""}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${laneRuntimeClassName(lane.status)}`}>
                        {laneRuntimeLabel(lane.status)}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      <span>{lane.plannedTaskCount} planned</span>
                      <span>{lane.runtimeTaskCount} queued</span>
                      <span>{lane.succeededTaskCount} done</span>
                    </div>
                    {lane.activeTaskTitle && (
                      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3 text-sm text-slate-200">
                        Focus: {lane.activeTaskTitle}
                      </div>
                    )}
                    {lane.dependsOnLanes.length > 0 && (
                      <div className="mt-3 text-xs text-slate-500">
                        Depends on {lane.dependsOnLanes.join(", ")}
                      </div>
                    )}
                    {lane.waitingOn && lane.waitingOn.length > 0 && (
                      <div className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100">
                        Waiting on {lane.waitingOn.join(", ")}
                      </div>
                    )}
                    {lane.blockedBy && lane.blockedBy.length > 0 && (
                      <div className="mt-3 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-2 text-xs text-fuchsia-100">
                        Blocked by {lane.blockedBy.join(", ")}
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

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Final Review</div>
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
    </main>
  );
}
