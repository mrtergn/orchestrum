"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkItemImportSkip,
  WorkItemCreateRequest,
  WorkItemPlanningDetail,
  WorkItemPbiPreviewResponse,
  WorkItemRecord,
  WorkOrganizationControl,
  WorkOrganizationControlActionResponse,
  WorkOrganizationControlResponse,
  WorkOrganizationSupervisorResponse,
  WorkItemSourceType,
  WorkItemSprintImportResponse,
  WorkSprintPreview,
  WorkSprintPreviewResponse,
  WorkItemsResponse,
  WorkWorkspaceOptimizationSummary
} from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";
import {
  buildWorkspaceTeamRuntime,
  type RuntimeAgentRecord,
  type RuntimeTaskRecord
} from "@/lib/workRuntime";
import { buildWorkspaceApiPath } from "@/lib/workspaces";

type WorkspaceSummary = {
  id: string;
  name?: string;
  path: string;
};

type WorkItemResponse = {
  workItem?: WorkItemRecord;
  error?: string;
};

type WorkItemStartResponse = {
  ok?: boolean;
  runId?: string;
  workItem?: WorkItemRecord;
  error?: string;
};

type WorkItemsPayload = WorkItemsResponse & {
  optimizationSummary?: WorkWorkspaceOptimizationSummary | null;
};

const SOURCE_OPTIONS: Array<{
  value: WorkItemSourceType;
  label: string;
  kicker: string;
  description: string;
  refLabel: string;
  refPlaceholder: string;
  templateId: string;
}> = [
  {
    value: "feature",
    label: "Feature",
    kicker: "Product work",
    description: "Start from a feature request, acceptance criteria, and scope constraints.",
    refLabel: "Context reference",
    refPlaceholder: "Optional doc, ticket, or design reference",
    templateId: "feature-dev"
  },
  {
    value: "pbi",
    label: "Sprint / PBI",
    kicker: "Backlog intake",
    description: "Point to a sprint file or PBI identifier and launch work against that item.",
    refLabel: "Sprint file / PBI ref",
    refPlaceholder: "Example: sprint5.md :: ABC",
    templateId: "feature-dev"
  },
  {
    value: "bug",
    label: "Bug",
    kicker: "Repair loop",
    description: "Capture repro context and expected behavior for a focused hotfix run.",
    refLabel: "Bug / repro ref",
    refPlaceholder: "Example: Sentry issue, Linear ticket, repro URL",
    templateId: "bugfix-hotpatch"
  },
  {
    value: "pr_hardening",
    label: "PR Hardening",
    kicker: "Release safety",
    description: "Harden an existing diff before review or release using validation and audit focus.",
    refLabel: "PR / diff ref",
    refPlaceholder: "Example: PR #182 or branch compare scope",
    templateId: "release-hardening"
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
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function sourceLabel(sourceType: WorkItemSourceType) {
  return SOURCE_OPTIONS.find((option) => option.value === sourceType)?.label ?? sourceType;
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

function sprintSourcePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const index = trimmed.indexOf("::");
  return index >= 0 ? trimmed.slice(0, index).trim() : trimmed;
}

function sprintSelectionHint(selectedCount: number, totalCount: number) {
  if (selectedCount <= 0) return `0 of ${totalCount} selected`;
  if (selectedCount === totalCount) return `All ${totalCount} selected`;
  return `${selectedCount} of ${totalCount} selected`;
}

export default function WorkIntakePage() {
  const { selectedWorkspaceId, setSelectedWorkspaceId, pushToast } = useAppUi();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceType, setSourceType] = useState<WorkItemSourceType>("feature");
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "launch">("");
  const [launchingId, setLaunchingId] = useState("");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState("");
  const [pbiPreview, setPbiPreview] = useState<WorkItemPlanningDetail | null>(null);
  const [pbiPreviewError, setPbiPreviewError] = useState("");
  const [pbiPreviewLoading, setPbiPreviewLoading] = useState(false);
  const [sprintPreview, setSprintPreview] = useState<WorkSprintPreview | null>(null);
  const [sprintPreviewError, setSprintPreviewError] = useState("");
  const [sprintPreviewLoading, setSprintPreviewLoading] = useState(false);
  const [selectedSprintPbiIds, setSelectedSprintPbiIds] = useState<string[]>([]);
  const [importingSprint, setImportingSprint] = useState(false);
  const [organizationControl, setOrganizationControl] = useState<WorkOrganizationControl | null>(null);
  const [agents, setAgents] = useState<RuntimeAgentRecord[]>([]);
  const [tasks, setTasks] = useState<RuntimeTaskRecord[]>([]);
  const [runtimeBusy, setRuntimeBusy] = useState<"" | "launch_next_ready" | "fill_wip">("");
  const [supervisorBusy, setSupervisorBusy] = useState(false);
  const [targetWip, setTargetWip] = useState(2);
  const [maxAutoLaunchPerAction, setMaxAutoLaunchPerAction] = useState(2);
  const [blockLaunchWhenReviewPending, setBlockLaunchWhenReviewPending] = useState(true);
  const [allowImportDuringAutoLaunch, setAllowImportDuringAutoLaunch] = useState(true);
  const [backgroundSupervisorEnabled, setBackgroundSupervisorEnabled] = useState(false);
  const [optimizationSummary, setOptimizationSummary] = useState<WorkWorkspaceOptimizationSummary | null>(null);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces]
  );
  const selectedSource = useMemo(
    () => SOURCE_OPTIONS.find((option) => option.value === sourceType) ?? SOURCE_OPTIONS[0]!,
    [sourceType]
  );
  const selectedWorkItem = useMemo(
    () => workItems.find((item) => item.id === selectedWorkItemId) ?? workItems[0] ?? null,
    [selectedWorkItemId, workItems]
  );

  const load = useCallback(async () => {
    setLoading(true);
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
        setAgents([]);
        setTasks([]);
        setOptimizationSummary(null);
        return;
      }

      const [workItemsRes, controlRes, agentRes, taskRes] = await Promise.all([
        fetch(`/api/work-items?workspace=${encodeURIComponent(fallbackWorkspaceId)}`, {
          cache: "no-store"
        }),
        fetch(`/api/work-items/organization-control?workspace=${encodeURIComponent(fallbackWorkspaceId)}`, {
          cache: "no-store"
        }),
        fetch(`/api/agents?workspace=${encodeURIComponent(fallbackWorkspaceId)}`, { cache: "no-store" }),
        fetch(`/api/tasks?workspace=${encodeURIComponent(fallbackWorkspaceId)}`, { cache: "no-store" })
      ]);
      const workItemsData = workItemsRes.ok
        ? ((await workItemsRes.json()) as WorkItemsPayload)
        : { workItems: [] };
      const controlData = controlRes.ok
        ? ((await controlRes.json()) as WorkOrganizationControlResponse)
        : { ok: false };
      const agentData = await agentRes.json().catch(() => ({ agents: [] }));
      const taskData = await taskRes.json().catch(() => ({ tasks: [] }));
      setWorkItems(Array.isArray(workItemsData.workItems) ? workItemsData.workItems : []);
      setOptimizationSummary(workItemsData.optimizationSummary ?? null);
      setOrganizationControl(controlData.ok && controlData.control ? controlData.control : null);
      setAgents(Array.isArray(agentData.agents) ? agentData.agents as RuntimeAgentRecord[] : []);
      setTasks(Array.isArray(taskData.tasks) ? taskData.tasks as RuntimeTaskRecord[] : []);
      if (controlData.ok && controlData.control) {
        setTargetWip(controlData.control.governance.targetWip);
        setMaxAutoLaunchPerAction(controlData.control.governance.maxAutoLaunchPerAction);
        setBlockLaunchWhenReviewPending(controlData.control.governance.blockLaunchWhenReviewPending);
        setAllowImportDuringAutoLaunch(controlData.control.governance.allowImportDuringAutoLaunch);
        setBackgroundSupervisorEnabled(controlData.control.supervisor.enabled);
      } else {
        setOrganizationControl(null);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedWorkspaceId, setSelectedWorkspaceId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 6000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!workItems.length) {
      setSelectedWorkItemId("");
      return;
    }
    if (!selectedWorkItemId || !workItems.some((item) => item.id === selectedWorkItemId)) {
      setSelectedWorkItemId(workItems[0]!.id);
    }
  }, [selectedWorkItemId, workItems]);

  useEffect(() => {
    if (sourceType !== "pbi" || !activeWorkspace?.id || !sourceRef.trim()) {
      setPbiPreview(null);
      setPbiPreviewError("");
      setPbiPreviewLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setPbiPreviewLoading(true);
      try {
        const query = new URLSearchParams({
          workspace: activeWorkspace.id,
          sourceRef: sourceRef.trim()
        });
        const res = await fetch(`/api/work-items/pbi-preview?${query.toString()}`, {
          cache: "no-store"
        });
        const payload = (await res.json().catch(() => ({}))) as WorkItemPbiPreviewResponse;
        if (!res.ok || !payload.ok || !payload.preview) {
          throw new Error(payload.error ?? "PBI preview could not be generated");
        }
        if (!cancelled) {
          setPbiPreview(payload.preview);
          setPbiPreviewError("");
        }
      } catch (error) {
        if (!cancelled) {
          setPbiPreview(null);
          setPbiPreviewError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setPbiPreviewLoading(false);
        }
      }
    }, 320);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeWorkspace?.id, sourceRef, sourceType]);

  useEffect(() => {
    const sourcePath = sprintSourcePath(sourceRef);
    if (sourceType !== "pbi" || !activeWorkspace?.id || !sourcePath) {
      setSprintPreview(null);
      setSprintPreviewError("");
      setSprintPreviewLoading(false);
      setSelectedSprintPbiIds([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSprintPreviewLoading(true);
      try {
        const query = new URLSearchParams({
          workspace: activeWorkspace.id,
          sourcePath
        });
        const res = await fetch(`/api/work-items/sprint-preview?${query.toString()}`, {
          cache: "no-store"
        });
        const payload = (await res.json().catch(() => ({}))) as WorkSprintPreviewResponse;
        if (!res.ok || !payload.ok || !payload.preview) {
          throw new Error(payload.error ?? "Sprint preview could not be generated");
        }
        if (!cancelled) {
          setSprintPreview(payload.preview);
          setSelectedSprintPbiIds(payload.preview.pbis.map((item) => item.pbiId));
          setSprintPreviewError("");
        }
      } catch (error) {
        if (!cancelled) {
          setSprintPreview(null);
          setSelectedSprintPbiIds([]);
          setSprintPreviewError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setSprintPreviewLoading(false);
        }
      }
    }, 320);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeWorkspace?.id, sourceRef, sourceType]);

  const createWorkItem = useCallback(
    async (mode: "draft" | "launch") => {
      if (!activeWorkspace?.id) {
        pushToast({
          tone: "warning",
          title: "Workspace required",
          message: "Add or select a workspace before creating work items."
        });
        return;
      }
      const payload: WorkItemCreateRequest = {
        workspaceId: activeWorkspace.id,
        sourceType,
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
            title: "Work item launched",
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
        setSelectedWorkItemId(createdWorkItem.id);
        await load();
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
      sourceRef,
      sourceType,
      title
    ]
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await createWorkItem("launch");
  };

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
      await load();
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

  const loadSprintPbiIntoForm = useCallback((pbiId: string) => {
    const pbi = sprintPreview?.pbis.find((item) => item.pbiId === pbiId);
    if (!pbi) return;
    setSourceType("pbi");
    setTitle(`${pbi.pbiId} · ${pbi.pbiTitle}`);
    setRequest(pbi.summary?.trim() || `${pbi.pbiId} backlog item imported from sprint markdown.`);
    setSourceRef(pbi.sourceRef);
    setAcceptanceCriteria(pbi.acceptanceCriteria.join("\n"));
    setConstraints("");
    pushToast({
      tone: "success",
      title: "PBI loaded into intake",
      message: `${pbi.pbiId} is now loaded into the work item form.`
    });
  }, [pushToast, sprintPreview]);

  const toggleSprintPbiSelection = useCallback((pbiId: string) => {
    setSelectedSprintPbiIds((current) =>
      current.includes(pbiId)
        ? current.filter((entry) => entry !== pbiId)
        : [...current, pbiId]
    );
  }, []);

  const handleImportSprintPbis = useCallback(async (pbiIds: string[], launchAfterImport = false) => {
    if (!activeWorkspace?.id) return;
    const sourcePath = sprintSourcePath(sourceRef);
    if (!sourcePath) return;
    setImportingSprint(true);
    try {
      const res = await fetch("/api/work-items/sprint-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          sourcePath,
          pbiIds
        })
      });
      const payload = (await res.json().catch(() => ({}))) as Partial<WorkItemSprintImportResponse> & {
        error?: string;
      };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? "Sprint PBIs could not be imported");
      }

      const created = Array.isArray(payload.created) ? payload.created : [];
      const skipped = Array.isArray(payload.skipped) ? payload.skipped as WorkItemImportSkip[] : [];

      if (launchAfterImport && created.length === 1) {
        const launchRes = await fetch(`/api/work-items/${created[0]!.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: activeWorkspace.id })
        });
        const launchPayload = (await launchRes.json().catch(() => ({}))) as WorkItemStartResponse;
        if (!launchRes.ok || !launchPayload.ok || !launchPayload.workItem) {
          throw new Error(launchPayload.error ?? "PBI was imported but launch failed");
        }
      }

      if (created[0]) {
        setSelectedWorkItemId(created[0].id);
      }
      await load();
      pushToast({
        tone: created.length > 0 ? "success" : "warning",
        title: launchAfterImport ? "PBI imported and launched" : "Sprint backlog imported",
        message:
          created.length > 0
            ? `${created.length} work item${created.length !== 1 ? "s" : ""} created${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}.`
            : skipped.length > 0
              ? skipped[0]!.reason
              : "No new work items were created."
      });
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Sprint import failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setImportingSprint(false);
    }
  }, [activeWorkspace?.id, load, pushToast, sourceRef]);

  const runningCount = useMemo(
    () => workItems.filter((item) => item.status === "running").length,
    [workItems]
  );
  const reviewCount = useMemo(
    () => workItems.filter((item) => item.status === "ready_for_review").length,
    [workItems]
  );
  const failedCount = useMemo(
    () => workItems.filter((item) => item.status === "failed").length,
    [workItems]
  );
  const workLanes = useMemo(() => {
    const lanes = [
      { id: "draft", label: "Backlog", statuses: new Set(["draft"]) },
      { id: "running", label: "In Flight", statuses: new Set(["running"]) },
      { id: "review", label: "Review", statuses: new Set(["ready_for_review"]) },
      { id: "blocked", label: "Blocked", statuses: new Set(["blocked", "failed"]) },
      { id: "done", label: "Done", statuses: new Set(["completed"]) }
    ] as const;
    return lanes.map((lane) => ({
      ...lane,
      items: workItems.filter((item) => lane.statuses.has(item.status))
    }));
  }, [workItems]);
  const teamRuntime = useMemo(() => {
    if (!organizationControl) return null;
    return buildWorkspaceTeamRuntime({
      control: organizationControl,
      workItems,
      agents,
      tasks
    });
  }, [agents, organizationControl, tasks, workItems]);

  const runOrganizationAction = useCallback(async (action: "launch_next_ready" | "fill_wip") => {
    if (!activeWorkspace?.id) return;
    setRuntimeBusy(action);
    try {
      const res = await fetch("/api/work-items/organization-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          action,
          targetWip,
          maxAutoLaunchPerAction,
          blockLaunchWhenReviewPending,
          allowImportDuringAutoLaunch
        })
      });
      const payload = (await res.json().catch(() => ({}))) as WorkOrganizationControlActionResponse;
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? "Workspace runtime action failed");
      }
      if (payload.control) {
        setOrganizationControl(payload.control);
        setBackgroundSupervisorEnabled(payload.control.supervisor.enabled);
      }
      await load();
      pushToast({
        tone: payload.launched.length > 0 ? "success" : "warning",
        title: action === "launch_next_ready" ? "Next work item processed" : "Workspace WIP updated",
        message:
          payload.launched.length > 0
            ? `${payload.launched.length} work item${payload.launched.length !== 1 ? "s" : ""} launched${payload.skipped.length > 0 ? `, ${payload.skipped.length} skipped` : ""}.`
            : payload.skipped[0]?.reason ?? "No launchable work item was available."
      });
    } catch (error) {
      pushToast({
        tone: "danger",
        title: "Workspace runtime failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setRuntimeBusy("");
    }
  }, [
    activeWorkspace?.id,
    allowImportDuringAutoLaunch,
    blockLaunchWhenReviewPending,
    load,
    maxAutoLaunchPerAction,
    pushToast,
    targetWip
  ]);

  const saveBackgroundSupervisor = useCallback(async (enabled: boolean) => {
    if (!activeWorkspace?.id) return;
    setSupervisorBusy(true);
    try {
      const res = await fetch("/api/work-items/organization-control/supervisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          enabled,
          targetWip,
          maxAutoLaunchPerAction,
          blockLaunchWhenReviewPending,
          allowImportDuringAutoLaunch
        })
      });
      const payload = (await res.json().catch(() => ({}))) as WorkOrganizationSupervisorResponse;
      if (!res.ok || !payload.ok || !payload.control || !payload.supervisor) {
        throw new Error(payload.error ?? "Workspace supervisor policy could not be saved");
      }
      setOrganizationControl(payload.control);
      setBackgroundSupervisorEnabled(payload.supervisor.enabled);
      setTargetWip(payload.control.governance.targetWip);
      setMaxAutoLaunchPerAction(payload.control.governance.maxAutoLaunchPerAction);
      setBlockLaunchWhenReviewPending(payload.control.governance.blockLaunchWhenReviewPending);
      setAllowImportDuringAutoLaunch(payload.control.governance.allowImportDuringAutoLaunch);
      pushToast({
        tone: payload.supervisor.enabled ? "success" : "warning",
        title: payload.supervisor.enabled ? "Workspace supervisor enabled" : "Workspace supervisor paused",
        message: payload.supervisor.enabled
          ? "The organization runtime will keep the workspace queue moving in the background."
          : "Automatic workspace orchestration has been paused."
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
    activeWorkspace?.id,
    allowImportDuringAutoLaunch,
    blockLaunchWhenReviewPending,
    maxAutoLaunchPerAction,
    pushToast,
    targetWip
  ]);

  if (!loading && workspaces.length === 0) {
    return (
      <main className="space-y-6">
        <section className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/50 px-8 py-12 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/20 to-cyan-400/20 text-xl text-amber-200">
            ◉
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-white">Work Intake needs a workspace</h1>
          <p className="mt-2 text-sm text-slate-400">
            Work items are stored inside each workspace under <code>.orchestrum/control/work-items.json</code>. Add a repo first.
          </p>
          <Link
            href="/workspaces?intent=add"
            className="mt-6 inline-flex items-center rounded-xl border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
          >
            Add workspace
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="space-y-6">
      <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-amber-300">Phase 8</div>
              <h1 className="mt-2 text-2xl font-semibold text-white">Work Intake</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400">
                Route feature work, PBIs, bugs, and PR hardening requests into a canonical work item, or let the workspace PM runtime supervise the whole queue.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-right">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Active workspace</div>
              <div className="mt-1 text-sm font-medium text-white">{activeWorkspace?.name ?? activeWorkspace?.id ?? "None"}</div>
              <div className="mt-1 text-xs text-slate-500">{activeWorkspace?.path ?? "Select a workspace"}</div>
            </div>
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {SOURCE_OPTIONS.map((option) => {
              const active = option.value === sourceType;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSourceType(option.value)}
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

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={`Name the ${selectedSource.label.toLowerCase()} work item`}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                  required
                />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{selectedSource.refLabel}</span>
                <input
                  value={sourceRef}
                  onChange={(event) => setSourceRef(event.target.value)}
                  placeholder={selectedSource.refPlaceholder}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                />
              </label>
            </div>

            <label className="space-y-2">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Request</span>
              <textarea
                value={request}
                onChange={(event) => setRequest(event.target.value)}
                placeholder="Describe the goal, current context, and what the team should accomplish."
                className="h-36 w-full rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-sm leading-6 text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                required
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Acceptance criteria</span>
                <textarea
                  value={acceptanceCriteria}
                  onChange={(event) => setAcceptanceCriteria(event.target.value)}
                  placeholder={"One criterion per line\nUI state is visible\nRegression is covered"}
                  className="h-32 w-full rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-sm leading-6 text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/40"
                />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Constraints</span>
                <textarea
                  value={constraints}
                  onChange={(event) => setConstraints(event.target.value)}
                  placeholder={"One constraint per line\nNo schema changes\nKeep scope inside ui package"}
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
                {busy === "draft" ? "Saving..." : "Save Draft"}
              </button>
              <span className="text-xs text-slate-500">
                Phase 8 launches <span className="text-slate-300">{selectedSource.label}</span> into either a mission run or a specialist task graph, while the workspace PM runtime can keep the broader queue moving.
              </span>
            </div>
          </form>
        </div>

        <div className="space-y-4">
          <section className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Queue snapshot</div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { label: "Running", value: runningCount, tone: "text-amber-300 border-amber-400/20 bg-amber-400/10" },
                { label: "Review", value: reviewCount, tone: "text-emerald-300 border-emerald-400/20 bg-emerald-400/10" },
                { label: "Failed", value: failedCount, tone: "text-rose-300 border-rose-400/20 bg-rose-400/10" }
              ].map((stat) => (
                <div key={stat.label} className={`rounded-2xl border px-4 py-3 ${stat.tone}`}>
                  <div className="text-lg font-semibold text-white">{stat.value}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.2em]">{stat.label}</div>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Current route</div>
              <div className="mt-2 text-sm font-medium text-white">{selectedSource.label}</div>
              <div className="mt-1 text-xs text-slate-400">{selectedSource.description}</div>
              <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                <span className="text-xs text-slate-400">Mission template</span>
                <code className="text-xs text-amber-200">{selectedSource.templateId}</code>
              </div>
            </div>
            {optimizationSummary && (
              <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Optimization summary</div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {[
                    { label: "Prompt suggestions", value: optimizationSummary.pendingPromptSuggestions },
                    { label: "Strategies", value: optimizationSummary.pendingStrategies },
                    { label: "Opportunities", value: optimizationSummary.pendingOpportunities }
                  ].map((item) => (
                    <div key={item.label} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                      <div className="text-lg font-semibold text-white">{item.value}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
                    </div>
                  ))}
                </div>
                {optimizationSummary.recentCycles.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {optimizationSummary.recentCycles.slice(0, 3).map((cycle) => (
                      <Link
                        key={`${cycle.workItemId}:${cycle.cycleId}`}
                        href={`/work/${cycle.workItemId}?workspace=${encodeURIComponent(activeWorkspace?.id ?? "")}`}
                        className="block rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3 transition-colors hover:border-slate-700"
                      >
                        <div className="text-sm font-medium text-white">{cycle.title}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          Cycle {cycle.sequence} · {cycle.sourceStatus.replace(/_/g, " ")} · {new Date(cycle.createdAt).toLocaleString()}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
            {sourceType === "pbi" && (
              <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Sprint / PBI preview</div>
                {pbiPreviewLoading && (
                  <div className="mt-3 text-sm text-slate-400">Parsing sprint markdown...</div>
                )}
                {!pbiPreviewLoading && pbiPreviewError && (
                  <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-3 text-sm text-rose-100">
                    {pbiPreviewError}
                  </div>
                )}
                {!pbiPreviewLoading && !pbiPreviewError && !pbiPreview && (
                  <div className="mt-3 text-sm text-slate-500">
                    Use a source ref like <code>sprint5.md :: ABC</code> to preview the parsed PBI.
                  </div>
                )}
                {pbiPreview && !pbiPreviewLoading && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <div className="text-sm font-medium text-white">
                        {pbiPreview.sourceSnapshot.pbiId}
                        {pbiPreview.sourceSnapshot.pbiTitle ? ` · ${pbiPreview.sourceSnapshot.pbiTitle}` : ""}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {pbiPreview.sourceSnapshot.sprintName ?? "Sprint name not found"} · {pbiPreview.sourceSnapshot.sourcePath}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                        <div className="text-lg font-semibold text-white">{pbiPreview.tasks.length}</div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Tasks</div>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                        <div className="text-lg font-semibold text-white">{pbiPreview.acceptanceCriteria.length}</div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Criteria</div>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                        <div className="text-lg font-semibold text-white">{pbiPreview.sourceSnapshot.warnings.length}</div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Warnings</div>
                      </div>
                    </div>
                    {pbiPreview.sourceSnapshot.warnings.length > 0 && (
                      <div className="rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-3 text-xs text-fuchsia-100">
                        {pbiPreview.sourceSnapshot.warnings[0]}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-5 border-t border-slate-800 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Sprint backlog</div>
                      <div className="mt-2 text-sm text-slate-300">
                        {sprintPreview?.sprintName ?? "Preview all PBIs from the selected sprint file."}
                      </div>
                    </div>
                    {sprintPreview && (
                      <div className="text-xs text-slate-500">
                        {sprintSelectionHint(selectedSprintPbiIds.length, sprintPreview.pbis.length)}
                      </div>
                    )}
                  </div>

                  {sprintPreviewLoading && (
                    <div className="mt-3 text-sm text-slate-400">Scanning sprint backlog...</div>
                  )}
                  {!sprintPreviewLoading && sprintPreviewError && (
                    <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-3 text-sm text-rose-100">
                      {sprintPreviewError}
                    </div>
                  )}
                  {!sprintPreviewLoading && !sprintPreviewError && !sprintPreview && (
                    <div className="mt-3 text-sm text-slate-500">
                      Enter a sprint markdown path like <code>sprint5.md</code> to preview the full backlog.
                    </div>
                  )}

                  {sprintPreview && !sprintPreviewLoading && (
                    <div className="mt-4 space-y-3">
                      <div className="grid grid-cols-3 gap-2">
                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                          <div className="text-lg font-semibold text-white">{sprintPreview.pbis.length}</div>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">PBIs</div>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                          <div className="text-lg font-semibold text-white">{selectedSprintPbiIds.length}</div>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Selected</div>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                          <div className="text-lg font-semibold text-white">{sprintPreview.warnings.length}</div>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Warnings</div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={importingSprint || selectedSprintPbiIds.length === 0}
                          onClick={() => void handleImportSprintPbis(selectedSprintPbiIds)}
                          className="rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-cyan-200 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {importingSprint ? "Importing..." : "Import selected"}
                        </button>
                        <button
                          type="button"
                          disabled={selectedSprintPbiIds.length === 0}
                          onClick={() => setSelectedSprintPbiIds(sprintPreview.pbis.map((item) => item.pbiId))}
                          className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          disabled={selectedSprintPbiIds.length === 0}
                          onClick={() => setSelectedSprintPbiIds([])}
                          className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Clear
                        </button>
                        <Link
                          href={`/work/sprint?workspace=${encodeURIComponent(activeWorkspace?.id ?? "")}&sourcePath=${encodeURIComponent(sprintPreview.sourcePath)}`}
                          className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                        >
                          Open control room
                        </Link>
                      </div>

                      <div className="max-h-[26rem] space-y-2 overflow-auto pr-1">
                        {sprintPreview.pbis.map((pbi) => {
                          const selected = selectedSprintPbiIds.includes(pbi.pbiId);
                          return (
                            <div
                              key={pbi.pbiId}
                              className={`rounded-xl border p-3 transition-colors ${
                                selected
                                  ? "border-cyan-400/30 bg-cyan-400/10"
                                  : "border-slate-800 bg-slate-950/70"
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => toggleSprintPbiSelection(pbi.pbiId)}
                                  className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-300 focus:ring-cyan-400/40"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-sm font-medium text-white">{pbi.pbiId}</div>
                                    <div className="text-sm text-slate-300">{pbi.pbiTitle}</div>
                                  </div>
                                  {pbi.summary && (
                                    <div className="mt-2 line-clamp-2 text-sm text-slate-400">{pbi.summary}</div>
                                  )}
                                  <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                                    <span>{pbi.taskCount} tasks</span>
                                    <span>{pbi.acceptanceCriteria.length} criteria</span>
                                    {pbi.warnings.length > 0 && <span>{pbi.warnings.length} warnings</span>}
                                  </div>
                                  {pbi.warnings.length > 0 && (
                                    <div className="mt-2 rounded-lg border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-2 text-xs text-fuchsia-100">
                                      {pbi.warnings[0]}
                                    </div>
                                  )}
                                </div>
                                <div className="flex shrink-0 flex-col gap-2">
                                  <button
                                    type="button"
                                    onClick={() => loadSprintPbiIntoForm(pbi.pbiId)}
                                    className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                                  >
                                    Load into form
                                  </button>
                                  <button
                                    type="button"
                                    disabled={importingSprint}
                                    onClick={() => void handleImportSprintPbis([pbi.pbiId], false)}
                                    className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-cyan-200 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    Import draft
                                  </button>
                                  <button
                                    type="button"
                                    disabled={importingSprint}
                                    onClick={() => void handleImportSprintPbis([pbi.pbiId], true)}
                                    className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    Import + launch
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Organization Runtime</div>
            {!organizationControl || !teamRuntime ? (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                Workspace control room will appear once Orchestrum can resolve the queue for the selected workspace.
              </div>
            ) : (
              <>
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="text-sm font-medium text-white">{teamRuntime.headline}</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">{teamRuntime.pmFocus}</div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                    <span>Supervisor {organizationControl.supervisor.enabled ? organizationControl.supervisor.state : "paused"}</span>
                    <span>{organizationControl.supervisor.tickIntervalSeconds}s cadence</span>
                    {organizationControl.supervisor.lastActionAt && (
                      <span>last action {new Date(organizationControl.supervisor.lastActionAt).toLocaleTimeString()}</span>
                    )}
                  </div>
                  <div className="mt-4 grid gap-3 grid-cols-2 xl:grid-cols-4">
                    {[
                      { label: "Running", value: teamRuntime.activeWorkItems },
                      { label: "Review", value: teamRuntime.reviewQueue },
                      { label: "Blocked", value: teamRuntime.blockedItems },
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
                  {organizationControl.supervisor.lastError && (
                    <div className="mt-4 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 px-4 py-3 text-sm text-fuchsia-100">
                      Supervisor error: {organizationControl.supervisor.lastError}
                    </div>
                  )}
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">PM Runtime</div>
                    <div className="mt-4 grid gap-4">
                      <div className="grid gap-4 sm:grid-cols-2">
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
                      </div>
                      <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                        <input
                          type="checkbox"
                          checked={blockLaunchWhenReviewPending}
                          onChange={(event) => setBlockLaunchWhenReviewPending(event.target.checked)}
                          className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-300 focus:ring-cyan-400/40"
                        />
                        <div>
                          <div className="text-sm text-white">Hold launches while review is pending</div>
                          <div className="mt-1 text-xs text-slate-500">Keeps PM focus on human gate before opening new work.</div>
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
                          <div className="mt-1 text-xs text-slate-500">Lets the runtime pull draft backlog items forward without a manual open.</div>
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
                          <div className="mt-1 text-xs text-slate-500">Runs the workspace PM loop inside the service process even when the UI is closed.</div>
                        </div>
                      </label>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={runtimeBusy !== ""}
                        onClick={() => void runOrganizationAction("launch_next_ready")}
                        className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {runtimeBusy === "launch_next_ready" ? "Launching..." : "Launch next ready"}
                      </button>
                      <button
                        type="button"
                        disabled={runtimeBusy !== ""}
                        onClick={() => void runOrganizationAction("fill_wip")}
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
                      Active WIP is {organizationControl.summary.activeWip}. Launchable backlog is {organizationControl.summary.launchable}.
                    </div>
                    <div className="mt-2 text-xs text-slate-500">
                      Background state: {organizationControl.supervisor.state}
                      {organizationControl.supervisor.lastTickAt ? ` · last tick ${new Date(organizationControl.supervisor.lastTickAt).toLocaleString()}` : ""}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Launch Queue</div>
                    <div className="mt-3 space-y-3">
                      {organizationControl.launchQueue.length > 0 ? (
                        organizationControl.launchQueue.slice(0, 5).map((candidate) => (
                          <div key={candidate.workItemId} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-white">{candidate.title}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {sourceLabel(candidate.sourceType)} · score {candidate.score}
                                </div>
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
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <Link
                                href={`/work/${candidate.workItemId}?workspace=${encodeURIComponent(activeWorkspace?.id ?? "")}`}
                                className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                              >
                                Open board
                              </Link>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-xl border border-dashed border-slate-700 px-3 py-6 text-sm text-slate-500">
                          No launchable work item is currently visible.
                        </div>
                      )}
                    </div>
                    {organizationControl.blockers.length > 0 && (
                      <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Blockers</div>
                        <div className="mt-3 space-y-2 text-xs text-slate-400">
                          {organizationControl.blockers.slice(0, 4).map((blocker) => (
                            <div key={blocker}>{blocker}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
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
                          No specialist task graph is active across this workspace yet.
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
                                Work items: {agent.activePbis.join(" | ")}
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
            )}
          </section>

          <section className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Selected item</div>
            {!selectedWorkItem ? (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                No work item selected yet.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-400">
                      {sourceLabel(selectedWorkItem.brief.sourceType)}
                    </span>
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${statusClassName(selectedWorkItem.status)}`}>
                      {statusLabel(selectedWorkItem.status)}
                    </span>
                  </div>
                  <h2 className="mt-3 text-lg font-semibold text-white">{selectedWorkItem.brief.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-400">{selectedWorkItem.brief.request}</p>
                </div>

                {selectedWorkItem.brief.sourceRef && (
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Source reference</div>
                    <div className="mt-2 text-sm text-slate-200">{selectedWorkItem.brief.sourceRef}</div>
                  </div>
                )}

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Acceptance criteria</div>
                    <div className="mt-3 space-y-2 text-sm text-slate-300">
                      {selectedWorkItem.brief.acceptanceCriteria.length > 0 ? (
                        selectedWorkItem.brief.acceptanceCriteria.map((item) => (
                          <div key={item} className="flex gap-2">
                            <span className="text-amber-300">•</span>
                            <span>{item}</span>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No explicit criteria yet.</div>
                      )}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Constraints</div>
                    <div className="mt-3 space-y-2 text-sm text-slate-300">
                      {selectedWorkItem.brief.constraints.length > 0 ? (
                        selectedWorkItem.brief.constraints.map((item) => (
                          <div key={item} className="flex gap-2">
                            <span className="text-cyan-300">•</span>
                            <span>{item}</span>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No explicit constraints yet.</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Linked execution</div>
                      <div className="mt-2 text-sm text-slate-200">
                        {executionModeLabel(selectedWorkItem)}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {selectedWorkItem.executionMode === "task_graph" || (selectedWorkItem.linkedTaskIds?.length ?? 0) > 0
                          ? `Task status: ${selectedWorkItem.linkedTaskStatus ?? "queued"} · ${selectedWorkItem.linkedTaskIds?.length ?? 0} task(s)`
                          : `Run status: ${selectedWorkItem.linkedRunStatus ?? "not started"}`}
                      </div>
                      {selectedWorkItem.reviewNote && (
                        <div className="mt-1 text-xs text-fuchsia-200">
                          Last operator note: {selectedWorkItem.reviewNote}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-slate-500">
                        Template <code>{selectedWorkItem.recommendedTemplateId}</code>
                      </div>
                      {(selectedWorkItem.cycles?.length ?? 0) > 0 && (
                        <div className="mt-1 text-xs text-slate-500">
                          {selectedWorkItem.cycles?.length} cycle{selectedWorkItem.cycles?.length !== 1 ? "s" : ""} recorded
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/work/${selectedWorkItem.id}?workspace=${encodeURIComponent(selectedWorkItem.workspaceId)}`}
                        className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                      >
                        Open board
                      </Link>
                      {!hasActiveExecution(selectedWorkItem) && selectedWorkItem.reviewStatus !== "approved" && (
                        <button
                          type="button"
                          onClick={() => void handleLaunchExisting(selectedWorkItem)}
                          disabled={launchingId === selectedWorkItem.id}
                          className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {launchingId === selectedWorkItem.id ? "Launching..." : launchActionLabel(selectedWorkItem)}
                        </button>
                      )}
                      {selectedWorkItem.linkedRunId && (
                        <Link
                          href={`/runs/${selectedWorkItem.linkedRunId}?workspace=${encodeURIComponent(selectedWorkItem.workspaceId)}`}
                          className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                        >
                          Open run
                        </Link>
                      )}
                      {(selectedWorkItem.linkedTaskIds?.length ?? 0) > 0 && (
                        <Link
                          href={`/tasks?workItem=${encodeURIComponent(selectedWorkItem.id)}`}
                          className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                        >
                          Open tasks
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-800 bg-slate-950/60 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Workspace queue</div>
            <h2 className="mt-2 text-xl font-semibold text-white">
              {activeWorkspace?.name ?? "Selected workspace"} work items
            </h2>
          </div>
          <div className="text-sm text-slate-500">
            {workItems.length} item{workItems.length !== 1 ? "s" : ""} tracked in <code>.orchestrum/control/work-items.json</code>
          </div>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-5">
          {workLanes.map((lane) => (
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
                    No items in this lane.
                  </div>
                ) : (
                  lane.items.slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedWorkItemId(item.id)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3 text-left transition-colors hover:border-slate-700 hover:bg-slate-950"
                    >
                      <div className="text-sm font-medium text-white">{item.brief.title}</div>
                      <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{item.brief.request}</div>
                      <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                        {sourceLabel(item.brief.sourceType)} · {item.cycles?.length ?? 0} cycles
                      </div>
                    </button>
                  ))
                )}
                {lane.items.length > 4 && (
                  <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                    +{lane.items.length - 4} more
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 space-y-3">
          {!loading && workItems.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-500">
              No work items yet. Create one above to seed the queue.
            </div>
          )}
          {workItems.map((workItem) => {
            const active = selectedWorkItem?.id === workItem.id;
            const canLaunch = !hasActiveExecution(workItem) && workItem.reviewStatus !== "approved";
            return (
              <div
                key={workItem.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedWorkItemId(workItem.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedWorkItemId(workItem.id);
                  }
                }}
                className={`w-full rounded-2xl border p-4 text-left transition-colors cursor-pointer ${
                  active
                    ? "border-amber-400/30 bg-amber-400/10"
                    : "border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/70"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                        {sourceLabel(workItem.brief.sourceType)}
                      </span>
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${statusClassName(workItem.status)}`}>
                        {statusLabel(workItem.status)}
                      </span>
                    </div>
                    <div className="mt-3 text-sm font-medium text-white">{workItem.brief.title}</div>
                    <div className="mt-1 line-clamp-2 text-sm text-slate-400">{workItem.brief.request}</div>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                      <span>Template <code>{workItem.recommendedTemplateId}</code></span>
                      <span>{executionModeLabel(workItem)}</span>
                      <span>Updated {new Date(workItem.updatedAt).toLocaleString()}</span>
                      {workItem.linkedRunId && <span>Run {workItem.linkedRunId}</span>}
                      {(workItem.linkedTaskIds?.length ?? 0) > 0 && <span>{workItem.linkedTaskIds?.length} tasks</span>}
                      {workItem.reviewStatus === "changes_requested" && <span>Needs remediation</span>}
                      {(workItem.cycles?.length ?? 0) > 0 && <span>{workItem.cycles?.length} cycles</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/work/${workItem.id}?workspace=${encodeURIComponent(workItem.workspaceId)}`}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                    >
                      Board
                    </Link>
                    {canLaunch ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleLaunchExisting(workItem);
                        }}
                        disabled={launchingId === workItem.id}
                        className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {launchingId === workItem.id ? "Launching..." : launchActionLabel(workItem)}
                      </button>
                    ) : (
                      <>
                        {workItem.linkedRunId && (
                          <Link
                            href={`/runs/${workItem.linkedRunId}?workspace=${encodeURIComponent(workItem.workspaceId)}`}
                            onClick={(event) => event.stopPropagation()}
                            className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                          >
                            Open run
                          </Link>
                        )}
                        {(workItem.linkedTaskIds?.length ?? 0) > 0 && (
                          <Link
                            href={`/tasks?workItem=${encodeURIComponent(workItem.id)}`}
                            onClick={(event) => event.stopPropagation()}
                            className="rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
                          >
                            Open tasks
                          </Link>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
