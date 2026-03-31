"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { normalizeAgentRuntimeState, normalizeTaskStatus } from "@/lib/runtime";

type Agent = {
  id: string;
  name: string;
  role: string;
  status: { state: string; currentTaskId?: string; lastHeartbeatAt: string };
};
type Mission = {
  runId: string;
  workspaceId: string;
  templateId: string;
  title: string;
  goal: string;
  status: string;
  updatedAt: string;
  activeNodeIds: string[];
};
type Task = { id: string; title: string; status: string; assignedToAgentId: string };
type Message = { id: string; fromAgentId: string; toAgentId: string; topic: string; ts: string };
type OrgNode = { id: string; agentId: string; parentId?: string };

type Snapshot = {
  agents: Agent[];
  org: OrgNode[];
  missions: Mission[];
  tasks: Task[];
  messages: Message[];
  queue: { queued: number; running: number };
};

function stateColor(state: string) {
  if (normalizeAgentRuntimeState(state) === "active") return "bg-amber-400";
  if (normalizeAgentRuntimeState(state) === "sleeping" || normalizeAgentRuntimeState(state) === "idle") return "bg-emerald-400";
  return "bg-slate-600";
}

export default function MissionPage() {
  const { selectedWorkspaceId, openRunConfig } = useAppUi();
  const [snapshot, setSnapshot] = useState<Snapshot>({ agents: [], org: [], missions: [], tasks: [], messages: [], queue: { queued: 0, running: 0 } });
  const [events, setEvents] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      if (payload.t === "snapshot") {
        setSnapshot({
          agents: (payload.agents as Agent[]) ?? [],
          org: (payload.org as OrgNode[]) ?? [],
          missions: (payload.missions as Mission[]) ?? [],
          tasks: (payload.tasks as Task[]) ?? [],
          messages: (payload.messages as Message[]) ?? [],
          queue: (payload.queue as Snapshot["queue"]) ?? { queued: 0, running: 0 }
        });
        return;
      }
      setEvents((prev) => [`${new Date().toLocaleTimeString()} ${String(payload.t)}`, ...prev].slice(0, 80));
      if (payload.t?.toString().startsWith("task.") || payload.t === "agent.status" || payload.t === "message.sent" || payload.t === "message.created" || payload.t === "org.updated") {
        fetch("/api/tasks", { cache: "no-store" })
          .then((res) => res.json())
          .then((taskData) => {
            const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
            setSnapshot((prev) => ({ ...prev, tasks }));
          })
          .catch(() => undefined);
        fetch("/api/agents", { cache: "no-store" })
          .then((res) => res.json())
          .then((agentData) => {
            const agents = Array.isArray(agentData.agents) ? agentData.agents : [];
            setSnapshot((prev) => ({ ...prev, agents }));
          })
          .catch(() => undefined);
        fetch("/api/org", { cache: "no-store" })
          .then((res) => res.json())
          .then((orgData) => {
            const org = Array.isArray(orgData.nodes) ? orgData.nodes : [];
            setSnapshot((prev) => ({ ...prev, org }));
          })
          .catch(() => undefined);
      }
    };
    source.onerror = () => {
      setConnected(false);
      setEvents((prev) => ["⚠ stream disconnected", ...prev].slice(0, 80));
    };
    return () => source.close();
  }, []);

  const queuedTasks = useMemo(() => snapshot.tasks.filter((task) => normalizeTaskStatus(task.status) === "queued"), [snapshot.tasks]);
  const runningTasks = useMemo(() => snapshot.tasks.filter((task) => normalizeTaskStatus(task.status) === "running"), [snapshot.tasks]);
  const activeMissions = useMemo(
    () => snapshot.missions.filter((mission) => mission.status === "running").length,
    [snapshot.missions]
  );
  const agentNameById = useMemo(() => new Map(snapshot.agents.map((agent) => [agent.id, agent.name])), [snapshot.agents]);

  const hasData = snapshot.agents.length > 0 || snapshot.missions.length > 0;

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Live Feed</h2>
          <p className="text-sm text-slate-400">Real-time view of agents, tasks, and system events.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openRunConfig({ workspaceId: selectedWorkspaceId || undefined, runKind: "mission" })}
            className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-cyan-200"
          >
            Launch Mission
          </button>
          <div className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-rose-400"}`} />
          <span className={`text-[10px] uppercase tracking-[0.2em] ${connected ? "text-emerald-300" : "text-rose-300"}`}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </section>

      {/* No data state */}
      {!hasData && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 text-2xl text-cyan-400">◎</div>
          <h3 className="mt-3 text-base font-semibold text-white">Nothing running yet</h3>
          <p className="mt-1 text-sm text-slate-400">Create workspace agents and start a mission to see the live feed populate.</p>
          <div className="mt-4 flex justify-center gap-3">
            <Link href="/agents" className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-200 hover:bg-amber-400/20 transition-colors">
              Create Agents
            </Link>
            <Link href="/templates" className="rounded-lg border border-slate-700 px-4 py-2 text-xs uppercase tracking-[0.2em] text-slate-300 hover:bg-slate-800/40 transition-colors">
              Browse Templates
            </Link>
          </div>
        </section>
      )}

      {/* Stats bar */}
      {hasData && (
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-cyan-500/20 bg-slate-950/40 p-3 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400 text-sm font-bold">⬡</div>
            <div>
              <div className="text-lg font-bold text-white">{snapshot.agents.length}</div>
              <div className="text-[9px] uppercase tracking-wider text-slate-500">Agents</div>
            </div>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-slate-950/40 p-3 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 text-sm font-bold">▶</div>
            <div>
              <div className="text-lg font-bold text-amber-300">{activeMissions}</div>
              <div className="text-[9px] uppercase tracking-wider text-slate-500">Missions</div>
            </div>
          </div>
          <div className="rounded-xl border border-sky-500/20 bg-slate-950/40 p-3 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 text-sm font-bold">⏳</div>
            <div>
              <div className="text-lg font-bold text-sky-300">{queuedTasks.length}</div>
              <div className="text-[9px] uppercase tracking-wider text-slate-500">Queued</div>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/50 bg-slate-950/40 p-3 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800 text-slate-400 text-sm font-bold">⚡</div>
            <div>
              <div className="text-lg font-bold text-slate-300">{events.length}</div>
              <div className="text-[9px] uppercase tracking-wider text-slate-500">Events</div>
            </div>
          </div>
        </section>
      )}

      {/* Main grid */}
      {hasData && (
        <section className="grid gap-4 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Active Missions</div>
            <div className="space-y-2">
              {snapshot.missions.slice(0, 8).map((mission) => (
                <Link
                  key={`${mission.workspaceId}:${mission.runId}`}
                  href={`/runs/${mission.runId}?workspace=${encodeURIComponent(mission.workspaceId)}`}
                  className="block rounded-lg border border-slate-800/60 bg-slate-900/30 px-3 py-2 transition hover:border-slate-700"
                >
                  <div className="text-xs font-medium text-white">{mission.title}</div>
                  <div className="mt-1 text-[10px] text-slate-500">{mission.templateId} · {mission.status}</div>
                  <div className="mt-1 text-[10px] text-slate-600">{mission.activeNodeIds.join(", ") || "idle"}</div>
                </Link>
              ))}
              {snapshot.missions.length === 0 && (
                <div className="py-4 text-center text-xs text-slate-600">No mission activity yet</div>
              )}
            </div>
          </div>

          {/* Agents */}
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Agents</div>
            <div className="space-y-2">
              {snapshot.agents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2.5 rounded-lg border border-slate-800/60 bg-slate-900/30 px-3 py-2">
                  <div className={`h-2 w-2 flex-shrink-0 rounded-full ${stateColor(agent.status.state)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-white">{agent.name}</div>
                    <div className="text-[10px] text-slate-500">
                      {agent.role} · {normalizeAgentRuntimeState(agent.status.state)}
                      {agent.status.currentTaskId ? ` · ${agent.status.currentTaskId.slice(0, 8)}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Runtime */}
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Runtime</div>
            <div className="space-y-2">
              {runningTasks.map((task) => (
                <div key={task.id} className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2">
                  <div className="text-xs font-medium text-white">{task.title}</div>
                  <div className="text-[10px] text-slate-500">{agentNameById.get(task.assignedToAgentId) ?? task.assignedToAgentId}</div>
                </div>
              ))}
              {queuedTasks.slice(0, 4).map((task) => (
                <div key={task.id} className="rounded-lg border border-slate-800/60 bg-slate-900/30 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-cyan-400">queued</span>
                    <span className="text-xs text-slate-300">{task.title}</span>
                  </div>
                </div>
              ))}
              {runningTasks.length === 0 && queuedTasks.length === 0 && (
                <div className="py-4 text-center text-xs text-slate-600">No active tasks</div>
              )}
            </div>
          </div>

          {/* Event tape */}
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Events</div>
            <div className="max-h-72 space-y-0.5 overflow-auto font-mono text-[11px] text-slate-400 scrollbar-thin">
              {events.map((line, index) => {
                const isError = line.includes("error") || line.includes("fail") || line.includes("⚠");
                const isTask = line.includes("task.");
                const isAgent = line.includes("agent.");
                return (
                  <div key={`${line}-${index}`} className={`rounded px-2 py-0.5 hover:bg-slate-800/40 transition-colors ${isError ? "text-rose-400" : isTask ? "text-amber-300/80" : isAgent ? "text-cyan-300/80" : ""}`}>
                    {line}
                  </div>
                );
              })}
              {events.length === 0 && <div className="py-8 text-center text-slate-600 text-xs">Waiting for events…</div>}
            </div>
          </div>
        </section>
      )}

      {/* Org structure (collapsed) */}
      {hasData && snapshot.org.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Org Structure</div>
            <Link href="/org" className="text-[10px] text-slate-600 hover:text-slate-400">Edit →</Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {snapshot.org.map((node) => (
              <div key={node.id} className="rounded-lg border border-slate-800/60 bg-slate-900/30 px-3 py-1.5 text-xs">
                <span className="text-white">{agentNameById.get(node.agentId) ?? "?"}</span>
                {node.parentId && (
                  <span className="text-slate-600"> → {agentNameById.get(node.parentId) ?? "?"}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
