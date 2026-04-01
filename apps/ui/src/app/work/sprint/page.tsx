"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkItemRecord,
  WorkSprintBurndownPoint,
  WorkSprintControlActionReport,
  WorkSprintControlActionResponse,
  WorkSprintLaunchCandidate,
  WorkSprintSupervisorResponse,
  WorkItemSprintImportResponse,
  WorkSprintControl,
  WorkSprintControlPbi,
  WorkSprintControlResponse
} from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";
import {
  buildSprintTeamRuntime,
  type RuntimeAgentRecord,
  type RuntimeTaskRecord
} from "@/lib/workRuntime";

function pbiStateClassName(state: string) {
  switch (state) {
    case "completed":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "review":
      return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
    case "running":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "blocked":
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
    case "ready":
      return "border-sky-400/30 bg-sky-400/10 text-sky-200";
    default:
      return "border-slate-700 bg-slate-900/60 text-slate-300";
  }
}

function pbiStateLabel(state: string) {
  if (state === "unimported") return "Unimported";
  return state.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function candidateDispositionClassName(disposition: string) {
  switch (disposition) {
    case "selected":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "deferred":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    default:
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
  }
}

function renderBurndownPolyline(points: WorkSprintBurndownPoint[], key: "remaining" | "completed" | "active", maxValue: number) {
  if (points.length === 0 || maxValue <= 0) return "";
  return points.map((point, index) => {
    const x = points.length === 1 ? 0 : (index / (points.length - 1)) * 100;
    const value = point[key];
    const y = 100 - (value / maxValue) * 100;
    return `${x},${y}`;
  }).join(" ");
}

function agentStateClassName(state: string) {
  switch (state) {
    case "active":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "idle":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "sleeping":
      return "border-slate-700 bg-slate-900/60 text-slate-300";
    default:
      return "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200";
  }
}

type SprintControlState = {
  control: WorkSprintControl;
};

type WorkItemStartResponse = {
  ok?: boolean;
  error?: string;
  workItem?: WorkItemRecord;
};

export default function SprintControlRoomPage() {
  const searchParams = useSearchParams();
  const { selectedWorkspaceId, setSelectedWorkspaceId, pushToast } = useAppUi();
  const queryWorkspaceId = searchParams.get("workspace") ?? "";
  const sourcePath = searchParams.get("sourcePath") ?? "";
  const workspaceId = queryWorkspaceId || selectedWorkspaceId;
  const [state, setState] = useState<SprintControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPbiId, setBusyPbiId] = useState("");
  const [runtimeBusy, setRuntimeBusy] = useState<"" | "launch_next_ready" | "fill_wip">("");
  const [targetWip, setTargetWip] = useState(2);
  const [maxAutoLaunchPerAction, setMaxAutoLaunchPerAction] = useState(2);
  const [blockLaunchWhenReviewPending, setBlockLaunchWhenReviewPending] = useState(true);
  const [allowImportDuringAutoLaunch, setAllowImportDuringAutoLaunch] = useState(true);
  const [lastReport, setLastReport] = useState<WorkSprintControlActionReport | null>(null);
  const [agents, setAgents] = useState<RuntimeAgentRecord[]>([]);
  const [tasks, setTasks] = useState<RuntimeTaskRecord[]>([]);
  const [backgroundSupervisorEnabled, setBackgroundSupervisorEnabled] = useState(false);
  const [supervisorBusy, setSupervisorBusy] = useState(false);

  useEffect(() => {
    if (queryWorkspaceId && queryWorkspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(queryWorkspaceId);
    }
  }, [queryWorkspaceId, selectedWorkspaceId, setSelectedWorkspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId || !sourcePath) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({
        workspace: workspaceId,
        sourcePath
      });
      const [controlRes, agentRes, taskRes] = await Promise.all([
        fetch(`/api/work-items/sprint-control?${query.toString()}`, { cache: "no-store" }),
        fetch(`/api/agents?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }),
        fetch(`/api/tasks?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
      ]);
      const payload = (await controlRes.json().catch(() => ({}))) as WorkSprintControlResponse;
      const agentPayload = await agentRes.json().catch(() => ({ agents: [] }));
      const taskPayload = await taskRes.json().catch(() => ({ tasks: [] }));
      if (!controlRes.ok || !payload.ok || !payload.control) {
        throw new Error(payload.error ?? "Sprint control room could not be loaded");
      }
      setState({ control: payload.control });
      setAgents(Array.isArray(agentPayload.agents) ? agentPayload.agents as RuntimeAgentRecord[] : []);
      setTasks(Array.isArray(taskPayload.tasks) ? taskPayload.tasks as RuntimeTaskRecord[] : []);
      setTargetWip(payload.control.governance.targetWip);
      setMaxAutoLaunchPerAction(payload.control.governance.maxAutoLaunchPerAction);
      setBlockLaunchWhenReviewPending(payload.control.governance.blockLaunchWhenReviewPending);
      setAllowImportDuringAutoLaunch(payload.control.governance.allowImportDuringAutoLaunch);
      setBackgroundSupervisorEnabled(payload.control.supervisor.enabled);
      setLastReport((current) => current ?? payload.control?.supervisor.lastReport ?? null);
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Sprint control unavailable",
        message: error instanceof Error ? error.message : String(error)
      });
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [pushToast, sourcePath, workspaceId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 8000);
    return () => clearInterval(timer);
  }, [load]);

  const runImport = useCallback(async (pbiIds: string[], launchAfterImport = false) => {
    if (!workspaceId || !sourcePath || pbiIds.length === 0) return;
    setBusyPbiId(pbiIds[0] ?? "batch");
    try {
      const res = await fetch("/api/work-items/sprint-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          sourcePath,
          pbiIds
        })
      });
      const payload = (await res.json().catch(() => ({}))) as Partial<WorkItemSprintImportResponse> & { error?: string };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? "Import failed");
      }
      const created = Array.isArray(payload.created) ? payload.created : [];
      if (launchAfterImport && created[0]) {
        const launchRes = await fetch(`/api/work-items/${created[0].id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId })
        });
        const launchPayload = (await launchRes.json().catch(() => ({}))) as WorkItemStartResponse;
        if (!launchRes.ok || !launchPayload.ok) {
          throw new Error(launchPayload.error ?? "Import succeeded but launch failed");
        }
      }
      pushToast({
        tone: "success",
        title: launchAfterImport ? "PBI imported and launched" : "PBI imported",
        message: `${created.length} work item${created.length !== 1 ? "s" : ""} created.`
      });
      await load();
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Sprint action failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setBusyPbiId("");
    }
  }, [load, pushToast, sourcePath, workspaceId]);

  const runLaunch = useCallback(async (workItemId: string, title: string) => {
    if (!workspaceId) return;
    setBusyPbiId(workItemId);
    try {
      const res = await fetch(`/api/work-items/${workItemId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId })
      });
      const payload = (await res.json().catch(() => ({}))) as WorkItemStartResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? "Launch failed");
      }
      pushToast({
        tone: "success",
        title: "PBI launched",
        message: title
      });
      await load();
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Launch failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setBusyPbiId("");
    }
  }, [load, pushToast, workspaceId]);

  const runSprintAction = useCallback(async (
    action: "launch_next_ready" | "fill_wip",
    options?: { silent?: boolean }
  ) => {
    if (!workspaceId || !sourcePath) return;
    setRuntimeBusy(action);
    try {
      const res = await fetch("/api/work-items/sprint-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          sourcePath,
          action,
          targetWip,
          maxAutoLaunchPerAction,
          blockLaunchWhenReviewPending,
          allowImportDuringAutoLaunch
        })
      });
      const payload = (await res.json().catch(() => ({}))) as WorkSprintControlActionResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? "Sprint runtime action failed");
      }
      if (payload.control) {
        setState({ control: payload.control });
      }
      setLastReport(payload.report ?? payload.control?.supervisor.lastReport ?? null);
      await load();
      if (!options?.silent) {
        pushToast({
          tone: payload.launched.length > 0 || payload.imported.length > 0 ? "success" : "warning",
          title: action === "launch_next_ready" ? "Next PBI processed" : "Sprint WIP updated",
          message:
            payload.launched.length > 0 || payload.imported.length > 0
              ? `${payload.imported.length} imported, ${payload.launched.length} launched${payload.skipped.length > 0 ? `, ${payload.skipped.length} skipped` : ""}.`
              : payload.skipped[0]?.reason ?? "No launchable PBI was available."
        });
      }
    } catch (error) {
      if (!options?.silent) {
        pushToast({
          tone: "danger",
          title: "Sprint runtime failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      setRuntimeBusy("");
    }
  }, [
    allowImportDuringAutoLaunch,
    blockLaunchWhenReviewPending,
    load,
    maxAutoLaunchPerAction,
    pushToast,
    sourcePath,
    targetWip,
    workspaceId
  ]);

  const teamRuntime = useMemo(() => {
    if (!state) return null;
    return buildSprintTeamRuntime({
      control: state.control,
      agents,
      tasks
    });
  }, [agents, state, tasks]);

  const saveBackgroundSupervisor = useCallback(async (enabled: boolean) => {
    if (!workspaceId || !sourcePath) return;
    setSupervisorBusy(true);
    try {
      const res = await fetch("/api/work-items/sprint-control/supervisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          sourcePath,
          enabled,
          targetWip,
          maxAutoLaunchPerAction,
          blockLaunchWhenReviewPending,
          allowImportDuringAutoLaunch
        })
      });
      const payload = (await res.json().catch(() => ({}))) as WorkSprintSupervisorResponse;
      if (!res.ok || !payload.ok || !payload.control || !payload.supervisor) {
        throw new Error(payload.error ?? "Supervisor policy could not be saved");
      }
      setState({ control: payload.control });
      setBackgroundSupervisorEnabled(payload.supervisor.enabled);
      setTargetWip(payload.control.governance.targetWip);
      setMaxAutoLaunchPerAction(payload.control.governance.maxAutoLaunchPerAction);
      setBlockLaunchWhenReviewPending(payload.control.governance.blockLaunchWhenReviewPending);
      setAllowImportDuringAutoLaunch(payload.control.governance.allowImportDuringAutoLaunch);
      setLastReport(payload.supervisor.lastReport ?? null);
      pushToast({
        tone: payload.supervisor.enabled ? "success" : "warning",
        title: payload.supervisor.enabled ? "Background supervisor enabled" : "Background supervisor paused",
        message: payload.supervisor.enabled
          ? "The PM runtime will keep the sprint moving even when this page is closed."
          : "Automatic sprint orchestration has been paused."
      });
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Supervisor update failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSupervisorBusy(false);
    }
  }, [
    allowImportDuringAutoLaunch,
    blockLaunchWhenReviewPending,
    maxAutoLaunchPerAction,
    pushToast,
    sourcePath,
    targetWip,
    workspaceId
  ]);

  const grouped = useMemo(() => {
    const control = state?.control;
    const lanes = [
      { id: "unimported", label: "Backlog" },
      { id: "ready", label: "Ready" },
      { id: "running", label: "In Flight" },
      { id: "review", label: "Review" },
      { id: "blocked", label: "Blocked" },
      { id: "completed", label: "Done" }
    ] as const;
    return lanes.map((lane) => ({
      ...lane,
      items: (control?.pbis ?? []).filter((pbi) => pbi.state === lane.id)
    }));
  }, [state?.control]);

  const burndownMax = useMemo(() => {
    const values = state?.control.burndown.flatMap((point) => [point.remaining, point.completed, point.active]) ?? [];
    return values.length > 0 ? Math.max(...values) : 0;
  }, [state?.control.burndown]);

  if (!sourcePath) {
    return (
      <main className="space-y-6">
        <section className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/60 px-6 py-12 text-center">
          <h1 className="text-xl font-semibold text-white">Sprint source required</h1>
          <p className="mt-2 text-sm text-slate-500">Open this page with a `sourcePath` query so Orchestrum can build a sprint control room.</p>
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

  if (loading && !state) {
    return (
      <main className="space-y-6">
        <section className="rounded-3xl border border-slate-800 bg-slate-950/60 px-6 py-10 text-center text-sm text-slate-500">
          Loading sprint control room...
        </section>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="space-y-6">
        <section className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/60 px-6 py-12 text-center">
          <h1 className="text-xl font-semibold text-white">Sprint control unavailable</h1>
          <p className="mt-2 text-sm text-slate-500">The sprint could not be resolved for the selected workspace.</p>
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

  const { control } = state;

  return (
    <main className="space-y-6">
      <section className="rounded-3xl border border-slate-800 bg-slate-950/60 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/work${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`}
                className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Back to intake
              </Link>
              <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200">
                Sprint Control Room
              </span>
            </div>
            <h1 className="mt-4 text-2xl font-semibold text-white">{control.sprintName ?? control.sourcePath}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
              Parent sprint view for dependency-aware PBI orchestration, PM recommendations, and queue health.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-right">
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Source</div>
            <div className="mt-1 text-sm font-medium text-white">{control.sourcePath}</div>
            <div className="mt-1 text-xs text-slate-500">{workspaceId || "No workspace selected"}</div>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3 xl:grid-cols-8">
          {[
            { label: "Total", value: control.summary.total },
            { label: "Backlog", value: control.summary.unimported },
            { label: "Ready", value: control.summary.ready },
            { label: "In Flight", value: control.summary.running },
            { label: "Review", value: control.summary.review },
            { label: "Done", value: control.summary.completed },
            { label: "Launchable", value: control.summary.launchable },
            { label: "Progress", value: `${control.summary.percentComplete}%` }
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3">
              <div className="text-lg font-semibold text-white">{item.value}</div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-6">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Sprint Runtime</div>
            <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Governance</div>
                <div className="mt-4 grid gap-4">
                  <label className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.16em] text-slate-500">Target WIP</span>
                    <input
                      type="number"
                      min={1}
                      value={targetWip}
                      onChange={(event) => setTargetWip(Math.max(1, Number(event.target.value || 1)))}
                      className="w-28 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-400/40"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.16em] text-slate-500">Max auto launches</span>
                    <input
                      type="number"
                      min={1}
                      value={maxAutoLaunchPerAction}
                      onChange={(event) => setMaxAutoLaunchPerAction(Math.max(1, Number(event.target.value || 1)))}
                      className="w-28 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-400/40"
                    />
                  </label>
                  <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={blockLaunchWhenReviewPending}
                      onChange={(event) => setBlockLaunchWhenReviewPending(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-300 focus:ring-cyan-400/40"
                    />
                    <div>
                      <div className="text-sm text-white">Hold launches while review is pending</div>
                      <div className="mt-1 text-xs text-slate-500">Prevents the PM runtime from starting new PBIs before the review queue is cleared.</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={allowImportDuringAutoLaunch}
                      onChange={(event) => setAllowImportDuringAutoLaunch(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-300 focus:ring-cyan-400/40"
                    />
                    <div>
                      <div className="text-sm text-white">Allow import during automatic launch</div>
                      <div className="mt-1 text-xs text-slate-500">Lets the PM runtime pull a new PBI into the queue when the next launchable item is still unimported.</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={backgroundSupervisorEnabled}
                      onChange={(event) => void saveBackgroundSupervisor(event.target.checked)}
                      disabled={supervisorBusy}
                      className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-300 focus:ring-cyan-400/40"
                    />
                    <div>
                      <div className="text-sm text-white">Background supervisor</div>
                      <div className="mt-1 text-xs text-slate-500">Keeps this sprint moving in the service process even when the UI is closed.</div>
                    </div>
                  </label>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={runtimeBusy !== ""}
                    onClick={() => void runSprintAction("launch_next_ready")}
                    className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {runtimeBusy === "launch_next_ready" ? "Launching..." : "Launch next ready"}
                  </button>
                  <button
                    type="button"
                    disabled={runtimeBusy !== ""}
                    onClick={() => void runSprintAction("fill_wip")}
                    className="rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-cyan-200 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {runtimeBusy === "fill_wip" ? "Filling..." : "Fill WIP"}
                  </button>
                  <button
                    type="button"
                    disabled={supervisorBusy}
                    onClick={() => void saveBackgroundSupervisor(backgroundSupervisorEnabled)}
                    className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {supervisorBusy ? "Saving..." : "Save background policy"}
                  </button>
                </div>
                <div className="mt-4 text-xs text-slate-500">
                  Active WIP is {control.summary.activeWip}. Launchable backlog is {control.summary.launchable}.
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Background state: {control.supervisor.state}
                  {control.supervisor.lastTickAt ? ` · last tick ${new Date(control.supervisor.lastTickAt).toLocaleString()}` : ""}
                </div>
                {control.supervisor.lastError && (
                  <div className="mt-3 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-2 text-xs text-fuchsia-100">
                    Supervisor error: {control.supervisor.lastError}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Launch Queue</div>
                <div className="mt-3 space-y-3">
                  {control.launchQueue.length > 0 ? (
                    control.launchQueue.slice(0, 5).map((candidate) => (
                      <div key={candidate.pbiId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium text-white">{candidate.pbiId} · {candidate.title}</div>
                            <div className="mt-1 text-xs text-slate-500">Score {candidate.score}</div>
                          </div>
                          <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${candidateDispositionClassName(candidate.disposition)}`}>
                            {candidate.disposition}
                          </span>
                        </div>
                        <div className="mt-3 space-y-1 text-xs text-slate-400">
                          {candidate.reasons.slice(0, 2).map((reason) => (
                            <div key={reason}>{reason}</div>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-slate-500">No launchable candidates are currently available.</div>
                  )}
                </div>
              </div>
            </div>
            {lastReport && (
              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Last Runtime Report</div>
                    <div className="mt-2 text-sm font-medium text-white">
                      {lastReport.action.replace(/_/g, " ")} · {lastReport.slotsFilled}/{lastReport.slotsRequested} slots filled
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">
                    WIP {lastReport.governance.targetWip} · max {lastReport.governance.maxAutoLaunchPerAction}
                  </div>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {lastReport.candidates.slice(0, 4).map((candidate) => (
                    <div key={candidate.pbiId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-white">{candidate.pbiId}</div>
                        <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${candidateDispositionClassName(candidate.disposition)}`}>
                          {candidate.disposition}
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-slate-400">{candidate.reasons[0]}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Organization Runtime</div>
            {teamRuntime ? (
              <>
                <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-sm font-medium text-white">{teamRuntime.headline}</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">{teamRuntime.pmFocus}</div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                    <span>Supervisor {control.supervisor.enabled ? control.supervisor.state : "paused"}</span>
                    <span>{control.supervisor.tickIntervalSeconds}s cadence</span>
                    {control.supervisor.lastActionAt && <span>last action {new Date(control.supervisor.lastActionAt).toLocaleTimeString()}</span>}
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-4">
                    {[
                      { label: "Active PBIs", value: teamRuntime.activePbis },
                      { label: "Review queue", value: teamRuntime.reviewQueue },
                      { label: "Blocked PBIs", value: teamRuntime.blockedPbis },
                      { label: "Active agents", value: teamRuntime.activeAgents }
                    ].map((item) => (
                      <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                        <div className="text-lg font-semibold text-white">{item.value}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
                      </div>
                    ))}
                  </div>
                  {teamRuntime.bottleneckLabel && (
                    <div className="mt-4 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-4 py-3 text-sm text-fuchsia-100">
                      Bottleneck lane: {teamRuntime.bottleneckLabel}
                    </div>
                  )}
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Stage Load</div>
                    <div className="mt-3 space-y-3">
                      {teamRuntime.stages.length > 0 ? (
                        teamRuntime.stages.slice(0, 5).map((stage) => (
                          <div key={stage.laneId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-sm font-medium text-white">{stage.laneLabel}</div>
                              <div className="text-xs text-slate-500">{stage.total} tasks</div>
                            </div>
                            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
                              {[
                                { label: "Run", value: stage.running, tone: "text-amber-200" },
                                { label: "Queue", value: stage.queued, tone: "text-cyan-200" },
                                { label: "Block", value: stage.blocked, tone: "text-fuchsia-200" },
                                { label: "Done", value: stage.succeeded, tone: "text-emerald-200" }
                              ].map((item) => (
                                <div key={item.label} className="rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-2">
                                  <div className={`text-sm font-medium ${item.tone}`}>{item.value}</div>
                                  <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-slate-500">{item.label}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-xl border border-dashed border-slate-700 px-3 py-6 text-sm text-slate-500">
                          No sprint task graph is active yet.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Active Roster</div>
                    <div className="mt-3 space-y-3">
                      {teamRuntime.agents.length > 0 ? (
                        teamRuntime.agents.slice(0, 6).map((agent) => (
                          <div key={agent.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-white">{agent.name}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {agent.specialization} · {agent.seniority} · {agent.role}
                                </div>
                              </div>
                              <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${agentStateClassName(agent.state)}`}>
                                {agent.activeLoad}/{agent.maxParallelWork}
                              </span>
                            </div>
                            {agent.activePbis.length > 0 && (
                              <div className="mt-3 text-xs text-slate-400">
                                PBIs: {agent.activePbis.join(" | ")}
                              </div>
                            )}
                            {agent.activeTasks.length > 0 && (
                              <div className="mt-2 text-xs text-slate-500">
                                Tasks: {agent.activeTasks.join(" | ")}
                              </div>
                            )}
                          </div>
                        ))
                      ) : (
                        <div className="rounded-xl border border-dashed border-slate-700 px-3 py-6 text-sm text-slate-500">
                          No active roster load is visible yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                Organization runtime will appear once the sprint state is loaded.
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">PM Recommendations</div>
            <div className="mt-4 space-y-3">
              {control.recommendations.length > 0 ? (
                control.recommendations.map((recommendation) => (
                  <div key={`${recommendation.action}-${recommendation.pbiId}`} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{recommendation.pbiId} · {recommendation.title}</div>
                        <div className="mt-1 text-xs text-slate-500">{recommendation.rationale}</div>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${
                        recommendation.action === "review"
                          ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                          : recommendation.action === "launch"
                            ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                            : "border-sky-400/30 bg-sky-400/10 text-sky-200"
                      }`}>
                        {recommendation.action}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {recommendation.action === "import" && (
                        <button
                          type="button"
                          onClick={() => void runImport([recommendation.pbiId], false)}
                          disabled={busyPbiId === recommendation.pbiId}
                          className="rounded-xl border border-sky-400/40 bg-sky-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-sky-200 transition-colors hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busyPbiId === recommendation.pbiId ? "Importing..." : "Import draft"}
                        </button>
                      )}
                      {recommendation.action === "launch" && recommendation.workItemId && (
                        <button
                          type="button"
                          onClick={() => void runLaunch(recommendation.workItemId!, recommendation.title)}
                          disabled={busyPbiId === recommendation.workItemId}
                          className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busyPbiId === recommendation.workItemId ? "Launching..." : "Launch"}
                        </button>
                      )}
                      {recommendation.workItemId && (
                        <Link
                          href={`/work/${recommendation.workItemId}?workspace=${encodeURIComponent(workspaceId)}`}
                          className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                        >
                          Open board
                        </Link>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                  No immediate PM recommendation was synthesized from the current sprint state.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Blockers</div>
            <div className="mt-4 space-y-2 text-sm text-slate-300">
              {control.blockers.length > 0 ? (
                control.blockers.map((blocker) => (
                  <div key={blocker} className="flex gap-2">
                    <span className="text-fuchsia-300">•</span>
                    <span>{blocker}</span>
                  </div>
                ))
              ) : (
                <div className="text-slate-500">No sprint-wide blockers are currently synthesized.</div>
              )}
            </div>
            {control.warnings.length > 0 && (
              <div className="mt-4 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 p-4 text-sm text-fuchsia-100">
                {control.warnings[0]}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Burndown</div>
                <div className="mt-2 text-sm text-slate-400">
                  Remaining PBIs versus completed and active execution over the sprint evidence timeline.
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-right">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Current Snapshot</div>
                <div className="mt-1 text-sm text-white">
                  {control.summary.completed} done · {control.summary.running} active · {control.summary.total - control.summary.completed} remaining
                </div>
              </div>
            </div>
            {control.burndown.length > 0 && burndownMax > 0 ? (
              <>
                <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <svg viewBox="0 0 100 100" className="h-56 w-full overflow-visible">
                    <defs>
                      <linearGradient id="burndown-bg" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="rgba(14,165,233,0.15)" />
                        <stop offset="100%" stopColor="rgba(15,23,42,0)" />
                      </linearGradient>
                    </defs>
                    {[0, 25, 50, 75, 100].map((offset) => (
                      <line
                        key={offset}
                        x1="0"
                        y1={offset}
                        x2="100"
                        y2={offset}
                        stroke="rgba(148,163,184,0.18)"
                        strokeDasharray="2 3"
                        strokeWidth="0.4"
                      />
                    ))}
                    <polyline
                      fill="none"
                      stroke="rgba(248,250,252,0.18)"
                      strokeWidth="0.6"
                      strokeDasharray="1.5 2.5"
                      points={renderBurndownPolyline(control.burndown, "remaining", burndownMax)}
                    />
                    <polyline
                      fill="none"
                      stroke="rgb(56 189 248)"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={renderBurndownPolyline(control.burndown, "remaining", burndownMax)}
                    />
                    <polyline
                      fill="none"
                      stroke="rgb(34 197 94)"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={renderBurndownPolyline(control.burndown, "completed", burndownMax)}
                    />
                    <polyline
                      fill="none"
                      stroke="rgb(245 158 11)"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={renderBurndownPolyline(control.burndown, "active", burndownMax)}
                    />
                    {control.burndown.map((point, index) => {
                      const x = control.burndown.length === 1 ? 0 : (index / (control.burndown.length - 1)) * 100;
                      const remainingY = 100 - (point.remaining / burndownMax) * 100;
                      const completedY = 100 - (point.completed / burndownMax) * 100;
                      const activeY = 100 - (point.active / burndownMax) * 100;
                      return (
                        <g key={point.label}>
                          <circle cx={x} cy={remainingY} r="1.2" fill="rgb(56 189 248)" />
                          <circle cx={x} cy={completedY} r="1.1" fill="rgb(34 197 94)" />
                          <circle cx={x} cy={activeY} r="1.1" fill="rgb(245 158 11)" />
                        </g>
                      );
                    })}
                  </svg>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {[
                    { label: "Remaining", tone: "bg-sky-400", value: control.burndown.at(-1)?.remaining ?? 0 },
                    { label: "Completed", tone: "bg-emerald-400", value: control.burndown.at(-1)?.completed ?? 0 },
                    { label: "Active", tone: "bg-amber-400", value: control.burndown.at(-1)?.active ?? 0 }
                  ].map((item) => (
                    <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${item.tone}`} />
                        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{item.label}</span>
                      </div>
                      <div className="mt-3 text-lg font-semibold text-white">{item.value}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  {control.burndown.slice(-4).map((point) => (
                    <div key={`${point.label}-${point.at}`} className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{point.label}</div>
                      <div className="mt-2 text-xs text-slate-500">{new Date(point.at).toLocaleString()}</div>
                      <div className="mt-3 text-sm text-slate-300">
                        {point.remaining} remaining · {point.completed} done · {point.active} active
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-500">
                Burndown data will appear after the sprint starts producing evidence.
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Sprint Swimlanes</div>
            <div className="mt-4 grid gap-4 xl:grid-cols-3">
              {grouped.map((lane) => (
                <div key={lane.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-white">{lane.label}</div>
                    <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                      {lane.items.length}
                    </span>
                  </div>
                  <div className="mt-4 space-y-2">
                    {lane.items.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-500">
                        No PBIs in this lane.
                      </div>
                    ) : (
                      lane.items.slice(0, 5).map((pbi) => (
                        <div key={pbi.pbiId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                          <div className="text-sm font-medium text-white">{pbi.pbiId}</div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{pbi.pbiTitle}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">PBI Backlog</div>
            <div className="mt-4 space-y-3">
              {control.pbis.map((pbi) => (
                <PbiCard
                  key={pbi.pbiId}
                  pbi={pbi}
                  workspaceId={workspaceId}
                  busy={busyPbiId === (pbi.workItemId ?? pbi.pbiId)}
                  onImport={runImport}
                  onLaunch={runLaunch}
                />
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Evidence Timeline</div>
            <div className="mt-4 space-y-3">
              {control.timeline.length > 0 ? (
                control.timeline.map((entry) => (
                  <div key={entry.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-white">{entry.pbiId} · {entry.title}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {entry.type.replace(/_/g, " ")}
                          {entry.cycleSequence ? ` · cycle ${entry.cycleSequence}` : ""}
                          {entry.cycleStatus ? ` · ${entry.cycleStatus.replace(/_/g, " ")}` : ""}
                        </div>
                      </div>
                      <div className="text-xs text-slate-500">{new Date(entry.at).toLocaleString()}</div>
                    </div>
                    <div className="mt-3 text-sm leading-6 text-slate-400">{entry.summary}</div>
                    {entry.workItemId && (
                      <div className="mt-3">
                        <Link
                          href={`/work/${entry.workItemId}?workspace=${encodeURIComponent(workspaceId)}`}
                          className="inline-flex rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                        >
                          Open board
                        </Link>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                  No sprint-level evidence exists yet.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function PbiCard(props: {
  pbi: WorkSprintControlPbi;
  workspaceId: string;
  busy: boolean;
  onImport: (pbiIds: string[], launchAfterImport?: boolean) => Promise<void>;
  onLaunch: (workItemId: string, title: string) => Promise<void>;
}) {
  const { pbi, workspaceId, busy, onImport, onLaunch } = props;
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] ${pbiStateClassName(pbi.state)}`}>
              {pbiStateLabel(pbi.state)}
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
              {pbi.taskCount} tasks
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-400">
              {pbi.cycleCount} cycles
            </span>
          </div>
          <div className="mt-3 text-sm font-medium text-white">{pbi.pbiId} · {pbi.pbiTitle}</div>
          {pbi.summary && (
            <div className="mt-2 text-sm leading-6 text-slate-400">{pbi.summary}</div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            {pbi.dependsOn.length > 0 && <span>Depends on {pbi.dependsOn.join(", ")}</span>}
            {pbi.workItemStatus && <span>Queue status {pbi.workItemStatus.replace(/_/g, " ")}</span>}
            {pbi.reviewStatus && <span>Review {pbi.reviewStatus.replace(/_/g, " ")}</span>}
          </div>
          {pbi.blockedReasons.length > 0 && (
            <div className="mt-3 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-2 text-xs text-fuchsia-100">
              {pbi.blockedReasons[0]}
            </div>
          )}
          {pbi.warnings.length > 0 && (
            <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
              {pbi.warnings[0]}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!pbi.workItemId && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onImport([pbi.pbiId], false)}
                className="rounded-xl border border-sky-400/40 bg-sky-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-sky-200 transition-colors hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Importing..." : "Import draft"}
              </button>
              <button
                type="button"
                disabled={busy || pbi.state === "blocked"}
                onClick={() => void onImport([pbi.pbiId], true)}
                className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Launching..." : "Import + launch"}
              </button>
            </>
          )}
          {pbi.workItemId && (
            <>
              {pbi.state === "ready" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onLaunch(pbi.workItemId!, pbi.pbiTitle)}
                  className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? "Launching..." : "Launch"}
                </button>
              )}
              <Link
                href={`/work/${pbi.workItemId}?workspace=${encodeURIComponent(workspaceId)}`}
                className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Open board
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
