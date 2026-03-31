"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { normalizeAgentRuntimeState } from "@/lib/runtime";

type SetupStatus = {
  hasProvider: boolean;
  agentCount: number;
  orgNodeCount: number;
  workspaceCount: number;
  taskCount: number;
  runCount: number;
};

type RecentRun = {
  runId: string;
  status: string;
  start: string;
  repoPath: string;
  workspaceId?: string;
};

type AgentSummary = {
  id: string;
  name: string;
  role: string;
  status: { state: string };
};

export default function HomePage() {
  const { openRunConfig } = useAppUi();
  const [setup, setSetup] = useState<SetupStatus>({
    hasProvider: false,
    agentCount: 0,
    orgNodeCount: 0,
    workspaceCount: 0,
    taskCount: 0,
    runCount: 0,
  });
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const [secretsRes, agentsRes, orgRes, workspacesRes, tasksRes, runsRes] = await Promise.all([
        fetch("/api/secrets", { cache: "no-store" }),
        fetch("/api/agents", { cache: "no-store" }),
        fetch("/api/org", { cache: "no-store" }),
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/runs", { cache: "no-store" }),
      ]);
      const secretsData = secretsRes.ok ? await secretsRes.json() : { keys: {} };
      const agentsData = agentsRes.ok ? await agentsRes.json() : { agents: [] };
      const orgData = orgRes.ok ? await orgRes.json() : { nodes: [] };
      const workspacesData = workspacesRes.ok ? await workspacesRes.json() : { workspaces: [] };
      const tasksData = tasksRes.ok ? await tasksRes.json() : { tasks: [] };
      const runsData = runsRes.ok ? await runsRes.json() : [];

      const agentList = Array.isArray(agentsData.agents) ? agentsData.agents : [];
      const runList = Array.isArray(runsData) ? runsData : [];

      setSetup({
        hasProvider: Boolean(secretsData.keys?.OPENAI_API_KEY || secretsData.keys?.ANTHROPIC_API_KEY),
        agentCount: agentList.length,
        orgNodeCount: Array.isArray(orgData.nodes) ? orgData.nodes.length : 0,
        workspaceCount: Array.isArray(workspacesData.workspaces) ? workspacesData.workspaces.length : 0,
        taskCount: Array.isArray(tasksData.tasks) ? tasksData.tasks.length : 0,
        runCount: runList.length,
      });
      setAgents(agentList.slice(0, 6));
      setRecentRuns(runList.slice(0, 5));
      setLoading(false);
    };
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, []);

  const allStepsDone = setup.hasProvider && setup.agentCount > 0 && setup.orgNodeCount > 0 && setup.workspaceCount > 0;

  const steps = [
    {
      num: 1,
      title: "Connect an AI provider",
      description: "Add your OpenAI or Anthropic API key so agents can think.",
      done: setup.hasProvider,
      href: "/settings",
      action: "Open Settings",
    },
    {
      num: 2,
      title: "Create your agents",
      description: "Define at least one agent with a role (pm, dev, audit).",
      done: setup.agentCount > 0,
      href: "/agents",
      action: "Go to Agents",
    },
    {
      num: 3,
      title: "Build your org chart",
      description: "Place agents on the board and define who reports to whom.",
      done: setup.orgNodeCount > 0,
      href: "/org",
      action: "Open Org Chart",
    },
    {
      num: 4,
      title: "Add a workspace",
      description: "Point to a local repo so agents know where to work.",
      done: setup.workspaceCount > 0,
      href: "/workspaces",
      action: "Add Workspace",
    },
  ];

  if (loading) {
    return (
      <main className="flex items-center justify-center py-20">
        <div className="text-sm text-slate-500">Loading dashboard...</div>
      </main>
    );
  }

  return (
    <main className="space-y-6">
      {/* Setup steps - always visible until done, then collapsible */}
      {!allStepsDone && (
        <section className="rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-400/5 to-slate-950/40 p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-white">Get started with Orchestrum</h2>
            <p className="text-sm text-slate-400">Complete these steps to launch your first autonomous run.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step) => (
              <Link
                key={step.num}
                href={step.href}
                className={`group relative rounded-xl border p-4 transition-all ${
                  step.done
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-slate-700 bg-slate-900/40 hover:border-amber-400/40"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      step.done
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-slate-800 text-slate-400 group-hover:bg-amber-400/20 group-hover:text-amber-300"
                    }`}
                  >
                    {step.done ? "✓" : step.num}
                  </div>
                  <div>
                    <div className={`text-sm font-medium ${step.done ? "text-emerald-200" : "text-white"}`}>
                      {step.title}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{step.description}</div>
                  </div>
                </div>
                {!step.done && (
                  <div className="mt-3 text-[10px] font-medium uppercase tracking-[0.2em] text-amber-300/70 opacity-0 transition-opacity group-hover:opacity-100">
                    {step.action} →
                  </div>
                )}
              </Link>
            ))}
          </div>
          <div className="mt-4">
            <div className="h-1.5 rounded-full bg-slate-800">
              <div
                className="h-1.5 rounded-full bg-gradient-to-r from-amber-400/60 to-emerald-400/60 transition-all"
                style={{ width: `${(steps.filter((s) => s.done).length / steps.length) * 100}%` }}
              />
            </div>
            <div className="mt-1 text-right text-[10px] text-slate-500">
              {steps.filter((s) => s.done).length}/{steps.length} complete
            </div>
          </div>
        </section>
      )}

      {/* Quick actions */}
      <section className="grid gap-4 sm:grid-cols-3">
        <button
          onClick={() => openRunConfig()}
          className="group rounded-2xl border border-amber-400/20 bg-slate-950/40 p-5 text-left transition hover:border-amber-400/40"
        >
          <div className="text-lg text-amber-300/80">▶</div>
          <div className="mt-2 text-sm font-semibold text-white">New Run</div>
          <div className="mt-1 text-xs text-slate-500">Start an autonomous mission from a built-in template or custom goal.</div>
        </button>
        <Link
          href="/tasks"
          className="group rounded-2xl border border-cyan-400/20 bg-slate-950/40 p-5 text-left transition hover:border-cyan-400/40"
        >
          <div className="text-lg text-cyan-300/80">▶</div>
          <div className="mt-2 text-sm font-semibold text-white">Assign Task</div>
          <div className="mt-1 text-xs text-slate-500">Send a specific task directly to an agent and track its execution.</div>
        </Link>
        <Link
          href="/mission"
          className="group rounded-2xl border border-emerald-400/20 bg-slate-950/40 p-5 text-left transition hover:border-emerald-400/40"
        >
          <div className="text-lg text-emerald-300/80">◈</div>
          <div className="mt-2 text-sm font-semibold text-white">Live Feed</div>
          <div className="mt-1 text-xs text-slate-500">Watch agents, tasks, and events stream in real time.</div>
        </Link>
      </section>

      {/* Status overview */}
      <section className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Agents", value: setup.agentCount, href: "/agents" },
          { label: "Tasks", value: setup.taskCount, href: "/tasks" },
          { label: "Runs", value: setup.runCount, href: "/runs" },
          { label: "Workspaces", value: setup.workspaceCount, href: "/workspaces" },
        ].map((stat) => (
          <Link
            key={stat.label}
            href={stat.href}
            className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 transition hover:border-slate-700"
          >
            <div className="text-2xl font-bold text-white">{stat.value}</div>
            <div className="text-xs text-slate-500">{stat.label}</div>
          </Link>
        ))}
      </section>

      {/* Agent roster */}
      {agents.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Agent Roster</h3>
            <Link href="/agents" className="text-[10px] uppercase tracking-[0.2em] text-slate-500 hover:text-slate-300">
              View all →
            </Link>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-3 rounded-lg border border-slate-800/60 bg-slate-900/30 px-3 py-2">
                <div className={`h-2 w-2 rounded-full ${
                  normalizeAgentRuntimeState(agent.status.state) === "active" ? "bg-amber-400" :
                  normalizeAgentRuntimeState(agent.status.state) === "sleeping" || normalizeAgentRuntimeState(agent.status.state) === "idle" ? "bg-emerald-400" :
                  "bg-slate-600"
                }`} />
                <div>
                  <div className="text-xs font-medium text-white">{agent.name}</div>
                  <div className="text-[10px] text-slate-500">{agent.role} · {normalizeAgentRuntimeState(agent.status.state)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent runs */}
      {recentRuns.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Recent Runs</h3>
          </div>
          <div className="space-y-2">
            {recentRuns.map((run) => (
              <Link
                key={run.runId}
                href={`/runs/${run.runId}?workspace=${encodeURIComponent(run.workspaceId ?? "")}`}
                className="flex items-center justify-between rounded-lg border border-slate-800/60 bg-slate-900/30 px-4 py-2 transition hover:border-amber-400/30"
              >
                <div>
                  <div className="text-xs font-medium text-white">{run.runId}</div>
                  <div className="text-[10px] text-slate-500">{new Date(run.start).toLocaleString()}</div>
                </div>
                <span className={`text-[10px] uppercase tracking-widest ${statusColor(run.status)}`}>{run.status}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* All done + empty state */}
      {allStepsDone && recentRuns.length === 0 && agents.length > 0 && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-8 text-center">
          <div className="text-2xl">🚀</div>
          <div className="mt-2 text-lg font-semibold text-white">You&apos;re all set</div>
          <p className="mt-1 text-sm text-slate-400">Your platform is configured. Start your first autonomous run.</p>
          <button
            onClick={() => openRunConfig()}
            className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2 text-xs uppercase tracking-[0.3em] text-amber-200"
          >
            Launch first run
          </button>
        </section>
      )}
    </main>
  );
}

function statusColor(status: string) {
  switch (status) {
    case "running":
      return "text-amber-300";
    case "finished":
      return "text-emerald-300";
    case "failed":
      return "text-rose-300";
    case "cancelled":
      return "text-rose-300";
    default:
      return "text-slate-400";
  }
}
