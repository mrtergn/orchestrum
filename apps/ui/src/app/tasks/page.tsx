"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { normalizeTaskStatus } from "@/lib/runtime";

type Agent = { id: string; name: string; role: string };
type Task = {
  id: string;
  title: string;
  description: string;
  type: "spec" | "implement" | "audit" | "generic";
  status: string;
  assignedToAgentId: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  linkedRunId?: string;
  linkedTemplateId?: string;
  pauseReason?: string | null;
  change?: { status?: string | null } | null;
  validation?: { status?: string | null } | null;
  verdict?: string | null;
  resultSummary?: string;
};

const STATUS: Record<string, { bg: string; text: string; icon: string; ring: string }> = {
  running:   { bg: "bg-amber-400/15",   text: "text-amber-300",   icon: "↻", ring: "border-amber-400/40" },
  paused:    { bg: "bg-cyan-400/15",    text: "text-cyan-300",    icon: "⏸", ring: "border-cyan-400/40" },
  blocked:   { bg: "bg-fuchsia-400/15", text: "text-fuchsia-300", icon: "!", ring: "border-fuchsia-400/40" },
  succeeded: { bg: "bg-emerald-400/15",  text: "text-emerald-300", icon: "✓", ring: "border-emerald-400/40" },
  failed:    { bg: "bg-rose-400/15",     text: "text-rose-300",    icon: "✗", ring: "border-rose-400/40" },
  cancelled: { bg: "bg-slate-400/15",    text: "text-slate-400",   icon: "⊘", ring: "border-slate-500/40" },
  queued:    { bg: "bg-cyan-400/15",     text: "text-cyan-300",    icon: "◦", ring: "border-cyan-400/40" },
};
const sts = (s: string) => STATUS[s] ?? STATUS["queued"]!;

const TYPE_ICON: Record<string, { icon: string; color: string }> = {
  spec:      { icon: "📋", color: "text-violet-400" },
  implement: { icon: "⚙", color: "text-sky-400" },
  audit:     { icon: "🔍", color: "text-amber-400" },
  generic:   { icon: "◆", color: "text-slate-400" },
};
const tIcon = (t: string) => TYPE_ICON[t] ?? TYPE_ICON["generic"]!;

export default function TasksPage() {
  const { pushToast } = useAppUi();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState<Task["type"]>("generic");
  const [assignedToAgentId, setAssignedToAgentId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskLogs, setTaskLogs] = useState("");
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    const [agentRes, taskRes] = await Promise.all([
      fetch("/api/agents", { cache: "no-store" }),
      fetch("/api/tasks", { cache: "no-store" })
    ]);
    const agentData = await agentRes.json().catch(() => ({ agents: [] }));
    const taskData = await taskRes.json().catch(() => ({ tasks: [] }));
    const loadedAgents = Array.isArray(agentData.agents) ? agentData.agents : [];
    setAgents(loadedAgents);
    setTasks(Array.isArray(taskData.tasks) ? taskData.tasks : []);
    if (!assignedToAgentId && loadedAgents[0]?.id) {
      setAssignedToAgentId(loadedAgents[0].id);
    }
  }, [assignedToAgentId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        type: taskType,
        assignedToAgentId
      })
    });
    setTitle("");
    setDescription("");
    setShowForm(false);
    pushToast({ tone: "success", title: "Task queued", message: title });
    await load();
  };

  const viewTask = async (id: string) => {
    setSelectedTaskId(id);
    const res = await fetch(`/api/tasks/${id}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    setTaskLogs(String(data.logs ?? ""));
    setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
  };

  const cancelTask = async (id: string) => {
    await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
    pushToast({ tone: "warning", title: "Task cancelled" });
    await Promise.all([load(), viewTask(id)]);
  };

  const retryTask = async (id: string) => {
    await fetch(`/api/tasks/${id}/retry`, { method: "POST" });
    pushToast({ tone: "info", title: "Task retrying" });
    await Promise.all([load(), viewTask(id)]);
  };

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? null, [tasks, selectedTaskId]);
  const agentNameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  /* ---- Summary stats ---- */
  const running = tasks.filter((t) => normalizeTaskStatus(t.status) === "running").length;
  const paused = tasks.filter((t) => {
    const status = normalizeTaskStatus(t.status);
    return status === "paused" || status === "blocked";
  }).length;
  const completed = tasks.filter((t) => normalizeTaskStatus(t.status) === "succeeded").length;
  const failed = tasks.filter((t) => normalizeTaskStatus(t.status) === "failed").length;

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Tasks</h2>
          <p className="text-sm text-slate-400">
            {tasks.length > 0
              ? `${tasks.length} task${tasks.length !== 1 ? "s" : ""} · ${running} running`
              : "Route manual or mission-backed work through the agent layer."}
          </p>
        </div>
        {agents.length > 0 && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
          >
            {showForm ? "Cancel" : "+ New Task"}
          </button>
        )}
      </section>

      {/* Quick stats bar */}
      {tasks.length > 0 && (
        <section className="grid grid-cols-4 gap-3">
          {[
            { label: "Running", value: running, icon: "▶", accent: "border-amber-400/30 text-amber-300" },
            { label: "Paused/Blocked", value: paused, icon: "⏸", accent: "border-cyan-400/30 text-cyan-300" },
            { label: "Completed", value: completed, icon: "✓", accent: "border-emerald-400/30 text-emerald-300" },
            { label: "Failed", value: failed, icon: "✗", accent: "border-rose-400/30 text-rose-300" }
          ].map((s) => (
            <div key={s.label} className={`flex items-center gap-3 rounded-xl border bg-slate-950/40 p-3 ${s.accent.split(" ")[0]}`}>
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-sm ${s.accent.split(" ")[1]}`}>{s.icon}</div>
              <div>
                <div className="text-lg font-semibold text-white">{s.value}</div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{s.label}</div>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* No agents empty state */}
      {agents.length === 0 && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-12 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/20 to-violet-500/20 text-2xl">◈</div>
          <h3 className="mt-4 text-lg font-semibold text-white">Create agents first</h3>
          <p className="mt-1 text-sm text-slate-400">
            You need at least one agent before you can assign tasks.
          </p>
          <Link
            href="/agents"
            className="mt-5 inline-block rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
          >
            Go to Agents
          </Link>
        </section>
      )}

      {/* Create form */}
      {showForm && agents.length > 0 && (
        <section className="rounded-2xl border border-amber-400/20 bg-slate-950/40 p-6">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.15em] text-amber-300">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-amber-400/20 text-[10px]">+</span>
            New Task
          </div>
          <form onSubmit={createTask} className="mt-4 space-y-3 max-w-xl">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What should the agent do?"
              className="w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-amber-400/40 focus:outline-none transition-colors"
              required
            />
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Detailed description..."
              className="h-20 w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-amber-400/40 focus:outline-none transition-colors"
              required
            />
            <div className="grid grid-cols-2 gap-3">
              <select
                value={taskType}
                onChange={(event) => setTaskType(event.target.value as Task["type"])}
                className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs text-slate-200 focus:border-amber-400/40 focus:outline-none"
              >
                <option value="generic">◆ Generic</option>
                <option value="spec">📋 Spec (requirements)</option>
                <option value="implement">⚙ Implement (code)</option>
                <option value="audit">🔍 Audit (review)</option>
              </select>
              <select
                value={assignedToAgentId}
                onChange={(event) => setAssignedToAgentId(event.target.value)}
                className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs text-slate-200 focus:border-amber-400/40 focus:outline-none"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.role})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
            >
              Queue Task
            </button>
          </form>
        </section>
      )}

      {/* Task list + detail grid */}
      {agents.length > 0 && (
        <section className={`grid gap-6 ${selectedTask ? "lg:grid-cols-[1fr_1.1fr]" : ""}`}>
          {/* Task list */}
          <div className="space-y-2">
            {tasks.length === 0 && !showForm && (
              <div className="rounded-2xl border border-dashed border-slate-700 p-12 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/20 to-amber-500/20 text-2xl">◈</div>
                <h3 className="mt-4 text-sm font-semibold text-white">No tasks yet</h3>
                <p className="mt-1 text-xs text-slate-500">Click &quot;+ New Task&quot; to assign work to an agent.</p>
              </div>
            )}
            {tasks.map((task) => {
              const normalizedStatus = normalizeTaskStatus(task.status);
              const st = sts(normalizedStatus);
              const tp = tIcon(task.type);
              const progress = task.maxAttempts > 0 ? Math.round((task.attempts / task.maxAttempts) * 100) : 0;
              return (
                <button
                  key={task.id}
                  onClick={() => void viewTask(task.id)}
                  className={`group w-full rounded-xl border p-3.5 text-left transition-all ${
                    selectedTaskId === task.id
                      ? `${st.ring} ${st.bg}`
                      : "border-slate-800 bg-slate-950/40 hover:border-slate-700 hover:bg-slate-900/30"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Type icon */}
                    <div className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-900/80 text-sm ${tp.color}`}>
                      {tp.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-white">{task.title}</span>
                        <span className={`ml-auto flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${st.bg} ${st.text}`}>
                          <span>{st.icon}</span> {normalizedStatus}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                        <span>{agentNameById.get(task.assignedToAgentId) ?? "?"}</span>
                        <span className="text-slate-700">·</span>
                        <span className="capitalize">{task.type}</span>
                        <span className="text-slate-700">·</span>
                        <span>{task.attempts}/{task.maxAttempts} attempts</span>
                      </div>
                      {/* Attempts progress bar */}
                      {task.maxAttempts > 1 && (
                        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-800">
                          <div className={`h-full rounded-full transition-all ${normalizedStatus === "failed" ? "bg-rose-400" : normalizedStatus === "running" ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${progress}%` }} />
                        </div>
                      )}
                      {task.resultSummary && (
                        <div className="mt-1.5 truncate text-[10px] text-slate-600">{task.resultSummary}</div>
                      )}
                      {task.linkedRunId && (
                        <div className="mt-1 text-[10px] text-slate-500">Mission run: {task.linkedRunId}</div>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Task detail */}
          {selectedTask && (() => {
            const normalizedStatus = normalizeTaskStatus(selectedTask.status);
            const st = sts(normalizedStatus);
            const tp = tIcon(selectedTask.type);
            return (
              <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
                {/* Detail header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-slate-900 text-base ${tp.color}`}>{tp.icon}</div>
                    <div>
                      <div className="text-sm font-medium text-white">{selectedTask.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
                        <span className="capitalize">{selectedTask.type}</span>
                        <span className="text-slate-700">·</span>
                        <span>{agentNameById.get(selectedTask.assignedToAgentId) ?? "?"}</span>
                        {selectedTask.linkedTemplateId && (
                          <>
                            <span className="text-slate-700">·</span>
                            <span>{selectedTask.linkedTemplateId}</span>
                          </>
                        )}
                        <span className="text-slate-700">·</span>
                        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px ${st.bg} ${st.text}`}>
                          {st.icon} {normalizedStatus}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(normalizedStatus === "queued" || normalizedStatus === "running") && (
                      <button
                        onClick={() => void cancelTask(selectedTask.id)}
                        className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-rose-200 transition-colors hover:bg-rose-500/10"
                      >
                        Cancel
                      </button>
                    )}
                    {(normalizedStatus === "failed" || normalizedStatus === "cancelled" || normalizedStatus === "paused" || normalizedStatus === "blocked") && (
                      <button
                        onClick={() => void retryTask(selectedTask.id)}
                        className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-emerald-200 transition-colors hover:bg-emerald-500/10"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>

                {/* Attempts progress */}
                <div className="mt-4 flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full rounded-full transition-all ${normalizedStatus === "failed" ? "bg-gradient-to-r from-rose-500 to-rose-400" : normalizedStatus === "running" ? "bg-gradient-to-r from-amber-500 to-amber-400" : "bg-gradient-to-r from-emerald-500 to-emerald-400"}`}
                      style={{ width: `${selectedTask.maxAttempts > 0 ? Math.round((selectedTask.attempts / selectedTask.maxAttempts) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-slate-500">{selectedTask.attempts}/{selectedTask.maxAttempts}</span>
                </div>

                <div className="mt-4 grid gap-2 text-[10px] text-slate-400 md:grid-cols-2">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2">
                    <div className="uppercase tracking-wider text-slate-500">Change</div>
                    <div className="mt-1 text-slate-200">{selectedTask.change?.status ?? "none"}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2">
                    <div className="uppercase tracking-wider text-slate-500">Validation</div>
                    <div className="mt-1 text-slate-200">{selectedTask.validation?.status ?? "not_requested"}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2">
                    <div className="uppercase tracking-wider text-slate-500">Verdict</div>
                    <div className="mt-1 text-slate-200">{selectedTask.verdict ?? "running"}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2">
                    <div className="uppercase tracking-wider text-slate-500">Pause reason</div>
                    <div className="mt-1 text-slate-200">{selectedTask.pauseReason ?? "none"}</div>
                  </div>
                </div>

                {/* Artifacts */}
                {artifacts.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">Artifacts</div>
                    <div className="flex flex-wrap gap-1.5">
                      {artifacts.map((a) => (
                        <span key={a} className="rounded-md bg-slate-800/80 px-2 py-0.5 font-mono text-[10px] text-slate-400">{a}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Logs */}
                <div className="mt-4">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">Output</div>
                  <div className="scrollbar-thin max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                    {taskLogs ? (
                      taskLogs.split("\n").map((line, i) => (
                        <div key={i} className="flex gap-2 hover:bg-slate-800/30">
                          <span className="select-none text-right font-mono text-[10px] text-slate-700" style={{ minWidth: "2ch" }}>{i + 1}</span>
                          <span className={`font-mono text-[11px] leading-relaxed ${/error|fail/i.test(line) ? "text-rose-300" : /warn/i.test(line) ? "text-amber-300" : "text-slate-300"}`}>{line}</span>
                        </div>
                      ))
                    ) : (
                      <div className="py-6 text-center text-[11px] text-slate-600">Waiting for output...</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
        </section>
      )}
    </main>
  );
}
