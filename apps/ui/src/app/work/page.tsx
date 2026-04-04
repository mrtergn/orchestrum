"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  WorkItemCreateRequest,
  WorkItemRecord,
  WorkItemsResponse,
  WorkOrganizationControl,
  WorkOrganizationControlResponse,
  WorkItemSourceType,
  WorkItemStartResponse,
  WorkItemTeamRuntime,
  WorkItemTeamSelectionLane,
  WorkWorkspaceOptimizationSummary
} from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";
import {
  EmptyState,
  KeyValueGrid,
  MetricStrip,
  NoticePanel,
  PageHeader,
  SurfacePanel
} from "@/components/ui/PagePrimitives";
import {
  preferredTransport,
  providerDiscoveryBadgeLabel,
  providerDiscoveryExplanation,
  providerDiscoverySummaryLabel
} from "@/lib/providers";
import { useProviderDiscovery } from "@/lib/queries/useProviderDiscovery";
import { buildWorkspaceApiPath, rememberRecentWorkspacePath } from "@/lib/workspaces";

type WorkspaceSummary = {
  id: string;
  name?: string;
  path: string;
};

type WorkItemResponse = {
  workItem?: WorkItemRecord;
  error?: string;
};

type WorkItemsPayload = WorkItemsResponse & {
  optimizationSummary?: WorkWorkspaceOptimizationSummary | null;
};

type WorkItemTeamSnapshotResponse = {
  teamRuntime?: WorkItemTeamRuntime | null;
  teamSelection?: WorkItemTeamSelectionLane[];
};

type LaunchMode = "feature" | "audit" | "browser";

const LAUNCH_OPTIONS: Array<{
  id: LaunchMode;
  label: string;
  kicker: string;
  description: string;
  sourceType?: WorkItemSourceType;
  templateId?: string;
  titlePlaceholder?: string;
  refLabel?: string;
  refPlaceholder?: string;
  requestLabel?: string;
  requestPlaceholder?: string;
  acceptanceLabel?: string;
  acceptancePlaceholder?: string;
  constraintsLabel?: string;
  constraintsPlaceholder?: string;
}> = [
  {
    id: "feature",
    label: "Feature",
    kicker: "Product work",
    description: "Start a scoped implementation request with acceptance criteria and guardrails.",
    sourceType: "feature",
    templateId: "feature-dev",
    titlePlaceholder: "Name the feature work item",
    refLabel: "Context reference",
    refPlaceholder: "Optional doc, ticket, or design reference",
    requestLabel: "Request",
    requestPlaceholder: "Describe the goal, current context, and what should be delivered.",
    acceptanceLabel: "Acceptance criteria",
    acceptancePlaceholder: "One criterion per line\nUI state is visible\nRegression is covered",
    constraintsLabel: "Constraints",
    constraintsPlaceholder: "One constraint per line\nNo schema changes\nKeep scope inside ui package"
  },
  {
    id: "audit",
    label: "Audit",
    kicker: "Review work",
    description: "Run a focused audit and produce findings without turning this into a delivery control room.",
    sourceType: "audit",
    templateId: "audit-only",
    titlePlaceholder: "Name the audit",
    refLabel: "Scope reference",
    refPlaceholder: "Optional diff, file, PR, issue, or repo area",
    requestLabel: "Audit request",
    requestPlaceholder: "Describe what should be audited and which risks or regressions should be prioritized.",
    acceptanceLabel: "Audit priorities",
    acceptancePlaceholder: "One focus per line\nCorrectness\nRegression risk\nMissing validation",
    constraintsLabel: "Guardrails",
    constraintsPlaceholder: "One guardrail per line\nDo not edit files\nStay inside ui package"
  },
  {
    id: "browser",
    label: "Browser Smoke",
    kicker: "UI evidence",
    description: "Start browser evidence from Work when you need smoke or scenario proof instead of a long-lived work item."
  }
];

const STATUS_STYLES: Record<string, string> = {
  draft: "border-slate-700 bg-slate-900/60 text-slate-300",
  running: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  blocked: "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200",
  ready_for_review: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  completed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  failed: "border-rose-400/30 bg-rose-400/10 text-rose-200"
};

function statusClassName(status: string) {
  return STATUS_STYLES[status] ?? STATUS_STYLES.draft;
}

function statusLabel(status: string) {
  if (status === "ready_for_review") return "Ready for review";
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function executionModeLabel(workItem: WorkItemRecord) {
  if (workItem.executionMode === "task_graph" || (workItem.linkedTaskIds?.length ?? 0) > 0) return "Task graph";
  if (workItem.executionMode === "mission" || workItem.linkedRunId) return "Mission run";
  return "Not started";
}

function hasActiveExecution(workItem: WorkItemRecord) {
  const activeStatuses = new Set(["queued", "running", "active", "paused"]);
  const runStatus = workItem.linkedRunStatus?.trim().toLowerCase() ?? "";
  const taskStatus = workItem.linkedTaskStatus?.trim().toLowerCase() ?? "";
  return activeStatuses.has(runStatus) || activeStatuses.has(taskStatus);
}

function launchActionLabel(workItem: WorkItemRecord) {
  if (workItem.reviewStatus === "changes_requested") return "Launch remediation";
  if (workItem.linkedRunId || (workItem.linkedTaskIds?.length ?? 0) > 0) return "Relaunch";
  return "Launch";
}

function splitMultilineList(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function workItemKindLabel(workItem: WorkItemRecord) {
  if (workItem.brief.sourceType === "audit" || workItem.recommendedTemplateId === "audit-only") {
    return "Audit";
  }
  switch (workItem.brief.sourceType) {
    case "bug":
      return "Bug";
    case "pbi":
      return "Sprint / PBI";
    case "pr_hardening":
      return "PR Hardening";
    default:
      return "Feature";
  }
}

function sortByUpdatedAtDesc(items: WorkItemRecord[]) {
  return items.slice().sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
    const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
    return rightTime - leftTime;
  });
}

function WorkItemCard({
  workItem,
  workspaceId,
  action,
  secondary
}: {
  workItem: WorkItemRecord;
  workspaceId: string;
  action?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/work/${workItem.id}?workspace=${encodeURIComponent(workspaceId)}`}
            className="text-sm font-medium text-white transition hover:text-amber-100"
          >
            {workItem.brief.title}
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span>{workItemKindLabel(workItem)}</span>
            <span>•</span>
            <span>{executionModeLabel(workItem)}</span>
            <span>•</span>
            <span>{new Date(workItem.updatedAt).toLocaleString()}</span>
          </div>
          {secondary ? <div className="mt-3 text-xs text-slate-400">{secondary}</div> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${statusClassName(workItem.status)}`}>
            {workItem.reviewStatus === "changes_requested" ? "Changes requested" : statusLabel(workItem.status)}
          </span>
          {action}
        </div>
      </div>
    </div>
  );
}

export default function WorkIntakePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selectedWorkspaceId, setSelectedWorkspaceId, openRunConfig, pushToast } = useAppUi();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [organizationControl, setOrganizationControl] = useState<WorkOrganizationControl | null>(null);
  const [optimizationSummary, setOptimizationSummary] = useState<WorkWorkspaceOptimizationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [launchMode, setLaunchMode] = useState<LaunchMode>("feature");
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "launch">("");
  const [launchingId, setLaunchingId] = useState("");
  const [workspacePathInput, setWorkspacePathInput] = useState("");
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState("");
  const [pendingBrowserLaunch, setPendingBrowserLaunch] = useState(false);
  const [teamSnapshot, setTeamSnapshot] = useState<{
    workItemId: string;
    teamRuntime: WorkItemTeamRuntime | null;
    teamSelection: WorkItemTeamSelectionLane[];
  } | null>(null);
  const [teamSnapshotLoading, setTeamSnapshotLoading] = useState(false);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces]
  );
  const selectedLaunch = useMemo(
    () => LAUNCH_OPTIONS.find((option) => option.id === launchMode) ?? LAUNCH_OPTIONS[0]!,
    [launchMode]
  );
  const providerDiscovery = useProviderDiscovery({
    scope: "workspace",
    workspaceId: activeWorkspace?.id,
    enabled: Boolean(activeWorkspace?.id)
  });
  const queryLaunchMode = useMemo(() => {
    const value = searchParams.get("launch");
    return value === "feature" || value === "audit" || value === "browser" ? value : null;
  }, [searchParams]);

  const providerLead = useMemo(() => {
    const orderedProviders = providerDiscovery.providers.map((record) => ({
      record,
      transport: preferredTransport(record)
    }));
    return orderedProviders.find((entry) => entry.transport?.configured)
      ?? orderedProviders.find((entry) => entry.transport?.available)
      ?? orderedProviders[0]
      ?? null;
  }, [providerDiscovery.providers]);
  const providerBadgeLabel = providerDiscovery.isLoading
    ? "Checking"
    : providerLead
      ? providerDiscoveryBadgeLabel(providerLead.transport)
      : "Not ready";
  const providerBadgeClassName = providerLead?.transport?.configured
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
    : providerLead?.transport?.available
      ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
      : "border-rose-400/30 bg-rose-400/10 text-rose-200";
  const providerHeadline = providerDiscovery.isLoading
    ? "Checking provider readiness"
    : providerLead?.record.label ?? "No provider route";
  const providerSummary = providerDiscovery.error
    ? providerDiscovery.error
    : providerLead
      ? providerDiscoverySummaryLabel(providerLead.transport)
      : activeWorkspace
        ? "Open Settings to connect or sign in to a provider before the first launch."
        : "Choose a workspace to inspect provider readiness.";
  const providerExplanation = providerDiscovery.error
    ? "Provider discovery could not finish for this workspace."
    : providerLead
      ? providerDiscoveryExplanation(providerLead.transport)
      : activeWorkspace
        ? "The first launch will stay brittle until one provider route is ready."
        : "Provider status appears after you select a workspace.";
  const launchStepSummary = launchMode === "feature"
    ? "Create one feature work item and jump straight into its live session."
    : launchMode === "audit"
      ? "Create one review work item and keep findings, handoffs, and the decision loop in the same place."
      : "Start one browser evidence run from Work. It does not create a long-lived work item.";
  const reviewStepSummary = launchMode === "browser"
    ? "Use Runs only if the smoke summary is not enough and you need deeper evidence."
    : "Approve, send back, or relaunch directly from the live session when the team reaches review.";

  useEffect(() => {
    if (!queryLaunchMode) return;
    setLaunchMode(queryLaunchMode);
    if (queryLaunchMode === "browser") {
      setPendingBrowserLaunch(true);
    }
    router.replace("/work", { scroll: false });
  }, [queryLaunchMode, router]);

  useEffect(() => {
    if (!pendingBrowserLaunch || !activeWorkspace?.id) return;
    openRunConfig({
      workspaceId: activeWorkspace.id,
      runKind: "qa"
    });
    setPendingBrowserLaunch(false);
  }, [activeWorkspace?.id, openRunConfig, pendingBrowserLaunch]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const workspaceRes = await fetch(buildWorkspaceApiPath("/api/workspaces"), { cache: "no-store" });
      const workspaceData = workspaceRes.ok ? await workspaceRes.json() : { workspaces: [] };
      const nextWorkspaces = Array.isArray(workspaceData.workspaces)
        ? (workspaceData.workspaces as WorkspaceSummary[])
        : [];
      setWorkspaces(nextWorkspaces);

      const fallbackWorkspaceId = selectedWorkspaceId || nextWorkspaces[0]?.id || "";
      if (!selectedWorkspaceId && fallbackWorkspaceId) {
        setSelectedWorkspaceId(fallbackWorkspaceId);
      }
      if (!fallbackWorkspaceId) {
        setWorkItems([]);
        setOrganizationControl(null);
        setOptimizationSummary(null);
        return;
      }

      const [workItemsRes, controlRes] = await Promise.all([
        fetch(`/api/work-items?workspace=${encodeURIComponent(fallbackWorkspaceId)}`, {
          cache: "no-store"
        }),
        fetch(`/api/work-items/organization-control?workspace=${encodeURIComponent(fallbackWorkspaceId)}`, {
          cache: "no-store"
        })
      ]);
      const workItemsData = workItemsRes.ok
        ? ((await workItemsRes.json()) as WorkItemsPayload)
        : { workItems: [] };
      const controlData = controlRes.ok
        ? ((await controlRes.json()) as WorkOrganizationControlResponse)
        : { ok: false };
      setWorkItems(Array.isArray(workItemsData.workItems) ? workItemsData.workItems : []);
      setOptimizationSummary(workItemsData.optimizationSummary ?? null);
      setOrganizationControl(controlData.ok && controlData.control ? controlData.control : null);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [selectedWorkspaceId, setSelectedWorkspaceId]);

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => {
      void load(true);
    }, 6000);
    return () => clearInterval(timer);
  }, [load]);

  const createWorkItem = useCallback(
    async (mode: "draft" | "launch") => {
      if (!activeWorkspace?.id || !selectedLaunch.sourceType || !selectedLaunch.templateId) {
        pushToast({
          tone: "warning",
          title: "Workspace required",
          message: "Select a workspace before creating work."
        });
        return;
      }
      const payload: WorkItemCreateRequest = {
        workspaceId: activeWorkspace.id,
        sourceType: selectedLaunch.sourceType,
        recommendedTemplateId: selectedLaunch.templateId,
        title: title.trim(),
        request: request.trim(),
        sourceRef: sourceRef.trim() || undefined,
        acceptanceCriteria: splitMultilineList(acceptanceCriteria),
        constraints: splitMultilineList(constraints)
      };
      setBusy(mode);
      try {
        const createRes = await fetch("/api/work-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const createData = (await createRes.json().catch(() => ({}))) as WorkItemResponse;
        if (!createRes.ok || !createData.workItem) {
          throw new Error(createData.error ?? "Work item could not be created");
        }

        let createdWorkItem = createData.workItem;
        if (mode === "launch") {
          const launchRes = await fetch(`/api/work-items/${createdWorkItem.id}/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId: activeWorkspace.id })
          });
          const launchData = (await launchRes.json().catch(() => ({}))) as WorkItemStartResponse;
          if (!launchRes.ok || !launchData.ok || !launchData.workItem) {
            throw new Error(launchData.error ?? "Work item created but launch failed");
          }
          createdWorkItem = launchData.workItem;
          pushToast({
            tone: "success",
            title: "Work launched",
            message: createdWorkItem.brief.title
          });
        } else {
          pushToast({
            tone: "success",
            title: "Draft saved",
            message: createdWorkItem.brief.title
          });
        }

        setTitle("");
        setRequest("");
        setSourceRef("");
        setAcceptanceCriteria("");
        setConstraints("");
        if (mode === "launch") {
          router.push(`/work/${createdWorkItem.id}?workspace=${encodeURIComponent(activeWorkspace.id)}`);
        }
        await load(true);
      } catch (error) {
        pushToast({
          tone: "danger",
          title: mode === "launch" ? "Launch failed" : "Create failed",
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setBusy("");
      }
    },
    [
      acceptanceCriteria,
      activeWorkspace?.id,
      constraints,
      load,
      pushToast,
      request,
      router,
      selectedLaunch.sourceType,
      selectedLaunch.templateId,
      sourceRef,
      title
    ]
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await createWorkItem("launch");
  };

  const handlePickWorkspaceDir = useCallback(async () => {
    if (!window.orchestrumDesktop?.pickDirectory) {
      setWorkspaceMessage("Directory picker is available in desktop mode. Enter the repo path manually in web mode.");
      return;
    }
    const picked = await window.orchestrumDesktop.pickDirectory();
    if (picked) {
      setWorkspacePathInput(picked);
      setWorkspaceMessage("");
    }
  }, []);

  const handleAddWorkspace = useCallback(async () => {
    setWorkspaceMessage("");
    if (!workspacePathInput.trim()) {
      setWorkspaceMessage("Enter the local repo path first.");
      return;
    }
    setWorkspaceBusy(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: workspacePathInput.trim(),
          name: workspaceNameInput.trim() || undefined
        })
      });
      const payload = (await res.json().catch(() => ({}))) as { workspace?: WorkspaceSummary; error?: string };
      if (!res.ok || !payload.workspace) {
        throw new Error(payload.error ?? "Workspace could not be added.");
      }
      rememberRecentWorkspacePath(payload.workspace.path);
      setSelectedWorkspaceId(payload.workspace.id);
      setWorkspacePathInput("");
      setWorkspaceNameInput("");
      pushToast({
        tone: "success",
        title: "Workspace added",
        message: payload.workspace.name ?? payload.workspace.id
      });
      await load(true);
    } catch (error) {
      setWorkspaceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }, [
    load,
    pushToast,
    setSelectedWorkspaceId,
    workspaceNameInput,
    workspacePathInput
  ]);

  const handleOpenBrowserSmoke = useCallback(() => {
    if (!activeWorkspace?.id) {
      pushToast({
        tone: "warning",
        title: "Workspace required",
        message: "Choose a workspace before starting browser evidence."
      });
      return;
    }
    openRunConfig({
      workspaceId: activeWorkspace.id,
      runKind: "qa"
    });
  }, [activeWorkspace?.id, openRunConfig, pushToast]);

  const handleLaunchExisting = async (workItem: WorkItemRecord) => {
    if (!activeWorkspace?.id) return;
    setLaunchingId(workItem.id);
    try {
      const res = await fetch(`/api/work-items/${workItem.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: activeWorkspace.id })
      });
      const data = (await res.json().catch(() => ({}))) as WorkItemStartResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Work item launch failed");
      }
      pushToast({
        tone: "success",
        title: "Run started",
        message: workItem.brief.title
      });
      router.push(`/work/${workItem.id}?workspace=${encodeURIComponent(activeWorkspace.id)}`);
      await load(true);
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Run start failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setLaunchingId("");
    }
  };

  const runningCount = useMemo(
    () => workItems.filter((item) => item.status === "running").length,
    [workItems]
  );
  const reviewCount = useMemo(
    () => workItems.filter((item) => item.status === "ready_for_review").length,
    [workItems]
  );
  const blockedCount = useMemo(
    () => workItems.filter((item) => item.status === "blocked" || item.status === "failed").length,
    [workItems]
  );
  const sortedWorkItems = useMemo(() => sortByUpdatedAtDesc(workItems), [workItems]);
  const currentWorkItems = useMemo(
    () => sortedWorkItems.filter((item) => item.status === "running" || item.status === "ready_for_review" || item.reviewStatus === "changes_requested"),
    [sortedWorkItems]
  );
  const attentionItems = useMemo(
    () => sortedWorkItems.filter((item) => item.status === "blocked" || item.status === "failed" || item.status === "ready_for_review" || item.reviewStatus === "changes_requested"),
    [sortedWorkItems]
  );
  const draftItems = useMemo(
    () => sortedWorkItems.filter((item) => item.status === "draft"),
    [sortedWorkItems]
  );
  const completedItems = useMemo(
    () => sortedWorkItems.filter((item) => item.status === "completed").slice(0, 6),
    [sortedWorkItems]
  );
  const primaryTeamWorkItem = useMemo(
    () => currentWorkItems[0] ?? attentionItems[0] ?? null,
    [attentionItems, currentWorkItems]
  );
  const selectedSnapshotTeam = useMemo(
    () => (teamSnapshot?.teamSelection ?? []).filter((entry) => entry.decision === "selected" || entry.decision === "standby"),
    [teamSnapshot?.teamSelection]
  );
  const liveSessionHeadline = primaryTeamWorkItem
    ? primaryTeamWorkItem.reviewStatus === "changes_requested"
      ? "Remediation is waiting"
      : primaryTeamWorkItem.status === "ready_for_review"
        ? "Human review is waiting"
        : primaryTeamWorkItem.status === "blocked" || primaryTeamWorkItem.status === "failed"
          ? "A live session needs intervention"
          : "A live session is in progress"
    : null;

  useEffect(() => {
    const workspaceId = activeWorkspace?.id ?? primaryTeamWorkItem?.workspaceId;
    if (!primaryTeamWorkItem?.id || !workspaceId) {
      setTeamSnapshot(null);
      setTeamSnapshotLoading(false);
      return;
    }
    let cancelled = false;
    setTeamSnapshotLoading(true);
    const loadTeamSnapshot = async () => {
      const res = await fetch(
        `/api/work-items/${primaryTeamWorkItem.id}/team-runtime?workspace=${encodeURIComponent(workspaceId)}`,
        { cache: "no-store" }
      );
      const payload = (await res.json().catch(() => ({}))) as WorkItemTeamSnapshotResponse;
      if (cancelled) return;
      setTeamSnapshot({
        workItemId: primaryTeamWorkItem.id,
        teamRuntime: payload.teamRuntime ?? null,
        teamSelection: Array.isArray(payload.teamSelection) ? payload.teamSelection : []
      });
      setTeamSnapshotLoading(false);
    };
    void loadTeamSnapshot().catch(() => {
      if (cancelled) return;
      setTeamSnapshot(null);
      setTeamSnapshotLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.id, primaryTeamWorkItem?.id, primaryTeamWorkItem?.workspaceId]);

  if (loading && workspaces.length === 0) {
    return (
      <main className="space-y-6">
        <EmptyState
          icon="◎"
          title="Loading work"
          description="Fetching workspaces and current repo work."
        />
      </main>
    );
  }

  if (!loading && workspaces.length === 0) {
    return (
      <main className="space-y-6 overflow-x-hidden">
        <PageHeader
          eyebrow="Work"
          title="Add one workspace, then start feature work or audits here"
          description="Work stays self-contained. Register the local repo once, then this page becomes the only normal place to start and continue repo work."
        />
        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
          <SurfacePanel
            title="Add workspace"
            description="Point Orchestrum at the local repo you want to operate on. Work items will then live under that repo in `.orchestrum/control/work-items.json`."
          >
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto_auto]">
              <input
                value={workspacePathInput}
                onChange={(event) => setWorkspacePathInput(event.target.value)}
                placeholder="/Users/you/project"
                className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600"
              />
              <input
                value={workspaceNameInput}
                onChange={(event) => setWorkspaceNameInput(event.target.value)}
                placeholder="Display name (optional)"
                className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600"
              />
              <button
                type="button"
                onClick={() => void handlePickWorkspaceDir()}
                className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Browse
              </button>
              <button
                type="button"
                disabled={workspaceBusy}
                onClick={() => void handleAddWorkspace()}
                className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {workspaceBusy ? "Adding..." : "Add"}
              </button>
            </div>
            {workspaceMessage ? <div className="mt-3 text-sm text-rose-300">{workspaceMessage}</div> : null}
          </SurfacePanel>

          <SurfacePanel
            title="What happens next"
            description="Once the repo is registered, keep using Work for the main flow and Workspaces only when you need to register another repo."
          >
            <KeyValueGrid
              columns={1}
              items={[
                { label: "1", value: "If no provider looks usable yet, connect one in Settings before launching work." },
                { label: "2", value: "Start a Feature, Audit, or Browser Smoke flow directly from Work." },
                { label: "3", value: "Review outcomes in Work or Runs, then open Inspect or Diagnostics only when needed." }
              ]}
            />
            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <Link
                href="/workspaces"
                className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Open Workspaces
              </Link>
              <Link
                href="/settings"
                className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Open Settings
              </Link>
              <Link
                href="/help"
                className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-2 text-xs font-medium text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-200"
              >
                Help & Docs
              </Link>
            </div>
          </SurfacePanel>
        </section>
      </main>
    );
  }

  return (
    <main className="space-y-6 overflow-x-hidden">
      <PageHeader
        eyebrow="Work"
        title="Choose a workspace, confirm provider readiness, then launch one item"
        description="The normal path is Workspace, Provider, Start Work, Live Session, Review. Runs and Diagnostics stay secondary until the live session summary stops being enough."
        actions={
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-right">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Active workspace</div>
            <div className="mt-1 text-sm font-medium text-white">{activeWorkspace?.name ?? activeWorkspace?.id ?? "None"}</div>
            <div className="mt-1 max-w-[22rem] truncate text-xs text-slate-500">{activeWorkspace?.path ?? "Select a workspace"}</div>
            <div className="mt-4 border-t border-slate-800 pt-4 text-left">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Provider route</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${providerBadgeClassName}`}>
                  {providerBadgeLabel}
                </span>
                <span className="text-sm font-medium text-white">{providerHeadline}</span>
              </div>
              <div className="mt-2 max-w-[22rem] text-xs leading-5 text-slate-500">{providerSummary}</div>
            </div>
          </div>
        }
      />

      <MetricStrip
        items={[
          {
            label: "Tracked work",
            value: workItems.length,
            sub: activeWorkspace ? `${activeWorkspace.name ?? activeWorkspace.id} workspace` : "No workspace selected"
          },
          {
            label: "Running",
            value: runningCount,
            sub: runningCount > 0 ? "In flight now" : "No active execution",
            accentClassName: runningCount > 0 ? "text-amber-200" : undefined
          },
          {
            label: "Review",
            value: reviewCount,
            sub: reviewCount > 0 ? "Waiting on a human decision" : "Nothing waiting",
            accentClassName: reviewCount > 0 ? "text-emerald-200" : undefined
          },
          {
            label: "Blocked",
            value: blockedCount,
            sub: blockedCount > 0 ? "Needs intervention" : "No blocked work",
            accentClassName: blockedCount > 0 ? "text-rose-200" : undefined
          }
        ]}
      />

      {primaryTeamWorkItem ? (
        <SurfacePanel
          title="Resume live session"
          description="The most important current work item stays pinned here so you can jump straight back into the live team runtime."
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-200">{liveSessionHeadline}</div>
                  <Link
                    href={`/work/${primaryTeamWorkItem.id}?workspace=${encodeURIComponent(activeWorkspace?.id ?? primaryTeamWorkItem.workspaceId)}`}
                    className="mt-2 block text-lg font-semibold text-white transition hover:text-cyan-100"
                  >
                    {primaryTeamWorkItem.brief.title}
                  </Link>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-300">
                    <span>{workItemKindLabel(primaryTeamWorkItem)}</span>
                    <span>•</span>
                    <span>{executionModeLabel(primaryTeamWorkItem)}</span>
                    <span>•</span>
                    <span>{new Date(primaryTeamWorkItem.updatedAt).toLocaleString()}</span>
                  </div>
                  <div className="mt-4 text-sm leading-6 text-cyan-50/90">
                    {teamSnapshot?.teamRuntime?.currentStage
                      ?? (primaryTeamWorkItem.reviewStatus === "changes_requested"
                        ? "Review sent this work back. Resume the live session and follow the current remediation lane."
                        : primaryTeamWorkItem.status === "ready_for_review"
                          ? "The team finished the current cycle. Open the live session to review the final story, evidence, and gates."
                          : "Open the live session to follow the current baton, story, focused run, and lane flow.")}
                  </div>
                </div>
                <Link
                  href={`/work/${primaryTeamWorkItem.id}?workspace=${encodeURIComponent(activeWorkspace?.id ?? primaryTeamWorkItem.workspaceId)}`}
                  className="shrink-0 rounded-xl border border-cyan-300/30 bg-slate-950/40 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-cyan-100 transition-colors hover:bg-slate-950/60"
                >
                  Open live session
                </Link>
              </div>
            </div>

            <div className="space-y-3">
              {teamSnapshot?.teamRuntime ? (
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: "Active agents", value: teamSnapshot.teamRuntime.activeAgents },
                    { label: "Blocked lanes", value: teamSnapshot.teamRuntime.blockedLanes },
                    { label: "Completed lanes", value: teamSnapshot.teamRuntime.completedLanes },
                    { label: "Missing coverage", value: teamSnapshot.teamRuntime.missingCoverage }
                  ]}
                />
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                  Team runtime is still loading for this session.
                </div>
              )}

              {selectedSnapshotTeam.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {selectedSnapshotTeam.slice(0, 6).map((selection) => (
                    <span
                      key={selection.laneId}
                      className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-slate-300"
                    >
                      {selection.laneLabel}
                      {selection.chosenAgentName ? ` · ${selection.chosenAgentName}` : ""}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </SurfacePanel>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-2">
        <SurfacePanel
          title="Current work"
          description="The few work items that are actively running or already waiting for human review."
        >
          <div className="space-y-3">
            {currentWorkItems.length > 0 ? currentWorkItems.slice(0, 4).map((item) => (
              <WorkItemCard
                key={item.id}
                workItem={item}
                workspaceId={activeWorkspace?.id ?? item.workspaceId}
                secondary={item.reviewStatus === "changes_requested" ? "Remediation requested." : null}
              />
            )) : (
              <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                No active work item is visible right now.
              </div>
            )}
          </div>
        </SurfacePanel>

        <SurfacePanel
          title="Needs attention"
          description="Blocked, failed, or review-ready work that should usually be handled before you open more new work."
        >
          <div className="space-y-3">
            {attentionItems.length > 0 ? attentionItems.slice(0, 4).map((item) => (
              <WorkItemCard
                key={item.id}
                workItem={item}
                workspaceId={activeWorkspace?.id ?? item.workspaceId}
                secondary={
                  item.reviewStatus === "changes_requested"
                    ? "Changes were requested in review."
                    : item.status === "ready_for_review"
                      ? "A human decision is needed."
                      : "Operator intervention is needed."
                }
              />
            )) : (
              <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                Nothing urgent is waiting right now.
              </div>
            )}
          </div>
        </SurfacePanel>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <SurfacePanel
          title="Start one item"
          description="Feature is the normal default. Audit stays in the same flow. Browser Smoke starts direct evidence from here instead of sending you into a separate product path."
        >
          <div className="grid gap-3 md:grid-cols-3">
            {LAUNCH_OPTIONS.map((option) => {
              const active = option.id === launchMode;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setLaunchMode(option.id)}
                  className={`rounded-2xl border p-4 text-left transition-colors ${
                    active
                      ? "border-amber-400/40 bg-amber-400/10"
                      : "border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/70"
                  }`}
                >
                  <div className={`text-[10px] uppercase tracking-[0.2em] ${active ? "text-amber-300" : "text-slate-500"}`}>
                    {option.kicker}
                  </div>
                  <div className="mt-2 text-sm font-medium text-white">{option.label}</div>
                  <p className="mt-2 text-xs leading-5 text-slate-400">{option.description}</p>
                </button>
              );
            })}
          </div>

          {launchMode === "browser" ? (
            <div className="mt-5 space-y-4">
              <NoticePanel tone="info" title="Browser Smoke is direct evidence, not a parallel product mode">
                Start the browser run here when you need smoke or scenario evidence. Use Runs only if the resulting summary is not enough and you need to inspect deeper artifacts.
              </NoticePanel>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleOpenBrowserSmoke}
                  className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
                >
                  Start Browser Smoke
                </button>
                <Link
                  href="/runs"
                  className="rounded-xl border border-slate-700 bg-slate-900/60 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.2em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                >
                  Open Runs
                </Link>
                <span className="text-xs text-slate-500">
                  Use Browser Smoke when you need fast UI evidence, not a long-lived work item.
                </span>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Title</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={selectedLaunch.titlePlaceholder}
                    className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                    required
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{selectedLaunch.refLabel}</span>
                  <input
                    value={sourceRef}
                    onChange={(event) => setSourceRef(event.target.value)}
                    placeholder={selectedLaunch.refPlaceholder}
                    className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                  />
                </label>
              </div>

              <label className="space-y-2">
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{selectedLaunch.requestLabel}</span>
                <textarea
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                  placeholder={selectedLaunch.requestPlaceholder}
                  className="h-36 w-full rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-sm leading-6 text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                  required
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{selectedLaunch.acceptanceLabel}</span>
                  <textarea
                    value={acceptanceCriteria}
                    onChange={(event) => setAcceptanceCriteria(event.target.value)}
                    placeholder={selectedLaunch.acceptancePlaceholder}
                    className="h-32 w-full rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-sm leading-6 text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{selectedLaunch.constraintsLabel}</span>
                  <textarea
                    value={constraints}
                    onChange={(event) => setConstraints(event.target.value)}
                    placeholder={selectedLaunch.constraintsPlaceholder}
                    className="h-32 w-full rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-sm leading-6 text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={busy !== ""}
                  className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "launch" ? "Launching..." : "Create + Launch"}
                </button>
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() => void createWorkItem("draft")}
                  className="rounded-xl border border-slate-700 bg-slate-900/60 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.2em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "draft" ? "Saving..." : "Save draft"}
                </button>
                <span className="text-xs text-slate-500">
                  {selectedLaunch.label} stays inside the normal Work flow. You do not need a separate launch surface for this route.
                </span>
              </div>
            </form>
          )}
        </SurfacePanel>

        <div className="space-y-4 min-w-0">
          <SurfacePanel
            title="Launch path"
            description="Keep the first-screen sequence honest: workspace, provider, start, live session, review."
            actions={
              <Link
                href={activeWorkspace ? "/settings" : "/workspaces"}
                className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                {activeWorkspace ? "Provider setup" : "Add workspace"}
              </Link>
            }
          >
            <KeyValueGrid
              columns={1}
              items={[
                {
                  label: "1 Workspace",
                  value: activeWorkspace
                    ? `${activeWorkspace.name ?? activeWorkspace.id} · ${activeWorkspace.path}`
                    : "Choose one local repo before you launch anything."
                },
                {
                  label: "2 Provider",
                  value: (
                    <div className="space-y-1">
                      <div className="font-medium text-white">{providerHeadline}</div>
                      <div>{providerSummary}</div>
                      <div className="text-xs text-slate-500">{providerExplanation}</div>
                    </div>
                  )
                },
                {
                  label: launchMode === "browser" ? "3 Start browser evidence" : `3 Start ${selectedLaunch.label}`,
                  value: launchStepSummary
                },
                {
                  label: "4 Live Session",
                  value: primaryTeamWorkItem ? (
                    <Link
                      href={`/work/${primaryTeamWorkItem.id}?workspace=${encodeURIComponent(activeWorkspace?.id ?? primaryTeamWorkItem.workspaceId)}`}
                      className="text-cyan-300 transition hover:text-cyan-200"
                    >
                      Resume {primaryTeamWorkItem.brief.title}
                    </Link>
                  ) : (
                    "The live session becomes the main screen as soon as you launch a feature or audit item."
                  )
                },
                {
                  label: "5 Review",
                  value: reviewStepSummary
                }
              ]}
            />
          </SurfacePanel>

          <SurfacePanel
            title="Drafts waiting to start"
            description="Saved drafts live here until you explicitly launch them."
          >
            <div className="space-y-3">
              {draftItems.length > 0 ? draftItems.slice(0, 6).map((item) => (
                <WorkItemCard
                  key={item.id}
                  workItem={item}
                  workspaceId={activeWorkspace?.id ?? item.workspaceId}
                  action={
                    <button
                      type="button"
                      disabled={launchingId === item.id}
                      onClick={() => void handleLaunchExisting(item)}
                      className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {launchingId === item.id ? "Launching..." : launchActionLabel(item)}
                    </button>
                  }
                />
              )) : (
                <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                  No drafts are waiting to be launched.
                </div>
              )}
            </div>
          </SurfacePanel>

          {completedItems.length > 0 ? (
            <SurfacePanel
              title="Recent completions"
              description="A light completion history, not a wall of archived state."
            >
              <div className="space-y-3">
                {completedItems.slice(0, 4).map((item) => (
                  <WorkItemCard
                    key={item.id}
                    workItem={item}
                    workspaceId={activeWorkspace?.id ?? item.workspaceId}
                  />
                ))}
              </div>
            </SurfacePanel>
          ) : null}

          {attentionItems.length > 0 ? (
            <NoticePanel tone="warning" title="Attention beats new launch">
              There are {attentionItems.length} blocked, remediation, or review-ready items in this workspace. If one of them matters more than the new request, resume that live session first.
            </NoticePanel>
          ) : null}
        </div>
      </section>

      <details className="group rounded-3xl border border-slate-800 bg-slate-950/40 p-5">
        <summary className="cursor-pointer list-none">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Inspect only when needed</div>
              <div className="mt-2 text-lg font-medium text-white">Workspace runtime signals and advanced tools</div>
              <div className="mt-2 text-sm leading-6 text-slate-400">
                The core Work flow stays above. Open this only when you need workspace-wide runtime counts, optimization hints, or repair surfaces.
              </div>
            </div>
            <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300 transition group-open:border-cyan-400/30 group-open:text-cyan-100">
              Expand
            </span>
          </div>
        </summary>

        <div className="mt-5 grid gap-6 xl:grid-cols-[1fr_1fr]">
          <SurfacePanel
            title="Workspace runtime summary"
            description="Read-only runtime signals for this workspace."
          >
            {organizationControl ? (
              <KeyValueGrid
                columns={2}
                items={[
                  { label: "Tracked items", value: organizationControl.summary.total },
                  { label: "Launchable", value: organizationControl.summary.launchable },
                  { label: "Active WIP", value: organizationControl.summary.activeWip },
                  { label: "Running", value: organizationControl.summary.running },
                  { label: "Review", value: organizationControl.summary.review },
                  { label: "Blocked", value: organizationControl.summary.blocked },
                  { label: "Background state", value: organizationControl.supervisor.state },
                  { label: "Tick cadence", value: `${organizationControl.supervisor.tickIntervalSeconds}s` }
                ]}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                Runtime summary becomes visible once the selected workspace has readable work-item state.
              </div>
            )}
          </SurfacePanel>

          <SurfacePanel
            title="Review optimization"
            description="Only summary-level optimization counts stay here. Deep optimization detail belongs in each work item."
          >
            {optimizationSummary ? (
              <KeyValueGrid
                columns={2}
                items={[
                  { label: "Prompt suggestions", value: optimizationSummary.pendingPromptSuggestions },
                  { label: "Strategies", value: optimizationSummary.pendingStrategies },
                  { label: "Opportunities", value: optimizationSummary.pendingOpportunities },
                  { label: "Recent cycles", value: optimizationSummary.recentCycles.length }
                ]}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                No review-derived optimization summary is visible for this workspace yet.
              </div>
            )}
          </SurfacePanel>

          <SurfacePanel
            title="Advanced tools"
            description="Open these only when Work and Live Session no longer explain what is happening."
            className="xl:col-span-2"
          >
            <div className="grid gap-3 md:grid-cols-3">
              <Link
                href="/diagnostics"
                className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4 text-sm text-slate-200 transition hover:border-slate-700 hover:bg-slate-900/55"
              >
                Runtime health, machine checks, raw logs, and recovery tools
              </Link>
              <Link
                href="/runs"
                className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4 text-sm text-slate-200 transition hover:border-slate-700 hover:bg-slate-900/55"
              >
                Execution history and troubleshooting when a run needs deeper inspection
              </Link>
              <Link
                href="/settings"
                className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4 text-sm text-slate-200 transition hover:border-slate-700 hover:bg-slate-900/55"
              >
                Provider setup, team presets, and optional advanced runtime tuning
              </Link>
            </div>
          </SurfacePanel>
        </div>
      </details>
    </main>
  );
}
