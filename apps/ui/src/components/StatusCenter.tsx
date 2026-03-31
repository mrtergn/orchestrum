"use client";

import Link from "next/link";
import { useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppUi, type AppToast } from "@/components/AppUiProvider";
import { useRuns } from "@/lib/queries/useRuns";
import { useWorkspaces, type WorkspaceSummary } from "@/lib/queries/useWorkspaces";
import { useAgents } from "@/lib/queries/useAgents";
import { preferredTransport, type ProviderDiscoveryRecord } from "@/lib/providers";
import { fetchJson } from "@/lib/queries/client";
import { useEventSource } from "@/lib/hooks/useEventSource";

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

type ProviderDiscoveryPayload = {
  providers?: ProviderDiscoveryRecord[];
};

const LAST_FAILED_KEY = "orchestrum.status.lastFailedRun";

export function StatusCenter() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    selectedWorkspaceId,
    onboardingSkipped,
    toasts,
    pushToast,
    dismissToast
  } = useAppUi();

  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAgents();
  const { data: runs = [] } = useRuns(selectedWorkspaceId || undefined);

  const { data: secretsData } = useQuery({
    queryKey: ["secrets"],
    queryFn: () => fetchJson<{ keys?: Record<string, string | null> }>("/api/secrets"),
    staleTime: 5000
  });

  const { data: orgData } = useQuery({
    queryKey: ["org"],
    queryFn: () => fetchJson<{ nodes?: unknown[] }>("/api/org"),
    staleTime: 5000
  });

  const { data: tasksData } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchJson<{ tasks?: PlatformTaskSummary[] }>("/api/tasks"),
    staleTime: 5000
  });

  const { data: providerDiscoveryData, isSuccess: providerDiscoveryReady } = useQuery({
    queryKey: ["providers", "global"],
    queryFn: () => fetchJson<ProviderDiscoveryPayload>("/api/providers/discover?scope=global"),
    staleTime: 30000,
    retry: false
  });

  const handleSseMessage = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["runs"] });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["agents"] });
    void queryClient.invalidateQueries({ queryKey: ["org"] });
    void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  }, [queryClient]);

  useEventSource("/api/events", handleSseMessage);

  useEffect(() => {
    const latest = runs[0] as RunSummary | undefined;
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
  }, [runs, pushToast, selectedWorkspaceId]);

  const hasProviderKey = Boolean(secretsData?.keys?.OPENAI_API_KEY || secretsData?.keys?.ANTHROPIC_API_KEY);
  const agentCount = agents.length;
  const workspaceCount = workspaces.length;
  const orgNodeCount = Array.isArray(orgData?.nodes) ? orgData.nodes.length : 0;
  const tasks = Array.isArray(tasksData?.tasks) ? tasksData.tasks : [];
  const latestPlatformFailure = tasks.find((task) => task.status === "failed" && typeof task.resultSummary === "string" && task.resultSummary.trim());
  const platformError = latestPlatformFailure?.resultSummary?.trim() ?? "";
  const providerDiscovery = Array.isArray(providerDiscoveryData?.providers) ? providerDiscoveryData.providers : [];
  const hasConfiguredCliProvider = providerDiscovery.some((record) => {
    const transport = preferredTransport(record);
    return Boolean(transport?.configured && (transport.transport === "cli" || transport.transport === "local_http"));
  });
  const hasAnyConfiguredProvider = hasProviderKey || hasConfiguredCliProvider;
  const hasAnyLocalProvider = providerDiscovery.some((record) =>
    record.transports.some((transport) => transport.available && (transport.transport === "cli" || transport.transport === "local_http"))
  );
  const isFreshSetup = !onboardingSkipped && workspaceCount === 0 && agentCount === 0;

  const selectedWorkspace = useMemo(
    () => (workspaces as WorkspaceSummary[]).find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  );

  const banners = useMemo<Banner[]>(() => {
    const list: Banner[] = [];
    if (!isFreshSetup && providerDiscoveryReady && !hasAnyConfiguredProvider) {
      list.push({
        id: "missing-provider-key",
        tone: hasAnyLocalProvider ? "info" : "warning",
        message: hasAnyLocalProvider
          ? "No provider auth detected yet. API keys are optional if you plan to use CLI or local providers."
          : "No provider configured yet. Connect a local CLI session or add OPENAI_API_KEY / ANTHROPIC_API_KEY in Settings > AI Providers.",
        actionLabel: "Open Settings",
        actionHref: "/settings"
      });
    }
    if (agentCount === 0 && workspaceCount > 0) {
      list.push({
        id: "no-agents",
        tone: "info",
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
  }, [
    agentCount,
    hasAnyConfiguredProvider,
    hasAnyLocalProvider,
    isFreshSetup,
    onboardingSkipped,
    orgNodeCount,
    platformError,
    providerDiscoveryReady,
    selectedWorkspace,
    workspaceCount
  ]);

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
