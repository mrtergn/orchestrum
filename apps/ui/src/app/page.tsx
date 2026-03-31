"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AgentOnboarding } from "@/components/AgentOnboarding";
import { useAppUi } from "@/components/AppUiProvider";
import { preferredTransport, type ProviderDiscoveryRecord } from "@/lib/providers";
import { normalizeAgentRuntimeState } from "@/lib/runtime";

type SetupStatus = {
  hasRunnableProvider: boolean;
  workspaceCount: number;
  taskCount: number;
  totalRunCount: number;
  orgNodeCount: number;
  guideWorkspaceId: string;
  guideWorkspaceName: string;
  guideAgentCount: number;
  guideRunCount: number;
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
  workspaceId?: string;
  name: string;
  role: string;
  status: { state: string };
};

type WorkspaceSummary = {
  id: string;
  name?: string;
  path: string;
};

type ProviderDiscoveryPayload = {
  providers?: ProviderDiscoveryRecord[];
};

type StepId = "workspace" | "provider" | "agents" | "run";

type SetupStep = {
  id: StepId;
  title: string;
  description: string;
  success: string;
  done: boolean;
  actionLabel: string;
  href?: string;
  onSelect?: () => void;
};

function hasConfiguredProvider(records: ProviderDiscoveryRecord[]) {
  return records.some((record) => {
    const transport = preferredTransport(record);
    return Boolean(transport?.configured && (transport.transport === "cli" || transport.transport === "local_http"));
  });
}

function statusColor(status: string) {
  switch (status) {
    case "running":
      return "text-amber-300";
    case "finished":
      return "text-emerald-300";
    case "failed":
    case "cancelled":
      return "text-rose-300";
    default:
      return "text-slate-400";
  }
}

function nextActionReason(stepId: StepId) {
  if (stepId === "workspace") {
    return "Everything else in Orchestrum is workspace-scoped. Without a repo, there is nowhere to save agents or run missions.";
  }
  if (stepId === "provider") {
    return "Before the first run, confirm there is at least one usable local CLI path or API fallback.";
  }
  if (stepId === "agents") {
    return "Missions need at least one workspace agent so Orchestrum knows who should do the work.";
  }
  return "The fastest way to validate setup is a small real mission, not another settings screen.";
}

export default function HomePage() {
  const router = useRouter();
  const {
    openRunConfig,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    onboardingSkipped,
    setOnboardingSkipped
  } = useAppUi();
  const [setup, setSetup] = useState<SetupStatus>({
    hasRunnableProvider: false,
    workspaceCount: 0,
    taskCount: 0,
    totalRunCount: 0,
    orgNodeCount: 0,
    guideWorkspaceId: "",
    guideWorkspaceName: "",
    guideAgentCount: 0,
    guideRunCount: 0
  });
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [workspacesRes, tasksRes, orgRes, runsRes, agentsRes, secretsRes] = await Promise.all([
          fetch("/api/workspaces", { cache: "no-store" }),
          fetch("/api/tasks", { cache: "no-store" }),
          fetch("/api/org", { cache: "no-store" }),
          fetch("/api/runs", { cache: "no-store" }),
          fetch("/api/agents", { cache: "no-store" }),
          fetch("/api/secrets", { cache: "no-store" })
        ]);

        const workspacesData = workspacesRes.ok ? await workspacesRes.json() : { workspaces: [] };
        const tasksData = tasksRes.ok ? await tasksRes.json() : { tasks: [] };
        const orgData = orgRes.ok ? await orgRes.json() : { nodes: [] };
        const runsData = runsRes.ok ? await runsRes.json() : [];
        const agentsData = agentsRes.ok ? await agentsRes.json() : { agents: [] };
        const secretsData = secretsRes.ok ? await secretsRes.json() : { keys: {} };

        const workspaceList = Array.isArray(workspacesData.workspaces)
          ? (workspacesData.workspaces as WorkspaceSummary[])
          : [];
        const allRuns = Array.isArray(runsData) ? (runsData as RecentRun[]) : [];
        const allAgents = Array.isArray(agentsData.agents) ? (agentsData.agents as AgentSummary[]) : [];
        const guideWorkspace = workspaceList.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaceList[0] ?? null;
        const guideWorkspaceId = guideWorkspace?.id ?? "";
        const guideWorkspaceName = guideWorkspace?.name || guideWorkspace?.id || "";
        const providerQuery = guideWorkspaceId
          ? `/api/providers/discover?scope=workspace&workspace=${encodeURIComponent(guideWorkspaceId)}`
          : "/api/providers/discover?scope=global";
        const providerRes = await fetch(providerQuery, { cache: "no-store" });
        const providerData = providerRes.ok
          ? ((await providerRes.json()) as ProviderDiscoveryPayload)
          : { providers: [] };
        const providerDiscovery = Array.isArray(providerData.providers) ? providerData.providers : [];
        const hasProviderKey = Boolean(secretsData.keys?.OPENAI_API_KEY || secretsData.keys?.ANTHROPIC_API_KEY);
        const guideAgents = guideWorkspaceId ? allAgents.filter((agent) => agent.workspaceId === guideWorkspaceId) : [];
        const guideRuns = guideWorkspaceId ? allRuns.filter((run) => run.workspaceId === guideWorkspaceId) : [];

        if (cancelled) return;

        setSetup({
          hasRunnableProvider: hasProviderKey || hasConfiguredProvider(providerDiscovery),
          workspaceCount: workspaceList.length,
          taskCount: Array.isArray(tasksData.tasks) ? tasksData.tasks.length : 0,
          totalRunCount: allRuns.length,
          orgNodeCount: Array.isArray(orgData.nodes) ? orgData.nodes.length : 0,
          guideWorkspaceId,
          guideWorkspaceName,
          guideAgentCount: guideAgents.length,
          guideRunCount: guideRuns.length
        });
        setAgents((guideWorkspaceId ? guideAgents : allAgents).slice(0, 6));
        setRecentRuns((guideWorkspaceId ? guideRuns : allRuns).slice(0, 5));
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
  }, [selectedWorkspaceId]);

  const steps = useMemo<SetupStep[]>(() => {
    const workspaceQuery = setup.guideWorkspaceId ? `&workspace=${encodeURIComponent(setup.guideWorkspaceId)}` : "";
    const providerHref = setup.guideWorkspaceId
      ? `/settings?tab=Providers&scope=workspace${workspaceQuery}`
      : "/settings?tab=Providers&scope=workspace";
    const agentHref = `/agents?intent=create&preset=dev${workspaceQuery}`;

    return [
      {
        id: "workspace",
        title: "Add a workspace",
        description: "Connect the local repository you want Orchestrum to work in.",
        success: "At least one local repo is registered.",
        done: setup.workspaceCount > 0,
        actionLabel: "Add workspace",
        href: "/workspaces?intent=add"
      },
      {
        id: "provider",
        title: "Verify local tools",
        description: setup.guideWorkspaceId
          ? `Check Claude, Codex, Copilot, or Cursor status for ${setup.guideWorkspaceName}. API fallback stays optional.`
          : "Confirm that at least one local CLI path or API fallback is usable.",
        success: "At least one local provider or API fallback is ready.",
        done: setup.hasRunnableProvider,
        actionLabel: "Verify local tools",
        href: providerHref
      },
      {
        id: "agents",
        title: "Create your first agent",
        description: setup.guideWorkspaceId
          ? `Start with a Developer agent inside ${setup.guideWorkspaceName}.`
          : "Create one agent so Orchestrum has someone to route work to.",
        success: "At least one agent exists in the active workspace.",
        done: setup.guideAgentCount > 0,
        actionLabel: "Create first agent",
        href: agentHref
      },
      {
        id: "run",
        title: "Launch first mission",
        description: setup.guideWorkspaceId
          ? `Run a small feature-dev mission in ${setup.guideWorkspaceName} to verify the loop.`
          : "Launch a first mission after workspace, provider, and agent setup is done.",
        success: "This workspace has at least one mission run.",
        done: setup.guideRunCount > 0,
        actionLabel: "Launch first mission",
        onSelect: () => {
          if (!setup.guideWorkspaceId) return;
          setSelectedWorkspaceId(setup.guideWorkspaceId);
          openRunConfig({
            workspaceId: setup.guideWorkspaceId,
            missionTemplateId: "feature-dev",
            runKind: "mission"
          });
        }
      }
    ];
  }, [openRunConfig, setSelectedWorkspaceId, setup]);

  const nextAction = steps.find((step) => !step.done) ?? null;
  const completedSteps = steps.filter((step) => step.done).length;
  const allCoreSetupDone = steps.every((step) => step.done);
  const showRecommendedLater = allCoreSetupDone && setup.orgNodeCount === 0;

  const handleStepNavigate = (step: SetupStep) => {
    if (step.id !== "workspace" && setup.guideWorkspaceId) {
      setSelectedWorkspaceId(setup.guideWorkspaceId);
    }
    if (step.onSelect) {
      step.onSelect();
      return;
    }
    if (step.href) {
      router.push(step.href);
    }
  };

  if (loading) {
    return (
      <main className="flex items-center justify-center py-20">
        <div className="text-sm text-slate-500">Loading dashboard...</div>
      </main>
    );
  }

  return (
    <main className="space-y-6">
      <AgentOnboarding onVisibilityChange={setShowOnboarding} />

      {!showOnboarding && !allCoreSetupDone && nextAction && (
        <section className="space-y-4 rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-400/5 to-slate-950/40 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-amber-300/80">Next Action</div>
              <h2 className="mt-2 text-xl font-semibold text-white">{nextAction.title}</h2>
              <p className="mt-2 max-w-3xl text-sm text-slate-300">{nextAction.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onboardingSkipped && (
                <button
                  type="button"
                  onClick={() => setOnboardingSkipped(false)}
                  className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300"
                >
                  Reopen guided setup
                </button>
              )}
              <div className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-300">
                Step {completedSteps + 1} of {steps.length}
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Why this now</div>
              <div className="mt-2 text-sm text-slate-300">{nextActionReason(nextAction.id)}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Done when</div>
              <div className="mt-2 text-sm text-slate-300">{nextAction.success}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <button
              onClick={() => handleStepNavigate(nextAction)}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2 text-xs uppercase tracking-[0.24em] text-amber-200"
            >
              {nextAction.actionLabel}
            </button>
            {setup.guideWorkspaceName && (
              <div className="text-xs text-slate-500">
                Active workspace for guidance: <span className="text-slate-300">{setup.guideWorkspaceName}</span>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm font-medium text-white">Setup checklist</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{completedSteps}/{steps.length} complete</div>
            </div>
            <div className="space-y-2">
              {steps.map((step, index) => {
                const isCurrent = nextAction?.id === step.id;
                const content = (
                  <>
                    <div
                      className={step.done
                        ? "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-semibold text-emerald-300"
                        : "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-slate-400"}
                    >
                      {step.done ? "✓" : index + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-medium ${step.done ? "text-emerald-200" : "text-white"}`}>{step.title}</div>
                      <div className="mt-1 text-xs text-slate-500">{step.success}</div>
                    </div>
                    {step.done ? null : isCurrent ? (
                      <div className="text-[10px] uppercase tracking-[0.18em] text-amber-300/80">Current →</div>
                    ) : (
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Open →</div>
                    )}
                  </>
                );

                if (step.done) {
                  return (
                    <div key={step.id} className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                      {content}
                    </div>
                  );
                }

                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => handleStepNavigate(step)}
                    className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                      isCurrent
                        ? "border-amber-400/20 bg-amber-400/5 hover:border-amber-400/35"
                        : "border-slate-800 bg-slate-900/35 hover:border-slate-700"
                    }`}
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {showRecommendedLater && (
        <section className="rounded-2xl border border-cyan-400/20 bg-slate-950/35 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">Recommended Later</div>
              <div className="mt-2 text-sm font-semibold text-white">Build the org chart after your first run</div>
              <div className="mt-1 text-sm text-slate-400">
                Core setup is already complete. Add reporting lines once your first agent loop is working and you want clearer routing.
              </div>
            </div>
            <Link
              href="/org"
              className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-cyan-200"
            >
              Open Org Chart
            </Link>
          </div>
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <button
          onClick={() => openRunConfig(setup.guideWorkspaceId ? { workspaceId: setup.guideWorkspaceId } : undefined)}
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

      <section className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Agents", value: setup.guideAgentCount, href: "/agents" },
          { label: "Tasks", value: setup.taskCount, href: "/tasks" },
          { label: "Runs", value: setup.totalRunCount, href: "/runs" },
          { label: "Workspaces", value: setup.workspaceCount, href: "/workspaces" }
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

      {agents.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Agent Roster</h3>
            <Link href="/agents" className="text-[10px] uppercase tracking-[0.2em] text-slate-500 hover:text-slate-300">
              View all →
            </Link>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => {
              const normalizedState = normalizeAgentRuntimeState(agent.status.state);
              return (
                <div key={agent.id} className="flex items-center gap-3 rounded-lg border border-slate-800/60 bg-slate-900/30 px-3 py-2">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      normalizedState === "active"
                        ? "bg-amber-400"
                        : normalizedState === "sleeping" || normalizedState === "idle"
                          ? "bg-emerald-400"
                          : "bg-slate-600"
                    }`}
                  />
                  <div>
                    <div className="text-xs font-medium text-white">{agent.name}</div>
                    <div className="text-[10px] text-slate-500">{agent.role} · {normalizedState}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

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
    </main>
  );
}
