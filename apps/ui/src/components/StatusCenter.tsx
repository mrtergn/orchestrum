"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppUi, type AppToast } from "@/components/AppUiProvider";

type WorkspaceSummary = {
  id: string;
  name?: string;
  path: string;
  status?: string;
  validation?: {
    exists: boolean;
    readable: boolean;
    isDirectory: boolean;
    isGitRepo: boolean;
    error?: string;
  };
};

type Banner = {
  id: string;
  tone: "warning" | "danger" | "info";
  message: string;
  actionLabel?: string;
  actionHref?: string;
};

type RunSummary = {
  runId: string;
  status: string;
  workspaceId?: string;
  error?: string | null;
};

type PlatformTaskSummary = {
  id: string;
  status: string;
  resultSummary?: string;
};

const LAST_FAILED_KEY = "orchestrum.status.lastFailedRun";

export function StatusCenter() {
  const router = useRouter();
  const {
    selectedWorkspaceId,
    onboardingSkipped,
    toasts,
    pushToast,
    dismissToast
  } = useAppUi();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [hasProviderKey, setHasProviderKey] = useState(false);
  const [agentCount, setAgentCount] = useState(0);
  const [orgNodeCount, setOrgNodeCount] = useState(0);
  const [platformError, setPlatformError] = useState<string>("");

  useEffect(() => {
    const refresh = async () => {
      const [workspaceRes, secretsRes, agentsRes, orgRes, tasksRes] = await Promise.all([
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/secrets", { cache: "no-store" }),
        fetch("/api/agents", { cache: "no-store" }),
        fetch("/api/org", { cache: "no-store" }),
        fetch("/api/tasks", { cache: "no-store" })
      ]);
      const workspaceData = workspaceRes.ok ? await workspaceRes.json() : { workspaces: [] };
      const secretsData = secretsRes.ok ? await secretsRes.json() : { keys: {} };
      const agentsData = agentsRes.ok ? await agentsRes.json() : { agents: [] };
      const orgData = orgRes.ok ? await orgRes.json() : { nodes: [] };
      const tasksData = tasksRes.ok ? await tasksRes.json() : { tasks: [] };

      const openAiOk = Boolean(secretsData.keys?.OPENAI_API_KEY);
      const anthropicOk = Boolean(secretsData.keys?.ANTHROPIC_API_KEY);
      const tasks = Array.isArray(tasksData.tasks) ? (tasksData.tasks as PlatformTaskSummary[]) : [];
      const latestPlatformFailure = tasks.find((task) => task.status === "failed" && typeof task.resultSummary === "string" && task.resultSummary.trim());

      setWorkspaces(workspaceData.workspaces ?? []);
      setHasProviderKey(openAiOk || anthropicOk);
      setAgentCount(Array.isArray(agentsData.agents) ? agentsData.agents.length : 0);
      setOrgNodeCount(Array.isArray(orgData.nodes) ? orgData.nodes.length : 0);
      setPlatformError(latestPlatformFailure?.resultSummary?.trim() ?? "");
    };
    void refresh();
    const timer = setInterval(refresh, 8000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const checkFailedRun = async () => {
      const query = selectedWorkspaceId ? `?workspace=${encodeURIComponent(selectedWorkspaceId)}` : "";
      const runsRes = await fetch(`/api/runs${query}`, { cache: "no-store" });
      if (!runsRes.ok) return;
      const runs = (await runsRes.json()) as RunSummary[];
      const latest = runs[0];
      if (!latest || latest.status !== "failed") return;
      const lastSeen = localStorage.getItem(LAST_FAILED_KEY);
      if (lastSeen === latest.runId) return;
      localStorage.setItem(LAST_FAILED_KEY, latest.runId);
      pushToast({
        tone: "danger",
        title: `Run ${latest.runId} failed`,
        message: latest.error ?? "Review the run details and retry from the last step.",
        actionLabel: "Retry from last step",
        actionPayload: {
          type: "retry-run",
          runId: latest.runId,
          workspaceId: latest.workspaceId ?? (selectedWorkspaceId || undefined)
        }
      });
    };
    void checkFailedRun();
    const timer = setInterval(checkFailedRun, 10000);
    return () => clearInterval(timer);
  }, [pushToast, selectedWorkspaceId]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  );

  const banners = useMemo<Banner[]>(() => {
    const list: Banner[] = [];
    if (!hasProviderKey) {
      list.push({
        id: "missing-provider-key",
        tone: "warning",
        message: "No provider key configured. Add OPENAI_API_KEY or ANTHROPIC_API_KEY in Settings > AI Providers.",
        actionLabel: "Open Settings",
        actionHref: "/settings"
      });
    }
    if (agentCount === 0) {
      list.push({
        id: "no-agents",
        tone: "warning",
        message: "No agents registered yet. Create your first agent in Agent Registry.",
        actionLabel: "Open Agents",
        actionHref: "/agents"
      });
    }
    if (agentCount > 0 && orgNodeCount === 0) {
      list.push({
        id: "no-org",
        tone: "info",
        message: "Org structure is empty. Build your command map to unlock clear routing.",
        actionLabel: "Open Org",
        actionHref: "/org"
      });
    }
    if (selectedWorkspace && selectedWorkspace.validation && selectedWorkspace.status === "invalid") {
      list.push({
        id: "invalid-workspace",
        tone: "danger",
        message: selectedWorkspace.validation.error ?? "Selected workspace path is invalid or unreadable.",
        actionLabel: "Fix Workspace",
        actionHref: "/workspaces"
      });
    }
    if (onboardingSkipped) {
      list.push({
        id: "onboarding-skipped",
        tone: "info",
        message: "Onboarding was skipped. You can reopen it from Help.",
        actionLabel: "Open Help",
        actionHref: "/help"
      });
    }
    const lowerError = platformError.toLowerCase();
    if (lowerError.includes("missing api key") || lowerError.includes("provider")) {
      list.push({
        id: "provider-error",
        tone: "danger",
        message: `Provider error: ${platformError}`,
        actionLabel: "Open Settings",
        actionHref: "/settings"
      });
    } else if (lowerError.includes("patch apply failed")) {
      list.push({
        id: "patch-error",
        tone: "danger",
        message: `Patch apply error: ${platformError}`,
        actionLabel: "Open Tasks",
        actionHref: "/tasks"
      });
    }
    return list;
  }, [agentCount, hasProviderKey, onboardingSkipped, orgNodeCount, platformError, selectedWorkspace]);

  const runToastAction = async (toast: AppToast) => {
    if (!toast.actionPayload || toast.actionPayload.type !== "retry-run") return;
    const workspaceId = toast.actionPayload.workspaceId ?? selectedWorkspaceId;
    const res = await fetch(`/api/runs/${toast.actionPayload.runId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspaceId || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      pushToast({
        tone: "danger",
        title: "Retry failed",
        message: payload.error ?? "Unable to resume run."
      });
      return;
    }
    pushToast({
      tone: "success",
      title: "Retry started",
      message: `Resumed from ${payload.fromStepId ?? "last step"}.`
    });
    router.push(`/runs/${toast.actionPayload.runId}?workspace=${encodeURIComponent(workspaceId || "")}`);
  };

  return (
    <div className="space-y-2">
      {banners.map((banner) => (
        <div
          key={banner.id}
          className={`rounded-xl border px-4 py-2 text-xs ${
            banner.tone === "danger"
              ? "border-rose-400/50 bg-rose-400/10 text-rose-200"
              : banner.tone === "warning"
                ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
                : "border-sky-400/50 bg-sky-400/10 text-sky-200"
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <span>{banner.message}</span>
            {banner.actionHref && banner.actionLabel && (
              <Link className="underline decoration-dotted underline-offset-4" href={banner.actionHref}>
                {banner.actionLabel}
              </Link>
            )}
          </div>
        </div>
      ))}
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`rounded-xl border px-4 py-2 text-xs ${
            toast.tone === "danger"
              ? "border-rose-400/50 bg-rose-400/10 text-rose-200"
              : toast.tone === "warning"
                ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
                : toast.tone === "success"
                  ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200"
                  : "border-sky-400/50 bg-sky-400/10 text-sky-200"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-semibold">{toast.title}</div>
              {toast.message && <div className="mt-1">{toast.message}</div>}
            </div>
            <div className="flex items-center gap-3">
              {toast.actionHref && toast.actionLabel && (
                <Link className="underline decoration-dotted underline-offset-4" href={toast.actionHref}>
                  {toast.actionLabel}
                </Link>
              )}
              {!toast.actionHref && toast.actionPayload && toast.actionLabel && (
                <button
                  onClick={() => void runToastAction(toast)}
                  className="underline decoration-dotted underline-offset-4"
                >
                  {toast.actionLabel}
                </button>
              )}
              <button onClick={() => dismissToast(toast.id)} className="text-[10px] uppercase tracking-[0.3em] opacity-80">
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
