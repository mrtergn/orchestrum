import crypto from "node:crypto";
import path from "node:path";
import type express from "express";
import {
  approvePromptSuggestion,
  loadStrategyState,
  rejectPromptSuggestion,
  saveStrategyState,
  loadWorkspaces,
  normalizeWorkItemStatus,
  readJsonIfExists,
  writeJson,
  appendWorkspaceSignal,
  getWorkspaceOrganizationSupervisorPath,
  getWorkspaceSprintSupervisorsPath,
  getWorkspaceWorkItemsPath,
  type WorkItemCycleRecord,
  type WorkItemCyclePlan,
  type WorkItemExecutionMode,
  type WorkItemGate,
  type WorkItemGateRuntime,
  type WorkItemImportSkip,
  type WorkItemOptimizationCycle,
  type WorkItemOptimizationOpportunity,
  type WorkItemOptimizationPromptSuggestion,
  type WorkItemOptimizationStrategyRecommendation,
  type WorkItemOptimizationSummary,
  type WorkSprintBurndownPoint,
  type WorkSprintControl,
  type WorkSprintControlAction,
  type WorkSprintControlActionReport,
  type WorkSprintControlActionRequest,
  type WorkSprintControlActionResponse,
  type WorkSprintGovernance,
  type WorkOrganizationControl,
  type WorkOrganizationControlAction,
  type WorkOrganizationControlActionReport,
  type WorkOrganizationControlActionRequest,
  type WorkOrganizationControlActionResponse,
  type WorkOrganizationControlResponse,
  type WorkOrganizationLaunchCandidate,
  type WorkOrganizationLaunchSkip,
  type WorkOrganizationSupervisor,
  type WorkOrganizationSupervisorRequest,
  type WorkOrganizationSupervisorResponse,
  type WorkSprintSupervisor,
  type WorkSprintSupervisorRequest,
  type WorkSprintSupervisorResponse,
  type WorkSprintLaunchCandidate,
  type WorkSprintControlPbi,
  type WorkSprintControlPbiState,
  type WorkSprintControlResponse,
  type WorkSprintControlTimelineEntry,
  type WorkItemRemediationPlan,
  type WorkItemSprintImportRequest,
  type RunVerdict,
  type StateIndex,
  type WorkSprintPreviewResponse,
  type WorkItemCreateRequest,
  type WorkItemRecord,
  type WorkItemReviewAction,
  type WorkItemReviewSummary,
  type WorkItemSourceType,
  type WorkItemStatus,
  type WorkItemTeamRuntime,
  type WorkItemWorkstream,
  type WorkItemWorkstreamStatus,
  type WorkWorkspaceOptimizationSummary,
  type WorkPlanTask
} from "@orchestrum/core";
import {
  buildWorkspaceOptimizationSummary,
  generateWorkItemOptimizationCycle,
  upsertWorkItemOptimizationSummary
} from "../work/optimization.js";
import {
  applyRemediationPlanToPlanningDetail,
  buildWorkItemPlanningDetail,
  buildWorkItemRemediationPlan,
  createWorkItemCyclePlan,
  previewSprintBacklog,
  previewPbiPlanning
} from "../work/planning.js";

type WorkAgentPlatform = {
  startMission(options: {
    runsDir: string;
    workspaceId: string;
    repoPath: string;
    templateId: string;
    goal: string;
    runId: string;
    runOptions?: {
      concurrency?: number;
      modelOverrides?: Record<string, string>;
      strategyMode?: string;
    };
  }): Promise<{ ok: boolean; runId: string }>;
  listTasks(options?: {
    workspaceId?: string;
    workItemId?: string;
  }): Array<{
    id: string;
    workspaceId?: string;
    linkedWorkItemId?: string;
    status: string;
    type?: string;
    laneId?: string;
    laneLabel?: string;
    linkedRunId?: string;
    verdict?: string | null;
    resultSummary?: string;
    plannerTaskId?: string;
    assignedToAgentId?: string;
    workstreamId?: string | null;
    workstreamType?: string | null;
    qaMode?: "smoke" | "scenario" | null;
    waitingOnTaskIds?: string[];
    blockedByTaskIds?: string[];
  }>;
  queueWorkItemExecution(options: {
    workspaceId: string;
    workItem: WorkItemRecord;
    detail: Awaited<ReturnType<typeof buildWorkItemPlanningDetail>>;
  }): Promise<{ taskIds: string[] }>;
};

type IndexedRunLike = {
  workspaceId: string;
  runId: string;
  status: string;
  verdict: RunVerdict | null;
};

type IndexedTaskLike = {
  id: string;
  workspaceId?: string;
  linkedWorkItemId?: string;
  status: string;
  type?: string;
  plannerTaskId?: string;
  assignedToAgentId?: string;
  laneId?: string;
  laneLabel?: string;
  workstreamId?: string | null;
  workstreamType?: string | null;
  qaMode?: "smoke" | "scenario" | null;
  linkedRunId?: string;
  verdict?: string | null;
  resultSummary?: string;
  waitingOnTaskIds?: string[];
  blockedByTaskIds?: string[];
};

type RawWorkItemLookup = {
  workItem: WorkItemRecord;
  workItems: WorkItemRecord[];
  index: number;
  workspacePath: string;
};

type SprintSupervisorRecord = {
  sourcePath: string;
  enabled: boolean;
  tickIntervalSeconds: number;
  governance: WorkSprintGovernance;
  lastTickAt: string | null;
  lastActionAt: string | null;
  lastError: string | null;
  lastReport: WorkSprintControlActionReport | null;
};

type OrganizationSupervisorRecord = {
  enabled: boolean;
  tickIntervalSeconds: number;
  governance: WorkSprintGovernance;
  lastTickAt: string | null;
  lastActionAt: string | null;
  lastError: string | null;
  lastReport: WorkOrganizationControlActionReport | null;
};

const SOURCE_TEMPLATE_MAP: Record<WorkItemSourceType, string> = {
  feature: "feature-dev",
  pbi: "feature-dev",
  bug: "bugfix-hotpatch",
  pr_hardening: "release-hardening"
};

export function registerWorkIntakeRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    runsDir: string;
    stateIndex: StateIndex;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
    listWorkspacePaths: () => Promise<string[]>;
    agentPlatform: WorkAgentPlatform;
  }
): void {
  const rebuildStateIndex = () => {
    void options.stateIndex.rebuild().catch(() => undefined);
  };
  const sprintSupervisorRuntime = createSprintSupervisorRuntime({
    rootDir: options.rootDir,
    listWorkspacePaths: options.listWorkspacePaths,
    runsDir: options.runsDir,
    stateIndex: options.stateIndex,
    resolveWorkspacePath: options.resolveWorkspacePath,
    agentPlatform: options.agentPlatform
  });
  sprintSupervisorRuntime.start();
  const organizationSupervisorRuntime = createOrganizationSupervisorRuntime({
    rootDir: options.rootDir,
    listWorkspacePaths: options.listWorkspacePaths,
    runsDir: options.runsDir,
    stateIndex: options.stateIndex,
    resolveWorkspacePath: options.resolveWorkspacePath,
    agentPlatform: options.agentPlatform
  });
  organizationSupervisorRuntime.start();

  const listWorkItemsHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
    const workItems = await listHydratedWorkItems({
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath,
      stateIndex: options.stateIndex,
      agentPlatform: options.agentPlatform
    });
    return res.json({
      workItems,
      optimizationSummary: buildWorkspaceOptimizationSummary(workItems)
    });
  };

  const createWorkItemHandler = async (req: express.Request, res: express.Response) => {
    const body = req.body && typeof req.body === "object"
      ? (req.body as Partial<WorkItemCreateRequest>)
      : {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const workspacePath = workspaceId ? await options.resolveWorkspacePath(workspaceId) : null;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });

    const sourceType = normalizeSourceType(body.sourceType);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const request = typeof body.request === "string" ? body.request.trim() : "";
    if (!sourceType) return res.status(400).json({ error: "sourceType is required" });
    if (!title) return res.status(400).json({ error: "title is required" });
    if (!request) return res.status(400).json({ error: "request is required" });

    const workItems = await loadWorkItemsForWorkspacePath(workspacePath);
    const now = new Date().toISOString();
    const recommendedTemplateId = templateForSourceType(sourceType);
    const workItem: WorkItemRecord = {
      id: crypto.randomUUID(),
      workspaceId,
      brief: {
        workspaceId,
        sourceType,
        title,
        request,
        sourceRef: typeof body.sourceRef === "string" && body.sourceRef.trim() ? body.sourceRef.trim() : null,
        acceptanceCriteria: normalizeStringArray(body.acceptanceCriteria),
        constraints: normalizeStringArray(body.constraints)
      },
      status: "draft",
      recommendedTemplateId,
      executionMode: null,
      linkedRunId: null,
      linkedRunStatus: null,
      linkedRunVerdict: null,
      linkedTaskIds: [],
      linkedTaskStatus: null,
      reviewStatus: "pending",
      reviewNote: null,
      reviewedAt: null,
      currentCycleId: null,
      cycles: [],
      remediationPlan: null,
      optimization: null,
      createdAt: now,
      updatedAt: now,
      lastStartedAt: null
    };

    workItems.unshift(workItem);
    await saveWorkItemsForWorkspacePath(workspacePath, workItems);
    await appendWorkspaceSignal(workspacePath, {
      workspaceId,
      source: "work",
      type: "work-item.created",
      entityId: workItem.id,
      status: workItem.status,
      summary: `Work item created: ${title}`,
      payload: {
        sourceType,
        title,
        workItemId: workItem.id
      }
    }).catch(() => undefined);
    return res.status(201).json({ workItem });
  };

  const previewPbiHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : "";
    const sourceRef = typeof req.query.sourceRef === "string" ? req.query.sourceRef.trim() : "";
    if (!workspaceId) return res.status(400).json({ error: "workspace is required", ok: false });
    if (!sourceRef) return res.status(400).json({ error: "sourceRef is required", ok: false });
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found", ok: false });
    try {
      const preview = await previewPbiPlanning({
        workspacePath,
        sourceRef
      });
      return res.json({ ok: true, preview });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const previewSprintHandler = async (req: express.Request, res: express.Response<WorkSprintPreviewResponse>) => {
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : "";
    const sourcePath = typeof req.query.sourcePath === "string" ? req.query.sourcePath.trim() : "";
    if (!workspaceId) return res.status(400).json({ error: "workspace is required", ok: false });
    if (!sourcePath) return res.status(400).json({ error: "sourcePath is required", ok: false });
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found", ok: false });
    try {
      const preview = await previewSprintBacklog({
        workspacePath,
        sourcePath
      });
      return res.json({ ok: true, preview });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const importSprintHandler = async (req: express.Request, res: express.Response) => {
    const body = req.body && typeof req.body === "object"
      ? (req.body as Partial<WorkItemSprintImportRequest>)
      : {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: "workspaceId is required", created: [], skipped: [] });
    }
    if (!sourcePath) {
      return res.status(400).json({ ok: false, error: "sourcePath is required", created: [], skipped: [] });
    }
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) {
      return res.status(404).json({ ok: false, error: "Workspace not found", created: [], skipped: [] });
    }

    try {
      const preview = await previewSprintBacklog({
        workspacePath,
        sourcePath
      });
      const selectedPbiIds = new Set(normalizeStringArray(body.pbiIds).map((value) => value.toLowerCase()));
      const targetPbis = selectedPbiIds.size > 0
        ? preview.pbis.filter((pbi) => selectedPbiIds.has(pbi.pbiId.toLowerCase()))
        : preview.pbis;

      if (targetPbis.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "No matching PBIs were found for import",
          created: [],
          skipped: []
        });
      }

      const { created, skipped } = await importSprintPreviewPbis({
        workspaceId,
        workspacePath,
        targetPbis
      });
      return res.json({
        ok: true,
        created,
        skipped
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        created: [],
        skipped: []
      });
    }
  };

  const sprintControlHandler = async (req: express.Request, res: express.Response<WorkSprintControlResponse>) => {
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : "";
    const sourcePath = typeof req.query.sourcePath === "string" ? req.query.sourcePath.trim() : "";
    if (!workspaceId) return res.status(400).json({ ok: false, error: "workspace is required" });
    if (!sourcePath) return res.status(400).json({ ok: false, error: "sourcePath is required" });
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return res.status(404).json({ ok: false, error: "Workspace not found" });
    try {
      const supervisor = await loadSprintSupervisorForSourcePath(workspacePath, sourcePath);
      const preview = await previewSprintBacklog({
        workspacePath,
        sourcePath
      });
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const control = buildSprintControlSummary({
        preview,
        workItems,
        governance: supervisor?.governance ?? defaultSprintGovernance(),
        supervisor: toWorkSprintSupervisor(
          supervisor,
          sourcePath,
          sprintSupervisorRuntime.isRunning(workspaceId, sourcePath)
        )
      });
      return res.json({
        ok: true,
        control
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const sprintControlActionHandler = async (
    req: express.Request,
    res: express.Response<WorkSprintControlActionResponse>
  ) => {
    const body = req.body && typeof req.body === "object"
      ? (req.body as Partial<WorkSprintControlActionRequest>)
      : {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
    const action = normalizeSprintControlAction(body.action);
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: "workspaceId is required", imported: [], launched: [], skipped: [] });
    }
    if (!sourcePath) {
      return res.status(400).json({ ok: false, error: "sourcePath is required", imported: [], launched: [], skipped: [] });
    }
    if (!action) {
      return res.status(400).json({ ok: false, error: "action is required", imported: [], launched: [], skipped: [] });
    }
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) {
      return res.status(404).json({ ok: false, error: "Workspace not found", imported: [], launched: [], skipped: [] });
    }

    try {
      const supervisor = await loadSprintSupervisorForSourcePath(workspacePath, sourcePath);
      const governance = resolveSprintGovernance({
        targetWip: body.targetWip,
        maxAutoLaunchPerAction: typeof body.maxAutoLaunchPerAction === "number" ? body.maxAutoLaunchPerAction : undefined,
        blockLaunchWhenReviewPending:
          typeof body.blockLaunchWhenReviewPending === "boolean" ? body.blockLaunchWhenReviewPending : undefined,
        allowImportDuringAutoLaunch:
          typeof body.allowImportDuringAutoLaunch === "boolean" ? body.allowImportDuringAutoLaunch : undefined
      });
      const preview = await previewSprintBacklog({
        workspacePath,
        sourcePath
      });
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const control = buildSprintControlSummary({
        preview,
        workItems,
        governance,
        supervisor: toWorkSprintSupervisor(
          supervisor,
          sourcePath,
          sprintSupervisorRuntime.isRunning(workspaceId, sourcePath)
        )
      });
      const outcome = await executeSprintControlAction({
        action,
        governance,
        control,
        workspaceId,
        workspacePath,
        preview,
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        runsDir: options.runsDir,
        stateIndex: options.stateIndex,
        resolveWorkspacePath: options.resolveWorkspacePath,
        agentPlatform: options.agentPlatform
      });
      rebuildStateIndex();
      return res.json({
        ok: true,
        imported: outcome.imported,
        launched: outcome.launched,
        skipped: outcome.skipped,
        control: outcome.control,
        report: outcome.report
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        imported: [],
        launched: [],
        skipped: []
      });
    }
  };

  const sprintSupervisorHandler = async (
    req: express.Request,
    res: express.Response<WorkSprintSupervisorResponse>
  ) => {
    const body = req.body && typeof req.body === "object"
      ? (req.body as Partial<WorkSprintSupervisorRequest>)
      : {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: "workspaceId is required" });
    }
    if (!sourcePath) {
      return res.status(400).json({ ok: false, error: "sourcePath is required" });
    }
    if (typeof body.enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be a boolean" });
    }
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) {
      return res.status(404).json({ ok: false, error: "Workspace not found" });
    }

    try {
      const governance = resolveSprintGovernance({
        targetWip: body.targetWip,
        maxAutoLaunchPerAction: typeof body.maxAutoLaunchPerAction === "number" ? body.maxAutoLaunchPerAction : undefined,
        blockLaunchWhenReviewPending:
          typeof body.blockLaunchWhenReviewPending === "boolean" ? body.blockLaunchWhenReviewPending : undefined,
        allowImportDuringAutoLaunch:
          typeof body.allowImportDuringAutoLaunch === "boolean" ? body.allowImportDuringAutoLaunch : undefined
      });
      const updatedSupervisor = await upsertSprintSupervisorForSourcePath(workspacePath, {
        sourcePath,
        enabled: body.enabled,
        tickIntervalSeconds:
          typeof body.tickIntervalSeconds === "number" && Number.isFinite(body.tickIntervalSeconds) && body.tickIntervalSeconds > 2
            ? Math.max(3, Math.floor(body.tickIntervalSeconds))
            : 12,
        governance
      });
      const preview = await previewSprintBacklog({
        workspacePath,
        sourcePath
      });
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const supervisor = toWorkSprintSupervisor(
        updatedSupervisor,
        sourcePath,
        sprintSupervisorRuntime.isRunning(workspaceId, sourcePath)
      );
      const control = buildSprintControlSummary({
        preview,
        workItems,
        governance,
        supervisor
      });
      return res.json({
        ok: true,
        supervisor,
        control
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const organizationControlHandler = async (
    req: express.Request,
    res: express.Response<WorkOrganizationControlResponse>
  ) => {
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : "";
    if (!workspaceId) return res.status(400).json({ ok: false, error: "workspace is required" });
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return res.status(404).json({ ok: false, error: "Workspace not found" });
    try {
      const supervisorRecord = await loadOrganizationSupervisorForWorkspacePath(workspacePath);
      const sprintSupervisorSourcePaths = await listEnabledSprintSupervisorSourcePaths(workspacePath);
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const control = buildOrganizationControlSummary({
        workspaceId,
        workItems,
        governance: supervisorRecord?.governance ?? defaultSprintGovernance(),
        supervisor: toWorkOrganizationSupervisor(
          supervisorRecord,
          organizationSupervisorRuntime.isRunning(workspaceId)
        ),
        sprintSupervisorSourcePaths
      });
      return res.json({ ok: true, control });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const organizationControlActionHandler = async (
    req: express.Request,
    res: express.Response<WorkOrganizationControlActionResponse>
  ) => {
    const body = req.body && typeof req.body === "object"
      ? (req.body as Partial<WorkOrganizationControlActionRequest>)
      : {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const action = normalizeOrganizationControlAction(body.action);
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: "workspaceId is required", launched: [], skipped: [] });
    }
    if (!action) {
      return res.status(400).json({ ok: false, error: "action is required", launched: [], skipped: [] });
    }
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) {
      return res.status(404).json({ ok: false, error: "Workspace not found", launched: [], skipped: [] });
    }

    try {
      const supervisorRecord = await loadOrganizationSupervisorForWorkspacePath(workspacePath);
      const governance = resolveSprintGovernance({
        targetWip: body.targetWip,
        maxAutoLaunchPerAction:
          typeof body.maxAutoLaunchPerAction === "number" ? body.maxAutoLaunchPerAction : undefined,
        blockLaunchWhenReviewPending:
          typeof body.blockLaunchWhenReviewPending === "boolean" ? body.blockLaunchWhenReviewPending : undefined,
        allowImportDuringAutoLaunch:
          typeof body.allowImportDuringAutoLaunch === "boolean" ? body.allowImportDuringAutoLaunch : undefined
      });
      const sprintSupervisorSourcePaths = await listEnabledSprintSupervisorSourcePaths(workspacePath);
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const control = buildOrganizationControlSummary({
        workspaceId,
        workItems,
        governance,
        supervisor: toWorkOrganizationSupervisor(
          supervisorRecord,
          organizationSupervisorRuntime.isRunning(workspaceId)
        ),
        sprintSupervisorSourcePaths
      });
      const outcome = await executeOrganizationControlAction({
        action,
        governance,
        control,
        workspaceId,
        workspacePath,
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        runsDir: options.runsDir,
        stateIndex: options.stateIndex,
        resolveWorkspacePath: options.resolveWorkspacePath,
        agentPlatform: options.agentPlatform
      });
      rebuildStateIndex();
      return res.json({
        ok: true,
        launched: outcome.launched,
        skipped: outcome.skipped,
        control: outcome.control,
        report: outcome.report
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        launched: [],
        skipped: []
      });
    }
  };

  const organizationSupervisorHandler = async (
    req: express.Request,
    res: express.Response<WorkOrganizationSupervisorResponse>
  ) => {
    const body = req.body && typeof req.body === "object"
      ? (req.body as Partial<WorkOrganizationSupervisorRequest>)
      : {};
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: "workspaceId is required" });
    }
    if (typeof body.enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be a boolean" });
    }
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) {
      return res.status(404).json({ ok: false, error: "Workspace not found" });
    }

    try {
      const governance = resolveSprintGovernance({
        targetWip: body.targetWip,
        maxAutoLaunchPerAction:
          typeof body.maxAutoLaunchPerAction === "number" ? body.maxAutoLaunchPerAction : undefined,
        blockLaunchWhenReviewPending:
          typeof body.blockLaunchWhenReviewPending === "boolean" ? body.blockLaunchWhenReviewPending : undefined,
        allowImportDuringAutoLaunch:
          typeof body.allowImportDuringAutoLaunch === "boolean" ? body.allowImportDuringAutoLaunch : undefined
      });
      const updatedSupervisor = await upsertOrganizationSupervisorForWorkspacePath(workspacePath, {
        enabled: body.enabled,
        tickIntervalSeconds:
          typeof body.tickIntervalSeconds === "number" &&
          Number.isFinite(body.tickIntervalSeconds) &&
          body.tickIntervalSeconds > 2
            ? Math.max(3, Math.floor(body.tickIntervalSeconds))
            : 12,
        governance
      });
      const sprintSupervisorSourcePaths = await listEnabledSprintSupervisorSourcePaths(workspacePath);
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const supervisor = toWorkOrganizationSupervisor(
        updatedSupervisor,
        organizationSupervisorRuntime.isRunning(workspaceId)
      );
      const control = buildOrganizationControlSummary({
        workspaceId,
        workItems,
        governance,
        supervisor,
        sprintSupervisorSourcePaths
      });
      return res.json({
        ok: true,
        supervisor,
        control
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const getWorkItemHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
    const found = await findHydratedWorkItemById({
      id: String(req.params.id ?? ""),
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath,
      stateIndex: options.stateIndex,
      agentPlatform: options.agentPlatform
    });
    if (!found) return res.status(404).json({ error: "Work item not found" });
    return res.json({ workItem: found.workItem });
  };

  const getWorkItemDetailHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
    const found = await findHydratedWorkItemById({
      id: String(req.params.id ?? ""),
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath,
      stateIndex: options.stateIndex,
      agentPlatform: options.agentPlatform
    });
    if (!found) return res.status(404).json({ error: "Work item not found" });
    const workspacePath = await options.resolveWorkspacePath(found.workItem.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const detail = await buildWorkItemPlanningDetail({
      workspacePath,
      workItem: found.workItem
    });
    const runs = await options.stateIndex.queryRuns(found.workItem.workspaceId).catch(() => []);
    const runByKey = buildRunMap(runs);
    const relatedTasks = selectCurrentWorkItemTasks(
      found.workItem,
      options.agentPlatform.listTasks({
        workspaceId: found.workItem.workspaceId,
        workItemId: found.workItem.id
      })
    );
    const review = buildWorkItemReviewSummary({
      workItem: found.workItem,
      detail,
      relatedTasks,
      runByKey
    });
    const currentPlan = resolveCurrentCyclePlan(found.workItem, detail);
    const teamRuntime = buildWorkItemTeamRuntime({
      workItem: found.workItem,
      detail,
      currentPlan,
      relatedTasks
    });
    return res.json({
      workItem: found.workItem,
      detail,
      currentPlan,
      review,
      optimization: found.workItem.optimization ?? null,
      teamRuntime
    });
  };

  const startWorkItemHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string"
      ? req.body.workspaceId
      : typeof req.query.workspace === "string"
        ? req.query.workspace
        : undefined;
    const found = await findRawWorkItemById({
      id: String(req.params.id ?? ""),
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath
    });
    if (!found) return res.status(404).json({ error: "Work item not found" });
    try {
      const started = await startRawWorkItemExecution({
        found,
        runsDir: options.runsDir,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform,
        resolveWorkspacePath: options.resolveWorkspacePath,
        startOptions: normalizeRunStartOptions(req.body?.options)
      });
      rebuildStateIndex();
      await appendWorkspaceSignal(found.workspacePath, {
        workspaceId: started.workItem.workspaceId,
        source: "work",
        type: "work-item.started",
        entityId: started.workItem.id,
        status: started.workItem.status,
        summary: `Work item started in ${started.workItem.executionMode} mode`,
        payload: {
          workItemId: started.workItem.id,
          runId: started.runId,
          executionMode: started.workItem.executionMode
        }
      }).catch(() => undefined);
      return res.json({
        ok: true,
        runId: started.runId,
        workItem: started.workItem
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const reviewWorkItemHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string"
      ? req.body.workspaceId
      : typeof req.query.workspace === "string"
        ? req.query.workspace
        : undefined;
    const found = await findRawWorkItemById({
      id: String(req.params.id ?? ""),
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath
    });
    if (!found) return res.status(404).json({ error: "Work item not found", ok: false });

    const decision = normalizeReviewAction(req.body?.decision);
    if (!decision) {
      return res.status(400).json({ error: "decision must be approve or send_back", ok: false });
    }

    const workspacePath = await options.resolveWorkspacePath(found.workItem.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found", ok: false });
    const detail = await buildWorkItemPlanningDetail({
      workspacePath,
      workItem: found.workItem
    });
    const runs = await options.stateIndex.queryRuns(found.workItem.workspaceId).catch(() => []);
    const runByKey = buildRunMap(runs);
    const taskByWorkItem = buildTaskMap(options.agentPlatform.listTasks({
      workspaceId: found.workItem.workspaceId,
      workItemId: found.workItem.id
    }));
    const hydrated = hydrateWorkItem(found.workItem, runByKey, taskByWorkItem);
    const relatedTasks = selectCurrentWorkItemTasks(
      hydrated,
      options.agentPlatform.listTasks({
        workspaceId: hydrated.workspaceId,
        workItemId: hydrated.id
      })
    );
    const reviewBeforeDecision = buildWorkItemReviewSummary({
      workItem: hydrated,
      detail,
      relatedTasks,
      runByKey
    });

    if (decision === "approve" && hydrated.status !== "ready_for_review" && hydrated.status !== "completed") {
      return res.status(409).json({
        ok: false,
        error: "Work item is not ready for approval yet",
        workItem: hydrated
      });
    }
    if (decision === "send_back" && hydrated.status === "running") {
      return res.status(409).json({
        ok: false,
        error: "Work item is still running. Wait for execution to settle before sending it back.",
        workItem: hydrated
      });
    }

    const now = new Date().toISOString();
    const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim() : null;
    const remediationPlan = decision === "send_back"
      ? buildWorkItemRemediationPlan({
          workItem: {
            ...hydrated,
            reviewNote: note
          },
          detail,
          review: reviewBeforeDecision,
          relatedTasks,
          now
        })
      : found.workItem.remediationPlan
        ? {
            ...found.workItem.remediationPlan,
            status: "resolved" as const,
            resolvedAt: now
          }
        : null;
    const updatedWorkItem: WorkItemRecord = {
      ...applyCycleReviewDecision(found.workItem, {
        decision,
        at: now,
        note
      }),
      reviewStatus: decision === "approve" ? "approved" : "changes_requested",
      reviewNote: note,
      reviewedAt: now,
      remediationPlan,
      updatedAt: now
    };
    const optimizationCycle = await generateWorkItemOptimizationCycle({
      workspacePath: found.workspacePath,
      runsDir: options.runsDir,
      workItem: updatedWorkItem,
      detail,
      review: reviewBeforeDecision,
      relatedTasks,
      sourceStatus: decision === "approve" ? "approved" : "changes_requested"
    }).catch(() => null);
    if (optimizationCycle) {
      updatedWorkItem.optimization = upsertWorkItemOptimizationSummary(updatedWorkItem.optimization, optimizationCycle);
    }
    found.workItems[found.index] = updatedWorkItem;
    await saveWorkItemsForWorkspacePath(found.workspacePath, found.workItems);
    rebuildStateIndex();
    await appendWorkspaceSignal(found.workspacePath, {
      workspaceId: updatedWorkItem.workspaceId,
      source: decision === "approve" ? "review" : "review",
      type: decision === "approve" ? "work-item.approved" : "work-item.sent-back",
      entityId: updatedWorkItem.id,
      status: updatedWorkItem.reviewStatus ?? undefined,
      summary: decision === "approve" ? "Work item approved" : "Work item sent back for remediation",
      payload: {
        workItemId: updatedWorkItem.id,
        reviewStatus: updatedWorkItem.reviewStatus,
        note
      }
    }).catch(() => undefined);

    const hydratedUpdated = hydrateWorkItem(updatedWorkItem, runByKey, taskByWorkItem);
    const review = buildWorkItemReviewSummary({
      workItem: hydratedUpdated,
      detail,
      relatedTasks: selectCurrentWorkItemTasks(hydratedUpdated, options.agentPlatform.listTasks({
        workspaceId: hydratedUpdated.workspaceId,
        workItemId: hydratedUpdated.id
      })),
      runByKey
    });

    return res.json({
      ok: true,
      workItem: hydratedUpdated,
      review
    });
  };

  const optimizeWorkItemHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string"
      ? req.body.workspaceId
      : typeof req.query.workspace === "string"
        ? req.query.workspace
        : undefined;
    const found = await findRawWorkItemById({
      id: String(req.params.id ?? ""),
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath
    });
    if (!found) return res.status(404).json({ ok: false, error: "Work item not found" });

    const workspacePath = await options.resolveWorkspacePath(found.workItem.workspaceId);
    if (!workspacePath) return res.status(404).json({ ok: false, error: "Workspace not found" });

    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const kind = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
    const cycleId = typeof body.cycleId === "string" && body.cycleId.trim() ? body.cycleId.trim() : "";
    const itemId = typeof body.itemId === "string" && body.itemId.trim() ? body.itemId.trim() : "";

    const optimization = found.workItem.optimization;
    if (!optimization) {
      return res.status(404).json({ ok: false, error: "No optimization history is recorded for this work item yet." });
    }

    const cycle = optimization.cycles.find((entry) => entry.id === cycleId || entry.cycleId === cycleId) ?? null;
    if (!cycle) {
      return res.status(404).json({ ok: false, error: "Optimization cycle not found" });
    }

    const now = new Date().toISOString();
    let createdWorkItem: WorkItemRecord | null = null;
    const updatedCurrentWorkItem: WorkItemRecord = {
      ...found.workItem,
      optimization,
      updatedAt: now
    };

    if (kind === "prompt") {
      const suggestion = cycle.promptSuggestions.find((entry) => entry.id === itemId) ?? null;
      if (!suggestion || !suggestion.suggestionId) {
        return res.status(404).json({ ok: false, error: "Prompt suggestion not found" });
      }
      if (action === "approve") {
        await approvePromptSuggestion({
          workspacePath,
          promptPath: suggestion.promptPath,
          suggestionId: suggestion.suggestionId
        });
        suggestion.status = "approved";
      } else if (action === "reject") {
        await rejectPromptSuggestion({
          workspacePath,
          promptPath: suggestion.promptPath,
          suggestionId: suggestion.suggestionId
        });
        suggestion.status = "rejected";
      } else {
        return res.status(400).json({ ok: false, error: "Unsupported prompt optimization action" });
      }
    } else if (kind === "strategy") {
      const recommendation = cycle.strategyRecommendation;
      if (!recommendation || recommendation.id !== itemId) {
        return res.status(404).json({ ok: false, error: "Strategy recommendation not found" });
      }
      if (action === "approve") {
        const state = await loadStrategyState(workspacePath).catch(() => ({}));
        await saveStrategyState(workspacePath, {
          ...state,
          recommendedMode: recommendation.mode,
          recommendedAt: now
        });
        recommendation.status = "approved";
      } else if (action === "reject") {
        recommendation.status = "rejected";
      } else {
        return res.status(400).json({ ok: false, error: "Unsupported strategy optimization action" });
      }
    } else if (kind === "opportunity") {
      const opportunity = cycle.opportunities.find((entry) => entry.id === itemId) ?? null;
      if (!opportunity) {
        return res.status(404).json({ ok: false, error: "Opportunity not found" });
      }
      if (action === "convert") {
        createdWorkItem = createDerivedOpportunityWorkItem({
          sourceWorkItem: found.workItem,
          opportunity,
          now
        });
        opportunity.status = "converted";
        opportunity.convertedWorkItemId = createdWorkItem.id;
      } else if (action === "reject") {
        opportunity.status = "rejected";
      } else {
        return res.status(400).json({ ok: false, error: "Unsupported opportunity optimization action" });
      }
    } else {
      return res.status(400).json({ ok: false, error: "Optimization kind must be prompt, strategy, or opportunity" });
    }

    found.workItems[found.index] = updatedCurrentWorkItem;
    if (createdWorkItem) {
      found.workItems.unshift(createdWorkItem);
    }
    await saveWorkItemsForWorkspacePath(found.workspacePath, found.workItems);
    rebuildStateIndex();
    await appendWorkspaceSignal(found.workspacePath, {
      workspaceId: found.workItem.workspaceId,
      source: "work",
      type: `work-item.optimization.${kind}.${action}`,
      entityId: found.workItem.id,
      status: "completed",
      summary: `Optimization ${kind} ${action} recorded`,
      payload: {
        workItemId: found.workItem.id,
        cycleId: cycle.id,
        itemId,
        createdWorkItemId: createdWorkItem?.id ?? null
      }
    }).catch(() => undefined);
    return res.json({
      ok: true,
      workItem: updatedCurrentWorkItem,
      createdWorkItem
    });
  };

  for (const route of ["/work-items", "/api/work-items"] as const) {
    app.get(route, listWorkItemsHandler);
    app.post(route, createWorkItemHandler);
  }
  for (const route of ["/work-items/pbi-preview", "/api/work-items/pbi-preview"] as const) {
    app.get(route, previewPbiHandler);
  }
  for (const route of ["/work-items/sprint-preview", "/api/work-items/sprint-preview"] as const) {
    app.get(route, previewSprintHandler);
  }
  for (const route of ["/work-items/sprint-import", "/api/work-items/sprint-import"] as const) {
    app.post(route, importSprintHandler);
  }
  for (const route of ["/work-items/sprint-control", "/api/work-items/sprint-control"] as const) {
    app.get(route, sprintControlHandler);
  }
  for (const route of ["/work-items/sprint-control/action", "/api/work-items/sprint-control/action"] as const) {
    app.post(route, sprintControlActionHandler);
  }
  for (const route of ["/work-items/sprint-control/supervisor", "/api/work-items/sprint-control/supervisor"] as const) {
    app.post(route, sprintSupervisorHandler);
  }
  for (const route of ["/work-items/organization-control", "/api/work-items/organization-control"] as const) {
    app.get(route, organizationControlHandler);
  }
  for (const route of ["/work-items/organization-control/action", "/api/work-items/organization-control/action"] as const) {
    app.post(route, organizationControlActionHandler);
  }
  for (const route of ["/work-items/organization-control/supervisor", "/api/work-items/organization-control/supervisor"] as const) {
    app.post(route, organizationSupervisorHandler);
  }
  for (const route of ["/work-items/:id", "/api/work-items/:id"] as const) {
    app.get(route, getWorkItemHandler);
  }
  for (const route of ["/work-items/:id/detail", "/api/work-items/:id/detail"] as const) {
    app.get(route, getWorkItemDetailHandler);
  }
  for (const route of ["/work-items/:id/start", "/api/work-items/:id/start"] as const) {
    app.post(route, startWorkItemHandler);
  }
  for (const route of ["/work-items/:id/review", "/api/work-items/:id/review"] as const) {
    app.post(route, reviewWorkItemHandler);
  }
  for (const route of ["/work-items/:id/optimization", "/api/work-items/:id/optimization"] as const) {
    app.post(route, optimizeWorkItemHandler);
  }
}

async function listHydratedWorkItems(options: {
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  workspaceId?: string;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  stateIndex: StateIndex;
  agentPlatform: WorkAgentPlatform;
}): Promise<WorkItemRecord[]> {
  const rawItems = await listRawWorkItems(options);
  const runs = options.workspaceId
    ? await options.stateIndex.queryRuns(options.workspaceId).catch(() => [])
    : await options.stateIndex.queryRuns().catch(() => []);
  const runByKey = buildRunMap(runs);
  const taskByWorkItem = buildTaskMap(options.agentPlatform.listTasks({
    workspaceId: options.workspaceId
  }));
  return rawItems
    .map((entry) => hydrateWorkItem(entry, runByKey, taskByWorkItem))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function buildSprintControlSummary(options: {
  preview: Awaited<ReturnType<typeof previewSprintBacklog>>;
  workItems: WorkItemRecord[];
  governance?: WorkSprintGovernance;
  supervisor?: WorkSprintSupervisor;
}): WorkSprintControl {
  const governance = options.governance ?? defaultSprintGovernance();
  const workItemBySourceRef = new Map<string, WorkItemRecord>();
  for (const workItem of options.workItems) {
    if (workItem.brief.sourceType !== "pbi" || !workItem.brief.sourceRef) continue;
    const key = normalizeSprintSourceRef(workItem.brief.sourceRef);
    if (!workItemBySourceRef.has(key)) {
      workItemBySourceRef.set(key, workItem);
    }
  }

  const pbiById = new Map(options.preview.pbis.map((pbi) => [pbi.pbiId.toLowerCase(), pbi]));
  const completionByPbiId = new Map<string, boolean>();
  for (const pbi of options.preview.pbis) {
    const workItem = workItemBySourceRef.get(normalizeSprintSourceRef(pbi.sourceRef)) ?? null;
    completionByPbiId.set(pbi.pbiId.toLowerCase(), workItem?.status === "completed");
  }

  const pbis: WorkSprintControlPbi[] = options.preview.pbis.map((pbi) => {
    const workItem = workItemBySourceRef.get(normalizeSprintSourceRef(pbi.sourceRef)) ?? null;
    const blockedBy = pbi.dependsOn.filter((dependency) => {
      const dependencyPreview = pbiById.get(dependency.toLowerCase());
      if (!dependencyPreview) return true;
      return !completionByPbiId.get(dependency.toLowerCase());
    });
    const blockedReasons = blockedBy.map((dependency) => {
      const dependencyPreview = pbiById.get(dependency.toLowerCase());
      if (!dependencyPreview) {
        return `Dependency ${dependency} is referenced but not present in the sprint file.`;
      }
      const dependencyWorkItem = workItemBySourceRef.get(normalizeSprintSourceRef(dependencyPreview.sourceRef)) ?? null;
      if (!dependencyWorkItem) {
        return `Dependency ${dependency} has not been imported into the workspace queue yet.`;
      }
      return `Dependency ${dependency} is not completed yet; current status is ${dependencyWorkItem.status.replace(/_/g, " ")}.`;
    });
    const state = deriveSprintPbiState({
      workItem,
      blockedBy
    });
    return {
      ...pbi,
      state,
      workItemId: workItem?.id ?? null,
      workItemTitle: workItem?.brief.title ?? null,
      workItemStatus: workItem?.status ?? null,
      reviewStatus: workItem?.reviewStatus ?? null,
      cycleCount: workItem?.cycles?.length ?? 0,
      blockedBy,
      blockedReasons
    };
  });

  const summary = {
    total: pbis.length,
    unimported: pbis.filter((pbi) => !pbi.workItemId).length,
    ready: pbis.filter((pbi) => pbi.state === "ready").length,
    running: pbis.filter((pbi) => pbi.state === "running").length,
    review: pbis.filter((pbi) => pbi.state === "review").length,
    blocked: pbis.filter((pbi) => pbi.state === "blocked").length,
    completed: pbis.filter((pbi) => pbi.state === "completed").length,
    launchable: pbis.filter((pbi) => pbi.state === "ready" || pbi.state === "unimported").length,
    activeWip: pbis.filter((pbi) => pbi.state === "running").length,
    percentComplete: pbis.length > 0 ? Math.round((pbis.filter((pbi) => pbi.state === "completed").length / pbis.length) * 100) : 0
  };

  const blockers = Array.from(new Set(
    pbis
      .flatMap((pbi) => pbi.blockedReasons)
      .filter(Boolean)
  )).slice(0, 8);

  const launchQueue = buildSprintLaunchQueue({
    pbis,
    governance
  });

  const recommendations = [
    ...pbis
      .filter((pbi) => pbi.state === "review")
      .slice(0, 2)
      .map((pbi) => ({
        action: "review" as const,
        pbiId: pbi.pbiId,
        title: pbi.pbiTitle,
        rationale: "Execution is finished and waiting for operator review.",
        workItemId: pbi.workItemId ?? null
      })),
    ...pbis
      .filter((pbi) => pbi.state === "ready" && pbi.workItemId)
      .slice(0, 2)
      .map((pbi) => ({
        action: "launch" as const,
        pbiId: pbi.pbiId,
        title: pbi.pbiTitle,
        rationale: "This PBI is imported and unblocked; it is ready to launch into execution.",
        workItemId: pbi.workItemId ?? null
      })),
    ...pbis
      .filter((pbi) => pbi.state === "unimported")
      .slice(0, 3)
      .map((pbi) => ({
        action: "import" as const,
        pbiId: pbi.pbiId,
        title: pbi.pbiTitle,
        rationale: "Dependencies are satisfied and this backlog item is ready to be pulled into the workspace queue.",
        workItemId: null
      }))
  ].slice(0, 5);

  return {
    sourcePath: options.preview.sourcePath,
    sprintName: options.preview.sprintName,
    warnings: [...options.preview.warnings],
    summary,
    pbis,
    governance,
    supervisor: options.supervisor ?? toWorkSprintSupervisor(null, options.preview.sourcePath, false),
    launchQueue,
    blockers,
    recommendations,
    timeline: buildSprintControlTimeline(pbis, workItemBySourceRef),
    burndown: buildSprintBurndownTimeline(pbis, workItemBySourceRef)
  };
}

function buildSprintControlTimeline(
  pbis: WorkSprintControlPbi[],
  workItemBySourceRef: Map<string, WorkItemRecord>
): WorkSprintControlTimelineEntry[] {
  const entries: WorkSprintControlTimelineEntry[] = [];
  for (const pbi of pbis) {
    if (!pbi.workItemId) continue;
    const workItem = workItemBySourceRef.get(normalizeSprintSourceRef(pbi.sourceRef)) ?? null;
    if (!workItem) continue;
    entries.push({
      id: `${pbi.pbiId}-imported-${workItem.createdAt}`,
      at: workItem.createdAt,
      type: "imported",
      pbiId: pbi.pbiId,
      title: pbi.pbiTitle,
      summary: "Imported into the workspace queue.",
      workItemId: workItem.id
    });
    for (const cycle of workItem.cycles ?? []) {
      entries.push({
        id: `${pbi.pbiId}-cycle-${cycle.id}`,
        at: cycle.startedAt,
        type: "cycle_started",
        pbiId: pbi.pbiId,
        title: pbi.pbiTitle,
        summary: cycle.plan?.headline ?? cycle.summary ?? `Cycle ${cycle.sequence} started.`,
        workItemId: workItem.id,
        cycleSequence: cycle.sequence,
        cycleStatus: cycle.status
      });
    }
    if (workItem.reviewStatus !== "pending" && workItem.reviewedAt) {
      entries.push({
        id: `${pbi.pbiId}-review-${workItem.reviewedAt}`,
        at: workItem.reviewedAt,
        type: "review_decision",
        pbiId: pbi.pbiId,
        title: pbi.pbiTitle,
        summary:
          workItem.reviewStatus === "approved"
            ? "Approved by operator."
            : workItem.reviewNote?.trim()
              ? `Changes requested: ${workItem.reviewNote.trim()}`
              : "Sent back for remediation.",
        workItemId: workItem.id,
        cycleSequence: (workItem.cycles ?? []).find((cycle) => cycle.id === workItem.currentCycleId)?.sequence ?? null
      });
    }
  }

  return entries
    .sort((left, right) => (left.at < right.at ? 1 : -1))
    .slice(0, 24);
}

function defaultSprintGovernance(): WorkSprintGovernance {
  return {
    targetWip: 2,
    maxAutoLaunchPerAction: 2,
    blockLaunchWhenReviewPending: true,
    allowImportDuringAutoLaunch: true
  };
}

function getSprintSupervisorsPath(workspacePath: string): string {
  return getWorkspaceSprintSupervisorsPath(workspacePath);
}

function normalizeSprintSupervisorSourcePath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

function normalizeSprintSupervisorRecord(value: unknown): SprintSupervisorRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sourcePath = typeof raw.sourcePath === "string" ? raw.sourcePath.trim() : "";
  if (!sourcePath) return null;
  return {
    sourcePath,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    tickIntervalSeconds:
      typeof raw.tickIntervalSeconds === "number" && Number.isFinite(raw.tickIntervalSeconds) && raw.tickIntervalSeconds > 2
        ? Math.max(3, Math.floor(raw.tickIntervalSeconds))
        : 12,
    governance: resolveSprintGovernance(raw.governance && typeof raw.governance === "object" ? raw.governance as {
      targetWip?: number;
      maxAutoLaunchPerAction?: number;
      blockLaunchWhenReviewPending?: boolean;
      allowImportDuringAutoLaunch?: boolean;
    } : {}),
    lastTickAt: typeof raw.lastTickAt === "string" && raw.lastTickAt.trim() ? raw.lastTickAt : null,
    lastActionAt: typeof raw.lastActionAt === "string" && raw.lastActionAt.trim() ? raw.lastActionAt : null,
    lastError: typeof raw.lastError === "string" && raw.lastError.trim() ? raw.lastError.trim() : null,
    lastReport: normalizeSprintControlActionReport(raw.lastReport)
  };
}

function normalizeSprintControlActionReport(value: unknown): WorkSprintControlActionReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const action = normalizeSprintControlAction(raw.action);
  if (!action) return null;
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates
        .map((entry) => normalizeSprintLaunchCandidate(entry))
        .filter((entry): entry is WorkSprintLaunchCandidate => entry !== null)
    : [];
  return {
    action,
    slotsRequested: typeof raw.slotsRequested === "number" && raw.slotsRequested >= 0 ? Math.floor(raw.slotsRequested) : 0,
    slotsFilled: typeof raw.slotsFilled === "number" && raw.slotsFilled >= 0 ? Math.floor(raw.slotsFilled) : 0,
    governance: resolveSprintGovernance(raw.governance && typeof raw.governance === "object" ? raw.governance as {
      targetWip?: number;
      maxAutoLaunchPerAction?: number;
      blockLaunchWhenReviewPending?: boolean;
      allowImportDuringAutoLaunch?: boolean;
    } : {}),
    candidates
  };
}

function normalizeSprintLaunchCandidate(value: unknown): WorkSprintLaunchCandidate | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const pbiId = typeof raw.pbiId === "string" ? raw.pbiId.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!pbiId || !title) return null;
  const stateRaw = typeof raw.state === "string" ? raw.state.trim().toLowerCase() : "";
  const state: WorkSprintLaunchCandidate["state"] =
    stateRaw === "ready" || stateRaw === "running" || stateRaw === "review" || stateRaw === "blocked" || stateRaw === "completed"
      ? stateRaw
      : "unimported";
  const dispositionRaw = typeof raw.disposition === "string" ? raw.disposition.trim().toLowerCase() : "";
  const disposition: WorkSprintLaunchCandidate["disposition"] =
    dispositionRaw === "selected" || dispositionRaw === "deferred" ? dispositionRaw : dispositionRaw === "blocked" ? "blocked" : "blocked";
  return {
    pbiId,
    title,
    state,
    workItemId: typeof raw.workItemId === "string" && raw.workItemId.trim() ? raw.workItemId : null,
    score: typeof raw.score === "number" ? raw.score : 0,
    disposition,
    reasons: normalizeStringArray(raw.reasons)
  };
}

async function loadSprintSupervisorRecordsForWorkspacePath(workspacePath: string): Promise<SprintSupervisorRecord[]> {
  const raw = await readJsonIfExists<unknown[]>(getSprintSupervisorsPath(workspacePath));
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeSprintSupervisorRecord(entry))
    .filter((entry): entry is SprintSupervisorRecord => entry !== null);
}

async function saveSprintSupervisorRecordsForWorkspacePath(workspacePath: string, records: SprintSupervisorRecord[]): Promise<void> {
  await writeJson(getSprintSupervisorsPath(workspacePath), records);
}

async function loadSprintSupervisorForSourcePath(workspacePath: string, sourcePath: string): Promise<SprintSupervisorRecord | null> {
  const records = await loadSprintSupervisorRecordsForWorkspacePath(workspacePath);
  const key = normalizeSprintSupervisorSourcePath(sourcePath);
  return records.find((record) => normalizeSprintSupervisorSourcePath(record.sourcePath) === key) ?? null;
}

async function upsertSprintSupervisorForSourcePath(
  workspacePath: string,
  input: Pick<SprintSupervisorRecord, "sourcePath" | "enabled" | "tickIntervalSeconds" | "governance">
): Promise<SprintSupervisorRecord> {
  const records = await loadSprintSupervisorRecordsForWorkspacePath(workspacePath);
  const key = normalizeSprintSupervisorSourcePath(input.sourcePath);
  const existing = records.find((record) => normalizeSprintSupervisorSourcePath(record.sourcePath) === key) ?? null;
  const nextRecord: SprintSupervisorRecord = {
    sourcePath: input.sourcePath.trim(),
    enabled: input.enabled,
    tickIntervalSeconds: Math.max(3, Math.floor(input.tickIntervalSeconds || 12)),
    governance: input.governance,
    lastTickAt: existing?.lastTickAt ?? null,
    lastActionAt: existing?.lastActionAt ?? null,
    lastError: null,
    lastReport: existing?.lastReport ?? null
  };
  const nextRecords = [
    ...records.filter((record) => normalizeSprintSupervisorSourcePath(record.sourcePath) !== key),
    nextRecord
  ].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  await saveSprintSupervisorRecordsForWorkspacePath(workspacePath, nextRecords);
  return nextRecord;
}

function toWorkSprintSupervisor(
  record: SprintSupervisorRecord | null,
  sourcePath: string,
  isRunning: boolean
): WorkSprintSupervisor {
  const state: WorkSprintSupervisor["state"] =
    !record?.enabled
      ? "paused"
      : isRunning
        ? "running"
        : record.lastError
          ? "error"
          : "idle";
  return {
    sourcePath,
    enabled: record?.enabled ?? false,
    state,
    tickIntervalSeconds: record?.tickIntervalSeconds ?? 12,
    governance: record?.governance ?? defaultSprintGovernance(),
    lastTickAt: record?.lastTickAt ?? null,
    lastActionAt: record?.lastActionAt ?? null,
    lastError: record?.lastError ?? null,
    lastReport: record?.lastReport ?? null
  };
}

function createSprintSupervisorRuntime(options: {
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  runsDir: string;
  stateIndex: StateIndex;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  agentPlatform: WorkAgentPlatform;
}) {
  let timer: NodeJS.Timeout | null = null;
  const activeKeys = new Set<string>();

  const runtime = {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, 5000);
    },
    isRunning(workspaceId: string, sourcePath: string) {
      return activeKeys.has(`${workspaceId}:${normalizeSprintSupervisorSourcePath(sourcePath)}`);
    }
  };

  const tick = async () => {
    const workspaces = await loadWorkspaces(options.rootDir, {
      repoPaths: await options.listWorkspacePaths().catch(() => [])
    }).catch(() => []);
    for (const workspace of workspaces) {
      const records = await loadSprintSupervisorRecordsForWorkspacePath(workspace.path).catch(() => []);
      for (const record of records.filter((entry) => entry.enabled)) {
        await processSupervisor(workspace.id, workspace.path, record);
      }
    }
  };

  const processSupervisor = async (workspaceId: string, workspacePath: string, record: SprintSupervisorRecord) => {
    const key = `${workspaceId}:${normalizeSprintSupervisorSourcePath(record.sourcePath)}`;
    if (activeKeys.has(key)) return;
    const lastTickMs = record.lastTickAt ? Date.parse(record.lastTickAt) : NaN;
    if (!Number.isNaN(lastTickMs) && Date.now() - lastTickMs < record.tickIntervalSeconds * 1000) {
      return;
    }
    activeKeys.add(key);
    try {
      const preview = await previewSprintBacklog({
        workspacePath,
        sourcePath: record.sourcePath
      });
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const control = buildSprintControlSummary({
        preview,
        workItems,
        governance: record.governance,
        supervisor: toWorkSprintSupervisor(record, record.sourcePath, true)
      });
      const outcome = await executeSprintControlAction({
        action: "fill_wip",
        governance: record.governance,
        control,
        workspaceId,
        workspacePath,
        preview,
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        runsDir: options.runsDir,
        stateIndex: options.stateIndex,
        resolveWorkspacePath: options.resolveWorkspacePath,
        agentPlatform: options.agentPlatform
      });
      const now = new Date().toISOString();
      await upsertSprintSupervisorRuntimeResult(workspacePath, {
        sourcePath: record.sourcePath,
        lastTickAt: now,
        lastActionAt: outcome.launched.length > 0 || outcome.imported.length > 0 ? now : record.lastActionAt,
        lastError: null,
        lastReport: outcome.report
      });
    } catch (error) {
      await upsertSprintSupervisorRuntimeResult(workspacePath, {
        sourcePath: record.sourcePath,
        lastTickAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      });
    } finally {
      activeKeys.delete(key);
    }
  };

  return runtime;
}

async function upsertSprintSupervisorRuntimeResult(
  workspacePath: string,
  input: {
    sourcePath: string;
    lastTickAt: string;
    lastActionAt?: string | null;
    lastError?: string | null;
    lastReport?: WorkSprintControlActionReport | null;
  }
): Promise<void> {
  const records = await loadSprintSupervisorRecordsForWorkspacePath(workspacePath);
  const key = normalizeSprintSupervisorSourcePath(input.sourcePath);
  const nextRecords = records.map((record) => {
    if (normalizeSprintSupervisorSourcePath(record.sourcePath) !== key) return record;
    return {
      ...record,
      lastTickAt: input.lastTickAt,
      lastActionAt: typeof input.lastActionAt === "undefined" ? record.lastActionAt : input.lastActionAt ?? null,
      lastError: typeof input.lastError === "undefined" ? record.lastError : input.lastError ?? null,
      lastReport: typeof input.lastReport === "undefined" ? record.lastReport : input.lastReport ?? null
    };
  });
  await saveSprintSupervisorRecordsForWorkspacePath(workspacePath, nextRecords);
}

function createOrganizationSupervisorRuntime(options: {
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  runsDir: string;
  stateIndex: StateIndex;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  agentPlatform: WorkAgentPlatform;
}) {
  let timer: NodeJS.Timeout | null = null;
  const activeWorkspaceIds = new Set<string>();

  const runtime = {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, 5000);
    },
    isRunning(workspaceId: string) {
      return activeWorkspaceIds.has(workspaceId);
    }
  };

  const tick = async () => {
    const workspaces = await loadWorkspaces(options.rootDir, {
      repoPaths: await options.listWorkspacePaths().catch(() => [])
    }).catch(() => []);
    for (const workspace of workspaces) {
      const record = await loadOrganizationSupervisorForWorkspacePath(workspace.path).catch(() => null);
      if (!record?.enabled) continue;
      await processSupervisor(workspace.id, workspace.path, record);
    }
  };

  const processSupervisor = async (
    workspaceId: string,
    workspacePath: string,
    record: OrganizationSupervisorRecord
  ) => {
    if (activeWorkspaceIds.has(workspaceId)) return;
    const lastTickMs = record.lastTickAt ? Date.parse(record.lastTickAt) : NaN;
    if (!Number.isNaN(lastTickMs) && Date.now() - lastTickMs < record.tickIntervalSeconds * 1000) {
      return;
    }
    activeWorkspaceIds.add(workspaceId);
    try {
      const workItems = await listHydratedWorkItems({
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform
      });
      const sprintSupervisorSourcePaths = await listEnabledSprintSupervisorSourcePaths(workspacePath);
      const control = buildOrganizationControlSummary({
        workspaceId,
        workItems,
        governance: record.governance,
        supervisor: toWorkOrganizationSupervisor(record, true),
        sprintSupervisorSourcePaths
      });
      const outcome = await executeOrganizationControlAction({
        action: "fill_wip",
        governance: record.governance,
        control,
        workspaceId,
        workspacePath,
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        runsDir: options.runsDir,
        stateIndex: options.stateIndex,
        resolveWorkspacePath: options.resolveWorkspacePath,
        agentPlatform: options.agentPlatform
      });
      const now = new Date().toISOString();
      await upsertOrganizationSupervisorRuntimeResult(workspacePath, {
        lastTickAt: now,
        lastActionAt: outcome.launched.length > 0 ? now : record.lastActionAt,
        lastError: null,
        lastReport: outcome.report
      });
    } catch (error) {
      await upsertOrganizationSupervisorRuntimeResult(workspacePath, {
        lastTickAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      });
    } finally {
      activeWorkspaceIds.delete(workspaceId);
    }
  };

  return runtime;
}

async function upsertOrganizationSupervisorRuntimeResult(
  workspacePath: string,
  input: {
    lastTickAt: string;
    lastActionAt?: string | null;
    lastError?: string | null;
    lastReport?: WorkOrganizationControlActionReport | null;
  }
): Promise<void> {
  const existing = await loadOrganizationSupervisorForWorkspacePath(workspacePath);
  if (!existing) return;
  await saveOrganizationSupervisorForWorkspacePath(workspacePath, {
    ...existing,
    lastTickAt: input.lastTickAt,
    lastActionAt: typeof input.lastActionAt === "undefined" ? existing.lastActionAt : input.lastActionAt ?? null,
    lastError: typeof input.lastError === "undefined" ? existing.lastError : input.lastError ?? null,
    lastReport: typeof input.lastReport === "undefined" ? existing.lastReport : input.lastReport ?? null
  });
}

function resolveSprintGovernance(input: {
  targetWip?: number;
  maxAutoLaunchPerAction?: number;
  blockLaunchWhenReviewPending?: boolean;
  allowImportDuringAutoLaunch?: boolean;
}): WorkSprintGovernance {
  const defaults = defaultSprintGovernance();
  return {
    targetWip:
      typeof input.targetWip === "number" && Number.isFinite(input.targetWip) && input.targetWip > 0
        ? Math.max(1, Math.floor(input.targetWip))
        : defaults.targetWip,
    maxAutoLaunchPerAction:
      typeof input.maxAutoLaunchPerAction === "number" &&
      Number.isFinite(input.maxAutoLaunchPerAction) &&
      input.maxAutoLaunchPerAction > 0
        ? Math.max(1, Math.floor(input.maxAutoLaunchPerAction))
        : defaults.maxAutoLaunchPerAction,
    blockLaunchWhenReviewPending:
      typeof input.blockLaunchWhenReviewPending === "boolean"
        ? input.blockLaunchWhenReviewPending
        : defaults.blockLaunchWhenReviewPending,
    allowImportDuringAutoLaunch:
      typeof input.allowImportDuringAutoLaunch === "boolean"
        ? input.allowImportDuringAutoLaunch
        : defaults.allowImportDuringAutoLaunch
  };
}

function buildSprintLaunchQueue(options: {
  pbis: WorkSprintControlPbi[];
  governance: WorkSprintGovernance;
}): WorkSprintLaunchCandidate[] {
  const hasReviewQueue = options.pbis.some((pbi) => pbi.state === "review");
  const candidates = options.pbis
    .filter((pbi) => pbi.state === "ready" || pbi.state === "unimported" || pbi.state === "blocked")
    .map((pbi) => buildSprintLaunchCandidate({
      pbi,
      governance: options.governance,
      hasReviewQueue
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.disposition !== right.disposition) {
        return launchDispositionRank(left.disposition) - launchDispositionRank(right.disposition);
      }
      return left.pbiId.localeCompare(right.pbiId);
    });
  return candidates;
}

function buildSprintLaunchCandidate(options: {
  pbi: WorkSprintControlPbi;
  governance: WorkSprintGovernance;
  hasReviewQueue: boolean;
}): WorkSprintLaunchCandidate {
  const reasons: string[] = [];
  let score = 0;
  let disposition: WorkSprintLaunchCandidate["disposition"] = "selected";

  if (options.pbi.state === "ready") {
    score += 80;
    reasons.push("Already imported and ready to launch.");
  } else if (options.pbi.state === "unimported") {
    score += 62;
    reasons.push("Dependencies are clear, but the PBI still needs to be imported.");
  } else {
    disposition = "blocked";
    score -= 100;
    reasons.push(...(options.pbi.blockedReasons.length > 0 ? options.pbi.blockedReasons : ["This PBI is not launchable in the current sprint state."]));
  }

  if (options.pbi.dependsOn.length === 0) {
    score += 12;
    reasons.push("No upstream PBI dependency is declared.");
  } else {
    score += Math.max(0, 12 - options.pbi.dependsOn.length * 3);
    reasons.push(`${options.pbi.dependsOn.length} dependency reference(s) exist.`);
  }

  if (options.pbi.acceptanceCriteria.length > 0) {
    score += 8;
    reasons.push(`${options.pbi.acceptanceCriteria.length} acceptance criteria are already defined.`);
  }

  if (options.pbi.warnings.length > 0) {
    score -= options.pbi.warnings.length * 6;
    reasons.push(`${options.pbi.warnings.length} sprint parsing warning(s) reduce confidence.`);
  }

  if (options.hasReviewQueue && options.governance.blockLaunchWhenReviewPending && disposition === "selected") {
    disposition = "deferred";
    reasons.push("Governance blocks new launches while review-ready PBIs are waiting.");
    score -= 18;
  }

  if (!options.governance.allowImportDuringAutoLaunch && options.pbi.state === "unimported" && disposition === "selected") {
    disposition = "deferred";
    reasons.push("Governance forbids importing new PBIs during automatic launch.");
    score -= 20;
  }

  if (options.pbi.state === "blocked") {
    disposition = "blocked";
  }

  return {
    pbiId: options.pbi.pbiId,
    title: options.pbi.pbiTitle,
    state: options.pbi.state,
    workItemId: options.pbi.workItemId ?? null,
    score,
    disposition,
    reasons
  };
}

function launchDispositionRank(disposition: WorkSprintLaunchCandidate["disposition"]): number {
  if (disposition === "selected") return 0;
  if (disposition === "deferred") return 1;
  return 2;
}

function buildSprintBurndownTimeline(
  pbis: WorkSprintControlPbi[],
  workItemBySourceRef: Map<string, WorkItemRecord>
): WorkSprintBurndownPoint[] {
  const events = pbis.flatMap((pbi) => {
    const workItem = workItemBySourceRef.get(normalizeSprintSourceRef(pbi.sourceRef)) ?? null;
    if (!workItem) return [];
    const points: Array<{ at: string; type: "imported" | "started" | "approved"; pbiId: string }> = [
      { at: workItem.createdAt, type: "imported", pbiId: pbi.pbiId }
    ];
    for (const cycle of workItem.cycles ?? []) {
      points.push({ at: cycle.startedAt, type: "started", pbiId: pbi.pbiId });
    }
    if (workItem.reviewStatus === "approved" && workItem.reviewedAt) {
      points.push({ at: workItem.reviewedAt, type: "approved", pbiId: pbi.pbiId });
    }
    return points;
  }).sort((left, right) => (left.at > right.at ? 1 : -1));

  if (events.length === 0) return [];

  const imported = new Set<string>();
  const completed = new Set<string>();
  const active = new Set<string>();
  const points: WorkSprintBurndownPoint[] = [];
  for (const event of events) {
    if (event.type === "imported") {
      imported.add(event.pbiId);
    } else if (event.type === "started") {
      active.add(event.pbiId);
    } else if (event.type === "approved") {
      completed.add(event.pbiId);
      active.delete(event.pbiId);
    }
    points.push({
      at: event.at,
      label: new Date(event.at).toLocaleDateString(),
      completed: completed.size,
      remaining: Math.max(0, pbis.length - completed.size),
      active: active.size
    });
  }

  const deduped: WorkSprintBurndownPoint[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.label === point.label) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    deduped.push(point);
  }
  return deduped.slice(-10);
}

function buildOrganizationControlSummary(options: {
  workspaceId: string;
  workItems: WorkItemRecord[];
  governance: WorkSprintGovernance;
  supervisor: WorkOrganizationSupervisor;
  sprintSupervisorSourcePaths: Set<string>;
}): WorkOrganizationControl {
  const summary = {
    total: options.workItems.length,
    draft: options.workItems.filter((item) => item.status === "draft").length,
    running: options.workItems.filter((item) => item.status === "running").length,
    review: options.workItems.filter((item) => item.status === "ready_for_review").length,
    blocked: options.workItems.filter((item) => item.status === "blocked").length,
    completed: options.workItems.filter((item) => item.status === "completed").length,
    failed: options.workItems.filter((item) => item.status === "failed").length,
    launchable: 0,
    activeWip: options.workItems.filter((item) => item.status === "running").length
  };
  const launchQueue = buildOrganizationLaunchQueue({
    workItems: options.workItems,
    governance: options.governance,
    sprintSupervisorSourcePaths: options.sprintSupervisorSourcePaths
  });
  summary.launchable = launchQueue.filter((candidate) => candidate.disposition === "selected").length;
  const blockers = Array.from(new Set([
    ...options.workItems
      .filter((item) => item.status === "ready_for_review")
      .slice(0, 3)
      .map((item) => `${item.brief.title} is waiting for operator review.`),
    ...options.workItems
      .filter((item) => item.status === "blocked" && item.reviewNote?.trim())
      .slice(0, 3)
      .map((item) => `${item.brief.title}: ${item.reviewNote?.trim()}`),
    ...launchQueue
      .filter((candidate) => candidate.disposition !== "selected")
      .flatMap((candidate) => candidate.reasons.slice(0, 1))
  ])).slice(0, 8);

  return {
    workspaceId: options.workspaceId,
    summary,
    governance: options.governance,
    launchQueue,
    blockers,
    supervisor: options.supervisor
  };
}

function buildOrganizationLaunchQueue(options: {
  workItems: WorkItemRecord[];
  governance: WorkSprintGovernance;
  sprintSupervisorSourcePaths: Set<string>;
}): WorkOrganizationLaunchCandidate[] {
  const hasReviewQueue = options.workItems.some((item) => item.status === "ready_for_review");
  return options.workItems
    .map((workItem) => buildOrganizationLaunchCandidate({
      workItem,
      governance: options.governance,
      hasReviewQueue,
      sprintSupervisorSourcePaths: options.sprintSupervisorSourcePaths
    }))
    .filter((candidate): candidate is WorkOrganizationLaunchCandidate => candidate !== null)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.disposition !== right.disposition) {
        return launchDispositionRank(left.disposition) - launchDispositionRank(right.disposition);
      }
      return left.title.localeCompare(right.title);
    });
}

function buildOrganizationLaunchCandidate(options: {
  workItem: WorkItemRecord;
  governance: WorkSprintGovernance;
  hasReviewQueue: boolean;
  sprintSupervisorSourcePaths: Set<string>;
}): WorkOrganizationLaunchCandidate | null {
  if (options.workItem.reviewStatus === "approved" || options.workItem.status === "completed" || options.workItem.status === "running") {
    return null;
  }

  const reasons: string[] = [];
  let score = sourceTypeLaunchPriority(options.workItem.brief.sourceType);
  let disposition: WorkOrganizationLaunchCandidate["disposition"] = "selected";

  if (options.workItem.status === "draft") {
    reasons.push("Work item is staged in the workspace backlog and ready for launch.");
    score += 18;
  } else if (options.workItem.status === "blocked" && options.workItem.reviewStatus === "changes_requested") {
    reasons.push("Operator requested remediation, so a focused relaunch is allowed.");
    score += 26;
  } else if (options.workItem.status === "blocked") {
    disposition = "blocked";
    reasons.push(options.workItem.reviewNote?.trim() || "Execution is blocked or paused and needs intervention.");
    score -= 48;
  } else if (options.workItem.status === "failed") {
    disposition = "blocked";
    reasons.push("Previous execution failed; review the failure before automatic relaunch.");
    score -= 70;
  } else {
    return null;
  }

  if (options.workItem.brief.acceptanceCriteria.length > 0) {
    score += Math.min(10, options.workItem.brief.acceptanceCriteria.length * 2);
    reasons.push(`${options.workItem.brief.acceptanceCriteria.length} acceptance criteria are already defined.`);
  }
  if (options.workItem.brief.constraints.length > 0) {
    score += Math.min(6, options.workItem.brief.constraints.length);
    reasons.push(`${options.workItem.brief.constraints.length} delivery constraints are already captured.`);
  }
  if ((options.workItem.cycles?.length ?? 0) > 0 && options.workItem.reviewStatus === "changes_requested") {
    score += 8;
    reasons.push("This item already has cycle history, so remediation should be targeted.");
  }

  const sprintSourcePath = normalizeWorkItemSprintSourcePath(options.workItem);
  if (
    disposition === "selected" &&
    options.workItem.brief.sourceType === "pbi" &&
    sprintSourcePath &&
    options.sprintSupervisorSourcePaths.has(sprintSourcePath)
  ) {
    disposition = "deferred";
    score -= 28;
    reasons.push("This PBI is already governed by an enabled sprint supervisor.");
  }

  if (disposition === "selected" && options.hasReviewQueue && options.governance.blockLaunchWhenReviewPending) {
    disposition = "deferred";
    score -= 18;
    reasons.push("Governance blocks new launches while the review queue is non-empty.");
  }

  return {
    workItemId: options.workItem.id,
    title: options.workItem.brief.title,
    sourceType: options.workItem.brief.sourceType,
    status: options.workItem.status,
    reviewStatus: options.workItem.reviewStatus,
    score,
    disposition,
    reasons
  };
}

function sourceTypeLaunchPriority(sourceType: WorkItemSourceType): number {
  switch (sourceType) {
    case "bug":
      return 92;
    case "pr_hardening":
      return 84;
    case "pbi":
      return 76;
    default:
      return 66;
  }
}

function getOrganizationSupervisorPath(workspacePath: string): string {
  return getWorkspaceOrganizationSupervisorPath(workspacePath);
}

function normalizeOrganizationSupervisorRecord(value: unknown): OrganizationSupervisorRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    tickIntervalSeconds:
      typeof raw.tickIntervalSeconds === "number" && Number.isFinite(raw.tickIntervalSeconds) && raw.tickIntervalSeconds > 2
        ? Math.max(3, Math.floor(raw.tickIntervalSeconds))
        : 12,
    governance: resolveSprintGovernance(
      raw.governance && typeof raw.governance === "object"
        ? raw.governance as {
            targetWip?: number;
            maxAutoLaunchPerAction?: number;
            blockLaunchWhenReviewPending?: boolean;
            allowImportDuringAutoLaunch?: boolean;
          }
        : {}
    ),
    lastTickAt: typeof raw.lastTickAt === "string" && raw.lastTickAt.trim() ? raw.lastTickAt : null,
    lastActionAt: typeof raw.lastActionAt === "string" && raw.lastActionAt.trim() ? raw.lastActionAt : null,
    lastError: typeof raw.lastError === "string" && raw.lastError.trim() ? raw.lastError.trim() : null,
    lastReport: normalizeOrganizationControlActionReport(raw.lastReport)
  };
}

function normalizeOrganizationControlActionReport(value: unknown): WorkOrganizationControlActionReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const action = normalizeOrganizationControlAction(raw.action);
  if (!action) return null;
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates
        .map((entry) => normalizeOrganizationLaunchCandidate(entry))
        .filter((entry): entry is WorkOrganizationLaunchCandidate => entry !== null)
    : [];
  return {
    action,
    launchedWorkItemIds: normalizeStringArray(raw.launchedWorkItemIds),
    slotsRequested: typeof raw.slotsRequested === "number" && raw.slotsRequested >= 0 ? Math.floor(raw.slotsRequested) : 0,
    slotsFilled: typeof raw.slotsFilled === "number" && raw.slotsFilled >= 0 ? Math.floor(raw.slotsFilled) : 0,
    governance: resolveSprintGovernance(
      raw.governance && typeof raw.governance === "object"
        ? raw.governance as {
            targetWip?: number;
            maxAutoLaunchPerAction?: number;
            blockLaunchWhenReviewPending?: boolean;
            allowImportDuringAutoLaunch?: boolean;
          }
        : {}
    ),
    candidates
  };
}

function normalizeOrganizationLaunchCandidate(value: unknown): WorkOrganizationLaunchCandidate | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const workItemId = typeof raw.workItemId === "string" ? raw.workItemId.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!workItemId || !title) return null;
  const sourceType = normalizeSourceType(raw.sourceType) ?? "feature";
  const dispositionRaw = typeof raw.disposition === "string" ? raw.disposition.trim().toLowerCase() : "";
  const disposition: WorkOrganizationLaunchCandidate["disposition"] =
    dispositionRaw === "selected" || dispositionRaw === "deferred"
      ? dispositionRaw
      : "blocked";
  return {
    workItemId,
    title,
    sourceType,
    status: normalizeWorkItemStatus(typeof raw.status === "string" ? raw.status : undefined),
    reviewStatus: normalizeReviewStatus(raw.reviewStatus),
    score: typeof raw.score === "number" ? raw.score : 0,
    disposition,
    reasons: normalizeStringArray(raw.reasons)
  };
}

async function loadOrganizationSupervisorForWorkspacePath(workspacePath: string): Promise<OrganizationSupervisorRecord | null> {
  const raw = await readJsonIfExists<unknown>(getOrganizationSupervisorPath(workspacePath));
  return normalizeOrganizationSupervisorRecord(raw);
}

async function saveOrganizationSupervisorForWorkspacePath(
  workspacePath: string,
  record: OrganizationSupervisorRecord
): Promise<void> {
  await writeJson(getOrganizationSupervisorPath(workspacePath), record);
}

async function upsertOrganizationSupervisorForWorkspacePath(
  workspacePath: string,
  input: Pick<OrganizationSupervisorRecord, "enabled" | "tickIntervalSeconds" | "governance">
): Promise<OrganizationSupervisorRecord> {
  const existing = await loadOrganizationSupervisorForWorkspacePath(workspacePath);
  const nextRecord: OrganizationSupervisorRecord = {
    enabled: input.enabled,
    tickIntervalSeconds: Math.max(3, Math.floor(input.tickIntervalSeconds || 12)),
    governance: input.governance,
    lastTickAt: existing?.lastTickAt ?? null,
    lastActionAt: existing?.lastActionAt ?? null,
    lastError: null,
    lastReport: existing?.lastReport ?? null
  };
  await saveOrganizationSupervisorForWorkspacePath(workspacePath, nextRecord);
  return nextRecord;
}

function toWorkOrganizationSupervisor(
  record: OrganizationSupervisorRecord | null,
  isRunning: boolean
): WorkOrganizationSupervisor {
  const state: WorkOrganizationSupervisor["state"] =
    !record?.enabled
      ? "paused"
      : isRunning
        ? "running"
        : record.lastError
          ? "error"
          : "idle";
  return {
    enabled: record?.enabled ?? false,
    state,
    tickIntervalSeconds: record?.tickIntervalSeconds ?? 12,
    governance: record?.governance ?? defaultSprintGovernance(),
    lastTickAt: record?.lastTickAt ?? null,
    lastActionAt: record?.lastActionAt ?? null,
    lastError: record?.lastError ?? null,
    lastReport: record?.lastReport ?? null
  };
}

async function listEnabledSprintSupervisorSourcePaths(workspacePath: string): Promise<Set<string>> {
  const records = await loadSprintSupervisorRecordsForWorkspacePath(workspacePath);
  return new Set(
    records
      .filter((record) => record.enabled)
      .map((record) => normalizeSprintSupervisorSourcePath(record.sourcePath))
  );
}

function normalizeWorkItemSprintSourcePath(workItem: WorkItemRecord): string | null {
  if (workItem.brief.sourceType !== "pbi" || !workItem.brief.sourceRef) return null;
  const sourceRef = workItem.brief.sourceRef.trim();
  if (!sourceRef) return null;
  const index = sourceRef.indexOf("::");
  const sourcePath = index >= 0 ? sourceRef.slice(0, index).trim() : sourceRef;
  return sourcePath ? normalizeSprintSupervisorSourcePath(sourcePath) : null;
}

async function executeOrganizationControlAction(options: {
  action: WorkOrganizationControlAction;
  governance: WorkSprintGovernance;
  control: WorkOrganizationControl;
  workspaceId: string;
  workspacePath: string;
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  runsDir: string;
  stateIndex: StateIndex;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  agentPlatform: WorkAgentPlatform;
}): Promise<{
  launched: WorkItemRecord[];
  skipped: WorkOrganizationLaunchSkip[];
  control: WorkOrganizationControl;
  report: WorkOrganizationControlActionReport;
}> {
  const launched: WorkItemRecord[] = [];
  const skipped: WorkOrganizationLaunchSkip[] = [];
  const launchCandidates = options.control.launchQueue;
  const slots =
    options.action === "launch_next_ready"
      ? 1
      : Math.max(0, options.governance.targetWip - options.control.summary.activeWip);
  const slotsRequested = Math.max(0, Math.min(slots, options.governance.maxAutoLaunchPerAction));

  if (slotsRequested > 0) {
    for (const candidate of launchCandidates.filter((entry) => entry.disposition === "selected").slice(0, slotsRequested)) {
      const found = await findRawWorkItemById({
        id: candidate.workItemId,
        rootDir: options.rootDir,
        listWorkspacePaths: options.listWorkspacePaths,
        workspaceId: options.workspaceId,
        resolveWorkspacePath: options.resolveWorkspacePath
      });
      if (!found) {
        skipped.push({
          workItemId: candidate.workItemId,
          title: candidate.title,
          reason: "Work item could not be resolved for launch."
        });
        continue;
      }
      try {
        const started = await startRawWorkItemExecution({
          found,
          runsDir: options.runsDir,
          stateIndex: options.stateIndex,
          agentPlatform: options.agentPlatform,
          resolveWorkspacePath: options.resolveWorkspacePath
        });
        launched.push(started.workItem);
      } catch (error) {
        skipped.push({
          workItemId: candidate.workItemId,
          title: candidate.title,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  await options.stateIndex.rebuild().catch(() => undefined);
  const workItems = await listHydratedWorkItems({
    rootDir: options.rootDir,
    listWorkspacePaths: options.listWorkspacePaths,
    workspaceId: options.workspaceId,
    resolveWorkspacePath: options.resolveWorkspacePath,
    stateIndex: options.stateIndex,
    agentPlatform: options.agentPlatform
  });
  const sprintSupervisorSourcePaths = await listEnabledSprintSupervisorSourcePaths(options.workspacePath);
  const control = buildOrganizationControlSummary({
    workspaceId: options.workspaceId,
    workItems,
    governance: options.governance,
    supervisor: options.control.supervisor,
    sprintSupervisorSourcePaths
  });

  return {
    launched,
    skipped,
    control,
    report: {
      action: options.action,
      launchedWorkItemIds: launched.map((workItem) => workItem.id),
      slotsRequested,
      slotsFilled: launched.length,
      governance: options.governance,
      candidates: launchCandidates
    }
  };
}

async function importSprintPreviewPbis(options: {
  workspaceId: string;
  workspacePath: string;
  targetPbis: Awaited<ReturnType<typeof previewSprintBacklog>>["pbis"];
}): Promise<{ created: WorkItemRecord[]; skipped: WorkItemImportSkip[] }> {
  const workItems = await loadWorkItemsForWorkspacePath(options.workspacePath);
  const now = new Date().toISOString();
  const created: WorkItemRecord[] = [];
  const skipped: WorkItemImportSkip[] = [];

  for (const pbi of options.targetPbis) {
    const existing = workItems.find((item) =>
      item.brief.sourceType === "pbi" &&
      normalizeSprintSourceRef(item.brief.sourceRef ?? "") === normalizeSprintSourceRef(pbi.sourceRef)
    );
    if (existing) {
      skipped.push({
        pbiId: pbi.pbiId,
        reason: "A work item for this sprint PBI already exists in the workspace queue."
      });
      continue;
    }

    const workItem: WorkItemRecord = {
      id: crypto.randomUUID(),
      workspaceId: options.workspaceId,
      brief: {
        workspaceId: options.workspaceId,
        sourceType: "pbi",
        title: `${pbi.pbiId} · ${pbi.pbiTitle}`,
        request: pbi.summary?.trim() || `${pbi.pbiId} backlog item imported from sprint markdown.`,
        sourceRef: pbi.sourceRef,
        acceptanceCriteria: [...pbi.acceptanceCriteria],
        constraints: []
      },
      status: "draft",
      recommendedTemplateId: templateForSourceType("pbi"),
      executionMode: null,
      linkedRunId: null,
      linkedRunStatus: null,
      linkedRunVerdict: null,
      linkedTaskIds: [],
      linkedTaskStatus: null,
      reviewStatus: "pending",
      reviewNote: null,
      reviewedAt: null,
      currentCycleId: null,
      cycles: [],
      remediationPlan: null,
      optimization: null,
      createdAt: now,
      updatedAt: now,
      lastStartedAt: null
    };
    workItems.unshift(workItem);
    created.push(workItem);
  }

  if (created.length > 0) {
    await saveWorkItemsForWorkspacePath(options.workspacePath, workItems);
  }

  return {
    created,
    skipped
  };
}

async function executeSprintControlAction(options: {
  action: WorkSprintControlAction;
  governance: WorkSprintGovernance;
  control: WorkSprintControl;
  workspaceId: string;
  workspacePath: string;
  preview: Awaited<ReturnType<typeof previewSprintBacklog>>;
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  runsDir: string;
  stateIndex: StateIndex;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  agentPlatform: WorkAgentPlatform;
}): Promise<{
  imported: WorkItemRecord[];
  launched: WorkItemRecord[];
  skipped: WorkItemImportSkip[];
  control: WorkSprintControl;
  report: WorkSprintControlActionReport;
}> {
  const imported: WorkItemRecord[] = [];
  const launched: WorkItemRecord[] = [];
  const skipped: WorkItemImportSkip[] = [];
  const launchCandidates = options.control.launchQueue;
  const slots =
    options.action === "launch_next_ready"
      ? 1
      : Math.max(0, options.governance.targetWip - options.control.summary.activeWip);
  const slotsRequested = Math.max(0, Math.min(slots, options.governance.maxAutoLaunchPerAction));

  if (slotsRequested <= 0) {
    await options.stateIndex.rebuild().catch(() => undefined);
      const control = buildSprintControlSummary({
        preview: options.preview,
        workItems: await listHydratedWorkItems({
          rootDir: options.rootDir,
          listWorkspacePaths: options.listWorkspacePaths,
          workspaceId: options.workspaceId,
          resolveWorkspacePath: options.resolveWorkspacePath,
          stateIndex: options.stateIndex,
          agentPlatform: options.agentPlatform
        }),
        governance: options.governance,
        supervisor: options.control.supervisor
      });
    return {
      imported,
      launched,
      skipped,
      control,
      report: {
        action: options.action,
        slotsRequested,
        slotsFilled: 0,
        governance: options.governance,
        candidates: launchCandidates
      }
    };
  }

  for (const candidate of launchCandidates.filter((entry) => entry.disposition === "selected").slice(0, slotsRequested)) {
    let workItemId = candidate.workItemId ?? null;
    if (!workItemId) {
      if (!options.governance.allowImportDuringAutoLaunch) {
        skipped.push({ pbiId: candidate.pbiId, reason: "Governance forbids importing new PBIs during automatic launch." });
        continue;
      }
      const pbiPreview = options.preview.pbis.find((pbi) => pbi.pbiId === candidate.pbiId);
      if (!pbiPreview) {
        skipped.push({ pbiId: candidate.pbiId, reason: "PBI preview record is missing." });
        continue;
      }
      const createdBatch = await importSprintPreviewPbis({
        workspaceId: options.workspaceId,
        workspacePath: options.workspacePath,
        targetPbis: [pbiPreview]
      });
      imported.push(...createdBatch.created);
      skipped.push(...createdBatch.skipped);
      workItemId = createdBatch.created[0]?.id ?? null;
      if (!workItemId) continue;
    }

    const found = await findRawWorkItemById({
      id: workItemId,
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId: options.workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath
    });
    if (!found) {
      skipped.push({ pbiId: candidate.pbiId, reason: "Imported work item could not be resolved for launch." });
      continue;
    }
    try {
      const started = await startRawWorkItemExecution({
        found,
        runsDir: options.runsDir,
        stateIndex: options.stateIndex,
        agentPlatform: options.agentPlatform,
        resolveWorkspacePath: options.resolveWorkspacePath
      });
      launched.push(started.workItem);
      await options.stateIndex.rebuild().catch(() => undefined);
    } catch (error) {
      skipped.push({
        pbiId: candidate.pbiId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await options.stateIndex.rebuild().catch(() => undefined);
  const control = buildSprintControlSummary({
    preview: options.preview,
    workItems: await listHydratedWorkItems({
      rootDir: options.rootDir,
      listWorkspacePaths: options.listWorkspacePaths,
      workspaceId: options.workspaceId,
      resolveWorkspacePath: options.resolveWorkspacePath,
      stateIndex: options.stateIndex,
      agentPlatform: options.agentPlatform
    }),
    governance: options.governance,
    supervisor: options.control.supervisor
  });

  return {
    imported,
    launched,
    skipped,
    control,
    report: {
      action: options.action,
      slotsRequested,
      slotsFilled: launched.length,
      governance: options.governance,
      candidates: launchCandidates
    }
  };
}

async function startRawWorkItemExecution(options: {
  found: RawWorkItemLookup;
  runsDir: string;
  stateIndex: StateIndex;
  agentPlatform: WorkAgentPlatform;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  startOptions?: {
    concurrency?: number;
    modelOverrides?: Record<string, string>;
    strategyMode?: string;
  };
}): Promise<{ workItem: WorkItemRecord; runId?: string }> {
  const workspacePath = await options.resolveWorkspacePath(options.found.workItem.workspaceId);
  if (!workspacePath) {
    throw new Error("Workspace not found");
  }
  const planningDetail = await buildWorkItemPlanningDetail({
    workspacePath,
    workItem: options.found.workItem
  });

  const activeRuns = await options.stateIndex.queryRuns(options.found.workItem.workspaceId).catch(() => []);
  const runByKey = buildRunMap(activeRuns);
  const taskByWorkItem = buildTaskMap(options.agentPlatform.listTasks({ workspaceId: options.found.workItem.workspaceId }));
  const hydrated = hydrateWorkItem(options.found.workItem, runByKey, taskByWorkItem);
  if (hydrated.reviewStatus === "approved") {
    throw new Error("Work item is already approved and completed");
  }
  if (hydrated.linkedRunId && isActiveExecutionStatus(hydrated.linkedRunStatus)) {
    throw new Error("Work item already has an active linked run");
  }
  if ((hydrated.linkedTaskIds?.length ?? 0) > 0 && isActiveExecutionStatus(hydrated.linkedTaskStatus)) {
    throw new Error("Work item already has active linked tasks");
  }

  const executionDetail =
    options.found.workItem.reviewStatus === "changes_requested" && options.found.workItem.remediationPlan
      ? applyRemediationPlanToPlanningDetail({
          detail: planningDetail,
          remediationPlan: options.found.workItem.remediationPlan
        })
      : planningDetail;
  const strategyState = await loadStrategyState(workspacePath).catch(() => null);
  const resolvedStrategyMode =
    options.startOptions?.strategyMode ??
    (typeof strategyState?.recommendedMode === "string" && strategyState.recommendedMode.trim()
      ? strategyState.recommendedMode.trim()
      : undefined);
  const nextCycleSequence = Math.max(1, (options.found.workItem.cycles?.length ?? 0) + 1);
  const cyclePlan = createWorkItemCyclePlan({
    detail: executionDetail,
    source: options.found.workItem.reviewStatus === "changes_requested" ? "remediation" : "baseline",
    sourceCycleId: options.found.workItem.reviewStatus === "changes_requested" ? options.found.workItem.currentCycleId ?? null : null,
    sourceRemediationPlanId: options.found.workItem.remediationPlan?.id ?? null,
    headline:
      options.found.workItem.reviewStatus === "changes_requested"
        ? `Cycle ${nextCycleSequence} remediation`
        : `Cycle ${nextCycleSequence} execution`
  });

  const runId = createWorkRunId(options.found.workItem.id);
  let result: { ok: boolean; runId?: string; taskIds?: string[]; executionMode: WorkItemExecutionMode };
  if (shouldUseTaskGraphExecution(options.found.workItem, executionDetail)) {
    const queued = await options.agentPlatform.queueWorkItemExecution({
      workspaceId: options.found.workItem.workspaceId,
      workItem: options.found.workItem,
      detail: executionDetail
    });
    result = {
      ok: true,
      taskIds: queued.taskIds,
      executionMode: "task_graph"
    };
  } else {
    const started = await options.agentPlatform.startMission({
      runsDir: options.runsDir,
      workspaceId: options.found.workItem.workspaceId,
      repoPath: workspacePath,
      templateId: options.found.workItem.recommendedTemplateId,
      goal: compileMissionGoal(options.found.workItem, executionDetail),
      runId,
      runOptions: {
        concurrency: options.startOptions?.concurrency,
        modelOverrides: options.startOptions?.modelOverrides,
        strategyMode: resolvedStrategyMode
      }
    });
    result = {
      ok: started.ok,
      runId: started.runId,
      executionMode: "mission"
    };
  }

  const now = new Date().toISOString();
  const preparedWorkItem = closeCurrentCycle(options.found.workItem, hydrated.status, now);
  const nextCycle = createWorkItemCycle({
    workItem: options.found.workItem,
    startedAt: now,
    executionMode: result.executionMode,
    linkedRunId: result.executionMode === "mission" ? result.runId ?? null : null,
    linkedTaskIds: result.executionMode === "task_graph" ? result.taskIds ?? [] : [],
    summary: executionDetail.summary,
    plan: cyclePlan
  });
  const updatedWorkItem: WorkItemRecord = {
    ...preparedWorkItem,
    status: "running",
    executionMode: result.executionMode,
    linkedRunId: result.executionMode === "mission" ? result.runId ?? null : null,
    linkedRunStatus: result.executionMode === "mission" ? "running" : null,
    linkedRunVerdict: null,
    linkedTaskIds: result.executionMode === "task_graph" ? result.taskIds ?? [] : [],
    linkedTaskStatus: result.executionMode === "task_graph" ? "queued" : null,
    reviewStatus: "pending",
    currentCycleId: nextCycle.id,
    cycles: [...(preparedWorkItem.cycles ?? []), nextCycle],
    remediationPlan: preparedWorkItem.remediationPlan
      ? {
          ...preparedWorkItem.remediationPlan,
          status: "launched",
          launchedAt: now
        }
      : null,
    updatedAt: now,
    lastStartedAt: now
  };
  options.found.workItems[options.found.index] = updatedWorkItem;
  await saveWorkItemsForWorkspacePath(options.found.workspacePath, options.found.workItems);
  return {
    workItem: updatedWorkItem,
    runId: result.runId
  };
}

function shouldUseTaskGraphExecution(
  workItem: WorkItemRecord,
  detail: Awaited<ReturnType<typeof buildWorkItemPlanningDetail>>
): boolean {
  if (detail.tasks.length === 0) return false;
  if (workItem.brief.sourceType === "pbi") return true;
  return detail.teamAssignments.length > 0 && detail.teamAssignments.every((assignment) => assignment.coverage !== "missing");
}

async function findHydratedWorkItemById(options: {
  id: string;
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  workspaceId?: string;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  stateIndex: StateIndex;
  agentPlatform: WorkAgentPlatform;
}): Promise<{ workItem: WorkItemRecord } | null> {
  const found = await findRawWorkItemById(options);
  if (!found) return null;
  const runs = await options.stateIndex.queryRuns(found.workItem.workspaceId).catch(() => []);
  const runByKey = buildRunMap(runs);
  const taskByWorkItem = buildTaskMap(options.agentPlatform.listTasks({
    workspaceId: found.workItem.workspaceId,
    workItemId: found.workItem.id
  }));
  return {
    workItem: hydrateWorkItem(found.workItem, runByKey, taskByWorkItem)
  };
}

async function findRawWorkItemById(options: {
  id: string;
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  workspaceId?: string;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
}): Promise<RawWorkItemLookup | null> {
  const candidates = await resolveWorkspaceCandidates(
    options.rootDir,
    options.listWorkspacePaths,
    options.workspaceId,
    options.resolveWorkspacePath
  );
  for (const candidate of candidates) {
    const workItems = await loadWorkItemsForWorkspacePath(candidate.path);
    const index = workItems.findIndex((item) => item.id === options.id);
    if (index >= 0) {
      return {
        workItem: workItems[index]!,
        workItems,
        index,
        workspacePath: candidate.path
      };
    }
  }
  return null;
}

async function listRawWorkItems(options: {
  rootDir: string;
  listWorkspacePaths: () => Promise<string[]>;
  workspaceId?: string;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
}): Promise<WorkItemRecord[]> {
  const candidates = await resolveWorkspaceCandidates(
    options.rootDir,
    options.listWorkspacePaths,
    options.workspaceId,
    options.resolveWorkspacePath
  );
  const all: WorkItemRecord[] = [];
  for (const candidate of candidates) {
    const workItems = await loadWorkItemsForWorkspacePath(candidate.path);
    all.push(...workItems);
  }
  return all;
}

async function resolveWorkspaceCandidates(
  rootDir: string,
  listWorkspacePaths: () => Promise<string[]>,
  workspaceId: string | undefined,
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>
): Promise<Array<{ id: string; path: string }>> {
  if (workspaceId) {
    const workspacePath = await resolveWorkspacePath(workspaceId);
    return workspacePath ? [{ id: workspaceId, path: workspacePath }] : [];
  }
  const workspaces = await loadWorkspaces(rootDir, {
    repoPaths: await listWorkspacePaths().catch(() => [])
  }).catch(() => []);
  return workspaces.map((workspace) => ({ id: workspace.id, path: workspace.path }));
}

function getWorkItemsPath(workspacePath: string): string {
  return getWorkspaceWorkItemsPath(workspacePath);
}

async function loadWorkItemsForWorkspacePath(workspacePath: string): Promise<WorkItemRecord[]> {
  const raw = await readJsonIfExists<unknown[]>(getWorkItemsPath(workspacePath));
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => normalizeWorkItemRecord(entry));
}

async function saveWorkItemsForWorkspacePath(workspacePath: string, workItems: WorkItemRecord[]): Promise<void> {
  await writeJson(getWorkItemsPath(workspacePath), workItems);
}

function normalizeWorkItemRecord(value: unknown): WorkItemRecord {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const workspaceId = typeof raw.workspaceId === "string" ? raw.workspaceId : "";
  const briefRaw = raw.brief && typeof raw.brief === "object" ? (raw.brief as Record<string, unknown>) : {};
  const sourceType = normalizeSourceType(briefRaw.sourceType) ?? "feature";
  const recommendedTemplateId = typeof raw.recommendedTemplateId === "string" && raw.recommendedTemplateId.trim()
    ? raw.recommendedTemplateId.trim()
    : templateForSourceType(sourceType);
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : crypto.randomUUID(),
    workspaceId,
    brief: {
      workspaceId,
      sourceType,
      title: typeof briefRaw.title === "string" ? briefRaw.title : "Untitled work item",
      request: typeof briefRaw.request === "string" ? briefRaw.request : "",
      sourceRef: typeof briefRaw.sourceRef === "string" && briefRaw.sourceRef.trim() ? briefRaw.sourceRef : null,
      acceptanceCriteria: normalizeStringArray(briefRaw.acceptanceCriteria),
      constraints: normalizeStringArray(briefRaw.constraints)
    },
    status: normalizeWorkItemStatus(typeof raw.status === "string" ? raw.status : undefined),
    recommendedTemplateId,
    executionMode: normalizeExecutionMode(raw.executionMode),
    linkedRunId: typeof raw.linkedRunId === "string" && raw.linkedRunId.trim() ? raw.linkedRunId : null,
    linkedRunStatus: typeof raw.linkedRunStatus === "string" && raw.linkedRunStatus.trim() ? raw.linkedRunStatus : null,
    linkedRunVerdict: normalizeVerdict(raw.linkedRunVerdict),
    linkedTaskIds: normalizeStringArray(raw.linkedTaskIds),
    linkedTaskStatus: typeof raw.linkedTaskStatus === "string" && raw.linkedTaskStatus.trim() ? raw.linkedTaskStatus : null,
    reviewStatus: normalizeReviewStatus(raw.reviewStatus),
    reviewNote: typeof raw.reviewNote === "string" && raw.reviewNote.trim() ? raw.reviewNote.trim() : null,
    reviewedAt: typeof raw.reviewedAt === "string" && raw.reviewedAt.trim() ? raw.reviewedAt : null,
    currentCycleId: typeof raw.currentCycleId === "string" && raw.currentCycleId.trim() ? raw.currentCycleId : null,
    cycles: normalizeWorkItemCycles(raw.cycles),
    remediationPlan: normalizeRemediationPlan(raw.remediationPlan),
    optimization: normalizeOptimizationSummary(raw.optimization),
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : new Date(0).toISOString(),
    lastStartedAt: typeof raw.lastStartedAt === "string" && raw.lastStartedAt.trim() ? raw.lastStartedAt : null
  };
}

function hydrateWorkItem(
  workItem: WorkItemRecord,
  runByKey: Map<string, IndexedRunLike>,
  taskByWorkItem: Map<string, IndexedTaskLike[]>
): WorkItemRecord {
  const relatedTasks = selectCurrentWorkItemTasks(workItem, taskByWorkItem.get(workItem.id) ?? []);
  const run = workItem.linkedRunId
    ? runByKey.get(`${workItem.workspaceId}:${workItem.linkedRunId}`) ?? null
    : null;
  const linkedRunStatus = run?.status ?? workItem.linkedRunStatus ?? null;
  const linkedRunVerdict = run?.verdict ?? workItem.linkedRunVerdict ?? null;
  const linkedTaskIds = relatedTasks.length > 0
    ? relatedTasks.map((task) => task.id)
    : workItem.linkedTaskIds ?? [];
  const linkedTaskStatus = deriveLinkedTaskStatus(relatedTasks, workItem.linkedTaskStatus ?? null);
  const derivedStatus = deriveWorkItemStatus(workItem, linkedRunStatus, linkedTaskStatus, relatedTasks);
  return {
    ...workItem,
    status: derivedStatus,
    linkedRunStatus,
    linkedRunVerdict,
    linkedTaskIds,
    linkedTaskStatus,
    cycles: hydrateWorkItemCycles(workItem.cycles ?? [], workItem.currentCycleId ?? null, derivedStatus)
  };
}

function deriveWorkItemStatus(
  workItem: WorkItemRecord,
  linkedRunStatus: string | null,
  linkedTaskStatus: string | null,
  relatedTasks: IndexedTaskLike[]
): WorkItemStatus {
  if (workItem.reviewStatus === "approved") return "completed";
  if (workItem.reviewStatus === "changes_requested") return "blocked";
  if (workItem.status === "completed") return "completed";
  if ((workItem.executionMode === "task_graph" || relatedTasks.length > 0) && linkedTaskStatus) {
    const currentPlan = resolveStoredCyclePlan(workItem);
    const gateRuntime = currentPlan ? buildGateRuntime(currentPlan, relatedTasks) : [];
    if (linkedTaskStatus === "failed" || linkedTaskStatus === "cancelled" || linkedTaskStatus === "canceled") {
      return "failed";
    }
    if (linkedTaskStatus === "paused" || linkedTaskStatus === "blocked") {
      return "blocked";
    }
    if (linkedTaskStatus === "running" || linkedTaskStatus === "queued" || linkedTaskStatus === "active") {
      return "running";
    }
    if (linkedTaskStatus === "succeeded" || linkedTaskStatus === "completed") {
      const requiredGates = gateRuntime.filter((gate) => gate.required);
      if (requiredGates.length === 0 || requiredGates.every((gate) => gate.status === "passed" || gate.status === "skipped")) {
        return "ready_for_review";
      }
      if (requiredGates.some((gate) => gate.status === "failed")) {
        return "failed";
      }
      return "blocked";
    }
  }
  const normalized = (linkedRunStatus ?? "").trim().toLowerCase();
  switch (normalized) {
    case "running":
    case "queued":
    case "active":
      return "running";
    case "paused":
    case "blocked":
    case "interrupted":
      return "blocked";
    case "completed":
    case "finished":
    case "succeeded":
      return "ready_for_review";
    case "failed":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return normalizeWorkItemStatus(workItem.status);
  }
}

function deriveLinkedTaskStatus(tasks: IndexedTaskLike[], fallback: string | null): string | null {
  if (tasks.length === 0) return fallback;
  const statuses = tasks.map((task) => task.status.trim().toLowerCase());
  const hasFailed = statuses.some((status) => status === "failed" || status === "cancelled" || status === "canceled");
  const hasBlocked = statuses.some((status) => status === "blocked" || status === "paused");
  const hasRunning = statuses.some((status) => status === "running" || status === "active");
  const hasQueued = statuses.some((status) => status === "queued");
  const hasSucceeded = statuses.some((status) => status === "succeeded" || status === "completed");
  if (statuses.every((status) => status === "succeeded" || status === "completed")) return "succeeded";
  if (hasBlocked) return "blocked";
  if (hasFailed && (hasRunning || hasQueued || hasSucceeded)) return "blocked";
  if (hasFailed) return "failed";
  if (hasRunning) return "running";
  if (hasQueued) return "queued";
  return fallback;
}

function buildRunMap(runs: Array<{ workspaceId: string; runId: string; status: string; verdict: string | null }>): Map<string, IndexedRunLike> {
  const map = new Map<string, IndexedRunLike>();
  for (const run of runs) {
    map.set(`${run.workspaceId}:${run.runId}`, {
      workspaceId: run.workspaceId,
      runId: run.runId,
      status: run.status,
      verdict: normalizeVerdict(run.verdict)
    });
  }
  return map;
}

function buildTaskMap(tasks: IndexedTaskLike[]): Map<string, IndexedTaskLike[]> {
  const map = new Map<string, IndexedTaskLike[]>();
  for (const task of tasks) {
    if (!task.linkedWorkItemId) continue;
    const bucket = map.get(task.linkedWorkItemId) ?? [];
    bucket.push(task);
    map.set(task.linkedWorkItemId, bucket);
  }
  return map;
}

function selectCurrentWorkItemTasks(workItem: WorkItemRecord, tasks: IndexedTaskLike[]): IndexedTaskLike[] {
  if ((workItem.linkedTaskIds?.length ?? 0) === 0) return tasks;
  const activeTaskIds = new Set(workItem.linkedTaskIds);
  return tasks.filter((task) => activeTaskIds.has(task.id));
}

function templateForSourceType(sourceType: WorkItemSourceType): string {
  return SOURCE_TEMPLATE_MAP[sourceType];
}

function normalizeSourceType(value: unknown): WorkItemSourceType | null {
  switch (typeof value === "string" ? value.trim().toLowerCase() : "") {
    case "feature":
      return "feature";
    case "pbi":
      return "pbi";
    case "bug":
      return "bug";
    case "pr_hardening":
    case "pr-hardening":
    case "pr":
      return "pr_hardening";
    default:
      return null;
  }
}

function normalizeSprintSourceRef(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function deriveSprintPbiState(options: {
  workItem: WorkItemRecord | null;
  blockedBy: string[];
}): WorkSprintControlPbiState {
  if (!options.workItem) {
    return options.blockedBy.length > 0 ? "blocked" : "unimported";
  }
  if (options.workItem.status === "completed") return "completed";
  if (options.workItem.status === "ready_for_review") return "review";
  if (options.workItem.status === "running") return "running";
  if (options.workItem.status === "draft") {
    return options.blockedBy.length > 0 ? "blocked" : "ready";
  }
  if (options.workItem.status === "blocked" || options.workItem.status === "failed") return "blocked";
  return options.blockedBy.length > 0 ? "blocked" : "ready";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function normalizeExecutionMode(value: unknown): WorkItemExecutionMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "mission" || normalized === "task_graph") {
    return normalized;
  }
  return null;
}

function normalizeReviewStatus(value: unknown): WorkItemRecord["reviewStatus"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "pending" || normalized === "approved" || normalized === "changes_requested") {
    return normalized;
  }
  return "pending";
}

function normalizeWorkItemCycles(value: unknown): WorkItemCycleRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeWorkItemCycle(entry))
    .filter((entry): entry is WorkItemCycleRecord => entry !== null);
}

function normalizeWorkItemCycle(value: unknown): WorkItemCycleRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kind = typeof raw.kind === "string" && (raw.kind === "initial" || raw.kind === "remediation")
    ? raw.kind
    : "initial";
  const statusRaw = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  const status =
    statusRaw === "running" ||
    statusRaw === "blocked" ||
    statusRaw === "review_ready" ||
    statusRaw === "changes_requested" ||
    statusRaw === "approved" ||
    statusRaw === "failed"
      ? statusRaw
      : "running";
  const trigger = typeof raw.trigger === "string" && raw.trigger === "review_send_back" ? "review_send_back" : "launch";
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : crypto.randomUUID(),
    sequence: typeof raw.sequence === "number" && raw.sequence > 0 ? Math.floor(raw.sequence) : 1,
    kind,
    status,
    trigger,
    executionMode: normalizeExecutionMode(raw.executionMode),
    linkedRunId: typeof raw.linkedRunId === "string" && raw.linkedRunId.trim() ? raw.linkedRunId : null,
    linkedTaskIds: normalizeStringArray(raw.linkedTaskIds),
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : null,
    operatorNote: typeof raw.operatorNote === "string" && raw.operatorNote.trim() ? raw.operatorNote.trim() : null,
    plan: normalizeCyclePlan(raw.plan),
    startedAt: typeof raw.startedAt === "string" && raw.startedAt.trim() ? raw.startedAt : new Date(0).toISOString(),
    endedAt: typeof raw.endedAt === "string" && raw.endedAt.trim() ? raw.endedAt : null
  };
}

function normalizeRemediationPlan(value: unknown): WorkItemRemediationPlan | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const statusRaw = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  const status = statusRaw === "launched" || statusRaw === "resolved" ? statusRaw : "suggested";
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks
        .map((task) => normalizePlanningTask(task))
        .filter((task): task is NonNullable<ReturnType<typeof normalizePlanningTask>> => task !== null)
    : [];
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `remediation-${Date.now()}`,
    status,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt : new Date(0).toISOString(),
    launchedAt: typeof raw.launchedAt === "string" && raw.launchedAt.trim() ? raw.launchedAt : null,
    resolvedAt: typeof raw.resolvedAt === "string" && raw.resolvedAt.trim() ? raw.resolvedAt : null,
    sourceCycleId: typeof raw.sourceCycleId === "string" && raw.sourceCycleId.trim() ? raw.sourceCycleId : null,
    note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "Remediation plan",
    rationale: normalizeStringArray(raw.rationale),
    laneIds: normalizeStringArray(raw.laneIds),
    acceptanceDelta: normalizeStringArray(raw.acceptanceDelta),
    constraintDelta: normalizeStringArray(raw.constraintDelta),
    taskIds: normalizeStringArray(raw.taskIds),
    tasks,
    executionSteps: normalizeExecutionSteps(raw.executionSteps),
    cyclePlan: normalizeCyclePlan(raw.cyclePlan) ?? {
      summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "Remediation plan",
      headline: "Remediation cycle",
      source: "remediation",
      sourceCycleId: typeof raw.sourceCycleId === "string" && raw.sourceCycleId.trim() ? raw.sourceCycleId : null,
      sourceRemediationPlanId: typeof raw.id === "string" && raw.id.trim() ? raw.id : null,
    acceptanceCriteria: normalizeStringArray(raw.acceptanceDelta),
    constraints: normalizeStringArray(raw.constraintDelta),
    lanes: derivePlanLanesFromTasks(tasks),
    tasks,
    workstreams: [],
    gates: [],
    teamAssignments: [],
    executionSteps: normalizeExecutionSteps(raw.executionSteps)
  }
  };
}

function normalizeCyclePlan(value: unknown): WorkItemCyclePlan | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sourceRaw = typeof raw.source === "string" ? raw.source.trim().toLowerCase() : "";
  const source = sourceRaw === "remediation" ? "remediation" : "baseline";
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks
        .map((task) => normalizePlanningTask(task))
        .filter((task): task is NonNullable<ReturnType<typeof normalizePlanningTask>> => task !== null)
    : [];
  return {
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "Cycle plan",
    headline: typeof raw.headline === "string" && raw.headline.trim() ? raw.headline.trim() : null,
    source,
    sourceCycleId: typeof raw.sourceCycleId === "string" && raw.sourceCycleId.trim() ? raw.sourceCycleId : null,
    sourceRemediationPlanId:
      typeof raw.sourceRemediationPlanId === "string" && raw.sourceRemediationPlanId.trim()
        ? raw.sourceRemediationPlanId
        : null,
    acceptanceCriteria: normalizeStringArray(raw.acceptanceCriteria),
    constraints: normalizeStringArray(raw.constraints),
    lanes: normalizePlanningLanes(raw.lanes, tasks),
    tasks,
    workstreams: normalizeWorkstreams(raw.workstreams),
    gates: normalizeGates(raw.gates),
    teamAssignments: normalizeLaneAssignments(raw.teamAssignments),
    executionSteps: normalizeExecutionSteps(raw.executionSteps)
  };
}

function normalizePlanningTask(value: unknown): WorkPlanTask | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kindRaw = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  const kind =
    kindRaw === "planning" ||
    kindRaw === "implementation" ||
    kindRaw === "validation" ||
    kindRaw === "qa" ||
    kindRaw === "review"
      ? kindRaw
      : "implementation";
  const source = typeof raw.source === "string" && raw.source === "pbi" ? "pbi" : "template";
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  const laneId = typeof raw.laneId === "string" && raw.laneId.trim() ? raw.laneId.trim() : "";
  const laneLabel = typeof raw.laneLabel === "string" && raw.laneLabel.trim() ? raw.laneLabel.trim() : laneId;
  if (!id || !laneId || !laneLabel) return null;
  return {
    id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : null,
    laneId,
    laneLabel,
    roleHint: typeof raw.roleHint === "string" && raw.roleHint.trim() ? raw.roleHint.trim() : null,
    kind,
    source,
    dependsOn: normalizeStringArray(raw.dependsOn),
    sourceLine: typeof raw.sourceLine === "number" ? raw.sourceLine : null,
    workstreamId: typeof raw.workstreamId === "string" && raw.workstreamId.trim() ? raw.workstreamId.trim() : null,
    workstreamType: normalizeWorkstreamType(raw.workstreamType),
    gateIds: normalizeStringArray(raw.gateIds),
    qaMode:
      typeof raw.qaMode === "string" && (raw.qaMode === "smoke" || raw.qaMode === "scenario")
        ? raw.qaMode
        : null
  };
}

function normalizeWorkstreamType(value: unknown): WorkItemWorkstream["type"] | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (normalized) {
    case "plan":
    case "implement":
    case "integrate":
    case "validate":
    case "qa_smoke":
    case "qa_scenario":
    case "audit":
      return normalized;
    default:
      return null;
  }
}

function normalizeGateType(value: unknown): WorkItemGate["type"] | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (normalized) {
    case "validation":
    case "qa_scenario":
    case "audit":
    case "delivery":
      return normalized;
    default:
      return null;
  }
}

function normalizeOptimizationSummary(value: unknown): WorkItemOptimizationSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.cycles)) return { cycles: [] };
  const cycles = raw.cycles
    .map((entry) => normalizeOptimizationCycle(entry))
    .filter((entry): entry is WorkItemOptimizationCycle => entry !== null);
  return { cycles };
}

function normalizeOptimizationCycle(value: unknown): WorkItemOptimizationCycle | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sourceStatus =
    raw.sourceStatus === "approved" || raw.sourceStatus === "changes_requested" || raw.sourceStatus === "failed"
      ? raw.sourceStatus
      : "approved";
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID(),
    cycleId: typeof raw.cycleId === "string" && raw.cycleId.trim() ? raw.cycleId.trim() : "",
    sequence: typeof raw.sequence === "number" && raw.sequence > 0 ? Math.floor(raw.sequence) : 1,
    sourceStatus,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt : new Date(0).toISOString(),
    promptSuggestions: Array.isArray(raw.promptSuggestions)
      ? raw.promptSuggestions
          .map((entry) => normalizeOptimizationPromptSuggestion(entry))
          .filter((entry): entry is WorkItemOptimizationPromptSuggestion => entry !== null)
      : [],
    strategyRecommendation: normalizeOptimizationStrategyRecommendation(raw.strategyRecommendation),
    opportunities: Array.isArray(raw.opportunities)
      ? raw.opportunities
          .map((entry) => normalizeOptimizationOpportunity(entry))
          .filter((entry): entry is WorkItemOptimizationOpportunity => entry !== null)
      : []
  };
}

function normalizeOptimizationPromptSuggestion(value: unknown): WorkItemOptimizationPromptSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const promptPath = typeof raw.promptPath === "string" && raw.promptPath.trim() ? raw.promptPath.trim() : "";
  if (!promptPath) return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID(),
    promptPath,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : path.basename(promptPath),
    status: normalizeOptimizationStatus(raw.status),
    createdAt: typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt : new Date(0).toISOString(),
    score: typeof raw.score === "number" ? raw.score : 0,
    rationale: normalizeStringArray(raw.rationale),
    suggestionId:
      typeof raw.suggestionId === "string" && raw.suggestionId.trim()
        ? raw.suggestionId.trim()
        : null
  };
}

function normalizeOptimizationStrategyRecommendation(value: unknown): WorkItemOptimizationStrategyRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const mode = typeof raw.mode === "string" && raw.mode.trim() ? raw.mode.trim() : "";
  if (!mode) return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID(),
    mode,
    status: normalizeOptimizationStatus(raw.status),
    createdAt: typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt : new Date(0).toISOString(),
    rationale: normalizeStringArray(raw.rationale)
  };
}

function normalizeOptimizationOpportunity(value: unknown): WorkItemOptimizationOpportunity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "";
  const description = typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : "";
  if (!title || !description) return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID(),
    title,
    description,
    status: normalizeOptimizationStatus(raw.status),
    createdAt: typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt : new Date(0).toISOString(),
    rationale: normalizeStringArray(raw.rationale),
    riskScore: typeof raw.riskScore === "number" ? raw.riskScore : 0,
    convertedWorkItemId:
      typeof raw.convertedWorkItemId === "string" && raw.convertedWorkItemId.trim()
        ? raw.convertedWorkItemId.trim()
        : null
  };
}

function normalizeOptimizationStatus(value: unknown): "pending" | "approved" | "rejected" | "converted" {
  switch (typeof value === "string" ? value.trim().toLowerCase() : "") {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "converted":
      return "converted";
    default:
      return "pending";
  }
}

function normalizeWorkstreams(value: unknown): Array<{
  id: string;
  type: NonNullable<WorkItemCyclePlan["workstreams"]>[number]["type"];
  title: string;
  description?: string | null;
  laneId: string;
  laneLabel: string;
  taskIds: string[];
  dependsOn: string[];
  gateIds: string[];
  preferredAgentId?: string | null;
  preferredAgentName?: string | null;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
      const laneId = typeof raw.laneId === "string" && raw.laneId.trim() ? raw.laneId.trim() : "";
      const laneLabel = typeof raw.laneLabel === "string" && raw.laneLabel.trim() ? raw.laneLabel.trim() : laneId;
      const type = normalizeWorkstreamType(raw.type);
      if (!id || !laneId || !laneLabel || !type) return null;
      return {
        id,
        type,
        title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
        description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : null,
        laneId,
        laneLabel,
        taskIds: normalizeStringArray(raw.taskIds),
        dependsOn: normalizeStringArray(raw.dependsOn),
        gateIds: normalizeStringArray(raw.gateIds),
        preferredAgentId:
          typeof raw.preferredAgentId === "string" && raw.preferredAgentId.trim()
            ? raw.preferredAgentId.trim()
            : null,
        preferredAgentName:
          typeof raw.preferredAgentName === "string" && raw.preferredAgentName.trim()
            ? raw.preferredAgentName.trim()
            : null
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function normalizeGates(value: unknown): Array<{
  id: string;
  type: NonNullable<WorkItemCyclePlan["gates"]>[number]["type"];
  label: string;
  required: boolean;
  workstreamIds: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
      const type = normalizeGateType(raw.type);
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "";
      if (!id || !type || !label) return null;
      return {
        id,
        type,
        label,
        required: raw.required !== false,
        workstreamIds: normalizeStringArray(raw.workstreamIds)
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function normalizePlanningLanes(value: unknown, tasks: WorkPlanTask[]): Array<{ id: string; label: string; description?: string }> {
  if (!Array.isArray(value)) return derivePlanLanesFromTasks(tasks);
  const lanes = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;
      if (!id || !label) return null;
      return {
        id,
        label,
        description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined
      };
    })
    .filter((lane): lane is NonNullable<typeof lane> => lane !== null);
  return lanes.length > 0 ? lanes : derivePlanLanesFromTasks(tasks);
}

function derivePlanLanesFromTasks(tasks: WorkPlanTask[]): Array<{ id: string; label: string; description?: string }> {
  const seen = new Set<string>();
  const lanes: Array<{ id: string; label: string; description?: string }> = [];
  for (const task of tasks) {
    if (seen.has(task.laneId)) continue;
    seen.add(task.laneId);
    lanes.push({
      id: task.laneId,
      label: task.laneLabel || task.laneId
    });
  }
  return lanes;
}

function normalizeLaneAssignments(value: unknown): Array<{
  laneId: string;
  laneLabel: string;
  preferredRole: string;
  preferredSpecializations: string[];
  coverage: "strong" | "fallback" | "missing";
  note?: string | null;
  matches: Array<{
    id: string;
    name: string;
    role: string;
    specialization: string;
    seniority: string;
    maxParallelWork: number;
    state: string;
    score: number;
  }>;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const laneId = typeof raw.laneId === "string" && raw.laneId.trim() ? raw.laneId.trim() : "";
      const laneLabel = typeof raw.laneLabel === "string" && raw.laneLabel.trim() ? raw.laneLabel.trim() : laneId;
      if (!laneId || !laneLabel) return null;
      const coverageRaw = typeof raw.coverage === "string" ? raw.coverage.trim().toLowerCase() : "";
      const coverage: "strong" | "fallback" | "missing" =
        coverageRaw === "strong" || coverageRaw === "fallback" ? coverageRaw : "missing";
      const matches = Array.isArray(raw.matches)
        ? raw.matches
            .map((match) => {
              if (!match || typeof match !== "object") return null;
              const record = match as Record<string, unknown>;
              const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
              const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "";
              if (!id || !name) return null;
              return {
                id,
                name,
                role: typeof record.role === "string" && record.role.trim() ? record.role.trim() : "dev",
                specialization:
                  typeof record.specialization === "string" && record.specialization.trim()
                    ? record.specialization.trim()
                    : "fullstack",
                seniority:
                  typeof record.seniority === "string" && record.seniority.trim()
                    ? record.seniority.trim()
                    : "mid",
                maxParallelWork:
                  typeof record.maxParallelWork === "number" && record.maxParallelWork > 0
                    ? Math.floor(record.maxParallelWork)
                    : 1,
                state: typeof record.state === "string" && record.state.trim() ? record.state.trim() : "idle",
                score: typeof record.score === "number" ? record.score : 0
              };
            })
            .filter((match): match is NonNullable<typeof match> => match !== null)
        : [];
      return {
        laneId,
        laneLabel,
        preferredRole: typeof raw.preferredRole === "string" && raw.preferredRole.trim() ? raw.preferredRole.trim() : "dev",
        preferredSpecializations: normalizeStringArray(raw.preferredSpecializations),
        coverage,
        note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null,
        matches
      };
    })
    .filter((assignment): assignment is NonNullable<typeof assignment> => assignment !== null);
}

function normalizeExecutionSteps(value: unknown): Array<{
  id: string;
  title: string;
  role: string;
  executor: string;
  phase?: string | null;
  dependsOn: string[];
  acceptanceCriteria: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
      const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "";
      if (!id || !title) return null;
      return {
        id,
        title,
        role: typeof raw.role === "string" && raw.role.trim() ? raw.role.trim() : "dev",
        executor: typeof raw.executor === "string" && raw.executor.trim() ? raw.executor.trim() : "implement",
        phase: typeof raw.phase === "string" && raw.phase.trim() ? raw.phase.trim() : null,
        dependsOn: normalizeStringArray(raw.dependsOn),
        acceptanceCriteria: normalizeStringArray(raw.acceptanceCriteria)
      };
    })
    .filter((step): step is NonNullable<typeof step> => step !== null);
}

function normalizeReviewAction(value: unknown): WorkItemReviewAction | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "approve") return "approve";
  if (normalized === "send_back" || normalized === "send-back" || normalized === "changes_requested") return "send_back";
  return null;
}

function normalizeSprintControlAction(value: unknown): WorkSprintControlAction | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "launch_next_ready" || normalized === "launch-next-ready") return "launch_next_ready";
  if (normalized === "fill_wip" || normalized === "fill-wip") return "fill_wip";
  return null;
}

function normalizeOrganizationControlAction(value: unknown): WorkOrganizationControlAction | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "launch_next_ready" || normalized === "launch-next-ready") return "launch_next_ready";
  if (normalized === "fill_wip" || normalized === "fill-wip") return "fill_wip";
  return null;
}

function isActiveExecutionStatus(value: string | null | undefined): boolean {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "queued" || normalized === "running" || normalized === "active" || normalized === "paused";
}

function normalizeVerdict(value: unknown): RunVerdict | null {
  switch (typeof value === "string" ? value.trim().toLowerCase() : "") {
    case "running":
      return "running";
    case "needs_human_review":
      return "needs_human_review";
    case "ready_for_review":
      return "ready_for_review";
    case "ready_to_merge":
      return "ready_to_merge";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function createWorkItemCycle(options: {
  workItem: WorkItemRecord;
  startedAt: string;
  executionMode: WorkItemExecutionMode;
  linkedRunId?: string | null;
  linkedTaskIds?: string[];
  summary?: string | null;
  plan?: WorkItemCyclePlan | null;
}): WorkItemCycleRecord {
  const previousCycles = options.workItem.cycles ?? [];
  return {
    id: crypto.randomUUID(),
    sequence: previousCycles.length + 1,
    kind: options.workItem.reviewStatus === "changes_requested" ? "remediation" : "initial",
    status: "running",
    trigger: options.workItem.reviewStatus === "changes_requested" ? "review_send_back" : "launch",
    executionMode: options.executionMode,
    linkedRunId: options.linkedRunId ?? null,
    linkedTaskIds: options.linkedTaskIds ?? [],
    summary: options.summary ?? null,
    operatorNote: options.workItem.reviewStatus === "changes_requested" ? options.workItem.reviewNote ?? null : null,
    plan: options.plan ?? null,
    startedAt: options.startedAt,
    endedAt: null
  };
}

function createDerivedOpportunityWorkItem(options: {
  sourceWorkItem: WorkItemRecord;
  opportunity: WorkItemOptimizationOpportunity;
  now: string;
}): WorkItemRecord {
  return {
    id: crypto.randomUUID(),
    workspaceId: options.sourceWorkItem.workspaceId,
    brief: {
      workspaceId: options.sourceWorkItem.workspaceId,
      sourceType: "feature",
      title: options.opportunity.title,
      request: [
        options.opportunity.description.trim(),
        "",
        `Derived from work item ${options.sourceWorkItem.id} (${options.sourceWorkItem.brief.title}).`
      ].join("\n"),
      sourceRef: `opportunity:${options.sourceWorkItem.id}:${options.opportunity.id}`,
      acceptanceCriteria: [],
      constraints: []
    },
    status: "draft",
    recommendedTemplateId: "feature-dev",
    executionMode: null,
    linkedRunId: null,
    linkedRunStatus: null,
    linkedRunVerdict: null,
    linkedTaskIds: [],
    linkedTaskStatus: null,
    reviewStatus: "pending",
    reviewNote: null,
    reviewedAt: null,
    currentCycleId: null,
    cycles: [],
    remediationPlan: null,
    optimization: null,
    createdAt: options.now,
    updatedAt: options.now,
    lastStartedAt: null
  };
}

function closeCurrentCycle(workItem: WorkItemRecord, currentStatus: WorkItemStatus, at: string): WorkItemRecord {
  if (!workItem.currentCycleId || !Array.isArray(workItem.cycles) || workItem.cycles.length === 0) {
    return workItem;
  }
  const cycles = workItem.cycles.map((cycle) => {
    if (cycle.id !== workItem.currentCycleId || cycle.endedAt) return cycle;
    return {
      ...cycle,
      status: deriveCycleStatusFromWorkItemStatus(currentStatus, cycle.status),
      endedAt: at
    };
  });
  return {
    ...workItem,
    cycles
  };
}

function applyCycleReviewDecision(
  workItem: WorkItemRecord,
  options: {
    decision: WorkItemReviewAction;
    at: string;
    note: string | null;
  }
): WorkItemRecord {
  if (!workItem.currentCycleId || !Array.isArray(workItem.cycles) || workItem.cycles.length === 0) {
    return workItem;
  }
  const nextStatus: WorkItemCycleRecord["status"] = options.decision === "approve" ? "approved" : "changes_requested";
  const cycles = workItem.cycles.map((cycle) => {
    if (cycle.id !== workItem.currentCycleId) return cycle;
    return {
      ...cycle,
      status: nextStatus,
      operatorNote: options.note,
      endedAt: options.at
    };
  });
  return {
    ...workItem,
    cycles
  };
}

function hydrateWorkItemCycles(
  cycles: WorkItemCycleRecord[],
  currentCycleId: string | null,
  currentStatus: WorkItemStatus
): WorkItemCycleRecord[] {
  return cycles.map((cycle) => {
    if (cycle.id !== currentCycleId || cycle.endedAt) return cycle;
    return {
      ...cycle,
      status: deriveCycleStatusFromWorkItemStatus(currentStatus, cycle.status)
    };
  });
}

function deriveCycleStatusFromWorkItemStatus(
  workItemStatus: WorkItemStatus,
  fallback: WorkItemCycleRecord["status"]
): WorkItemCycleRecord["status"] {
  if (workItemStatus === "running") return "running";
  if (workItemStatus === "blocked") return "blocked";
  if (workItemStatus === "ready_for_review") return "review_ready";
  if (workItemStatus === "completed") return "approved";
  if (workItemStatus === "failed") return "failed";
  return fallback;
}

function resolveCurrentCyclePlan(
  workItem: WorkItemRecord,
  detail: Awaited<ReturnType<typeof buildWorkItemPlanningDetail>>
): WorkItemCyclePlan | null {
  const activeCycle = (workItem.cycles ?? []).find((cycle) => cycle.id === workItem.currentCycleId);
  if (activeCycle?.plan) {
    return activeCycle.plan;
  }
  if (workItem.reviewStatus === "changes_requested" && workItem.remediationPlan?.cyclePlan) {
    return workItem.remediationPlan.cyclePlan;
  }
  return createWorkItemCyclePlan({
    detail,
    source: "baseline",
    headline:
      workItem.currentCycleId && (workItem.cycles?.length ?? 0) > 0
        ? `Cycle ${(workItem.cycles ?? []).find((cycle) => cycle.id === workItem.currentCycleId)?.sequence ?? 1} execution`
        : "Initial plan"
  });
}

function resolveStoredCyclePlan(workItem: WorkItemRecord): WorkItemCyclePlan | null {
  const activeCycle = (workItem.cycles ?? []).find((cycle) => cycle.id === workItem.currentCycleId);
  if (activeCycle?.plan) return activeCycle.plan;
  if (workItem.reviewStatus === "changes_requested" && workItem.remediationPlan?.cyclePlan) {
    return workItem.remediationPlan.cyclePlan;
  }
  return null;
}

function buildWorkstreamRuntime(
  plan: WorkItemCyclePlan | null,
  relatedTasks: IndexedTaskLike[]
): Array<{
  workstream: WorkItemWorkstream;
  status: WorkItemWorkstreamStatus;
  tasks: IndexedTaskLike[];
}> {
  if (!plan) return [];
  const taskIdsByWorkstream = new Map<string, string[]>(plan.workstreams.map((stream) => [stream.id, stream.taskIds]));
  const runtimeByWorkstream = new Map<string, IndexedTaskLike[]>();
  const plannerTaskById = new Map(plan.tasks.map((task) => [task.id, task]));
  for (const task of relatedTasks) {
    const runtimeWorkstreamId =
      task.workstreamId ??
      (task.plannerTaskId ? plannerTaskById.get(task.plannerTaskId)?.workstreamId ?? null : null);
    if (!runtimeWorkstreamId) continue;
    const bucket = runtimeByWorkstream.get(runtimeWorkstreamId) ?? [];
    bucket.push(task);
    runtimeByWorkstream.set(runtimeWorkstreamId, bucket);
  }

  return plan.workstreams.map((workstream) => {
    const tasks = runtimeByWorkstream.get(workstream.id) ?? [];
    let status: WorkItemWorkstreamStatus = "planned";
    if (tasks.some((task) => {
      const normalized = task.status.trim().toLowerCase();
      return normalized === "failed" || normalized === "cancelled" || normalized === "canceled";
    })) {
      status = "failed";
    } else if (tasks.some((task) => {
      const normalized = task.status.trim().toLowerCase();
      return normalized === "blocked" || normalized === "paused";
    })) {
      status = "blocked";
    } else if (tasks.some((task) => {
      const normalized = task.status.trim().toLowerCase();
      return normalized === "running" || normalized === "active";
    })) {
      status = "running";
    } else if (tasks.some((task) => task.status.trim().toLowerCase() === "queued")) {
      status = "queued";
    } else if (
      tasks.length > 0 &&
      tasks.every((task) => {
        const normalized = task.status.trim().toLowerCase();
        return normalized === "succeeded" || normalized === "completed";
      })
    ) {
      status = "succeeded";
    } else if ((taskIdsByWorkstream.get(workstream.id) ?? []).length > 0) {
      status = "planned";
    }
    return {
      workstream,
      status,
      tasks
    };
  });
}

function buildGateRuntime(plan: WorkItemCyclePlan | null, relatedTasks: IndexedTaskLike[]): WorkItemGateRuntime[] {
  if (!plan) return [];
  const workstreamRuntime = buildWorkstreamRuntime(plan, relatedTasks);
  const runtimeByWorkstream = new Map(workstreamRuntime.map((entry) => [entry.workstream.id, entry]));
  return plan.gates.map((gate) => {
    const streams = gate.workstreamIds
      .map((id) => runtimeByWorkstream.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    const gateTasks = streams.flatMap((entry) => entry.tasks);
    let status: WorkItemGateRuntime["status"] = "pending";
    if (streams.length === 0 || gateTasks.length === 0) {
      status = "pending";
    } else if (streams.some((entry) => entry.status === "failed")) {
      status = "failed";
    } else if (streams.some((entry) => entry.status === "blocked")) {
      status = "blocked";
    } else if (streams.every((entry) => entry.status === "succeeded")) {
      status = "passed";
    }
    return {
      ...gate,
      status,
      summary:
        status === "passed"
          ? `${gate.label} passed.`
          : status === "failed"
            ? `${gate.label} failed.`
          : status === "blocked"
              ? `${gate.label} is blocked by upstream execution.`
              : `${gate.label} is still pending evidence.`
    };
  });
}

function buildWorkItemTeamRuntime(options: {
  workItem: WorkItemRecord;
  detail: Awaited<ReturnType<typeof buildWorkItemPlanningDetail>>;
  currentPlan: WorkItemCyclePlan | null;
  relatedTasks: IndexedTaskLike[];
}): WorkItemTeamRuntime | null {
  const plan = options.currentPlan ?? resolveStoredCyclePlan(options.workItem);
  if (!plan) return null;
  const assignmentsByLane = new Map(options.detail.teamAssignments.map((assignment) => [assignment.laneId, assignment]));
  const workstreamRuntime = buildWorkstreamRuntime(plan, options.relatedTasks);
  if (workstreamRuntime.length === 0) return null;

  const lanes = Array.from(new Set(plan.workstreams.map((stream) => stream.laneId))).map((laneId) => {
    const workstreams = workstreamRuntime.filter((entry) => entry.workstream.laneId === laneId);
    const assignment = assignmentsByLane.get(laneId);
    const active = workstreams.find((entry) => entry.status === "running")
      ?? workstreams.find((entry) => entry.status === "blocked")
      ?? workstreams.find((entry) => entry.status === "queued")
      ?? workstreams.find((entry) => entry.status === "planned")
      ?? workstreams[0]
      ?? null;
    const status: WorkItemTeamRuntime["lanes"][number]["status"] =
      assignment?.coverage === "missing"
        ? "missing"
        : workstreams.some((entry) => entry.status === "blocked" || entry.status === "failed")
          ? "blocked"
          : workstreams.some((entry) => entry.status === "running")
            ? "running"
            : workstreams.every((entry) => entry.status === "succeeded")
              ? "succeeded"
              : workstreams.some((entry) => entry.status === "queued")
                ? "queued"
                : "planned";
    const preferredMatch = assignment?.matches[0] ?? null;
    return {
      laneId,
      laneLabel: active?.workstream.laneLabel ?? assignment?.laneLabel ?? laneId,
      workstreamIds: workstreams.map((entry) => entry.workstream.id),
      activeWorkstreamId: active?.workstream.id ?? null,
      status,
      ownerAgentId: active?.workstream.preferredAgentId ?? preferredMatch?.id ?? null,
      ownerAgentName: active?.workstream.preferredAgentName ?? preferredMatch?.name ?? null,
      summary:
        status === "running"
          ? `${active?.workstream.title ?? "Workstream"} is executing now.`
          : status === "blocked"
            ? `${active?.workstream.title ?? "Workstream"} is blocked.`
            : status === "succeeded"
              ? `${active?.workstream.title ?? "Lane"} completed its current workstreams.`
              : status === "queued"
                ? `${active?.workstream.title ?? "Workstream"} is queued behind upstream dependencies.`
                : assignment?.note ?? "Lane is planned but not active yet."
    };
  });

  const blockedLanes = lanes.filter((lane) => lane.status === "blocked").length;
  const completedLanes = lanes.filter((lane) => lane.status === "succeeded").length;
  const missingCoverage = lanes.filter((lane) => lane.status === "missing").length;
  const activeAgents = new Set(lanes.map((lane) => lane.ownerAgentId).filter(Boolean)).size;
  const runningLane = lanes.find((lane) => lane.status === "running");
  const blockedLane = lanes.find((lane) => lane.status === "blocked");
  const queuedLane = lanes.find((lane) => lane.status === "queued");
  const nextLane = lanes.find((lane) => lane.status === "planned" || lane.status === "queued");

  return {
    headline:
      options.workItem.reviewStatus === "approved"
        ? "Team runtime completed this cycle."
        : blockedLane
          ? `${blockedLane.laneLabel} is blocked.`
          : runningLane
            ? `${runningLane.laneLabel} currently owns the live handoff.`
            : options.workItem.status === "ready_for_review"
              ? "Execution finished and is waiting for operator review."
              : "Team runtime is staged for the next supervised cycle.",
    currentStage:
      blockedLane
        ? blockedLane.summary
        : runningLane
          ? runningLane.summary
          : queuedLane
            ? queuedLane.summary
            : options.workItem.status === "ready_for_review"
              ? "All required execution lanes have passed their current gate."
              : "The planner has prepared workstreams and gates for launch.",
    nextHandoff:
      options.workItem.reviewStatus === "approved"
        ? null
        : blockedLane
          ? blockedLane.laneLabel
          : nextLane?.laneLabel ?? (options.workItem.status === "ready_for_review" ? "Operator review" : null),
    activeAgents,
    blockedLanes,
    completedLanes,
    missingCoverage,
    lanes
  };
}

function buildWorkItemReviewSummary(options: {
  workItem: WorkItemRecord;
  detail: Awaited<ReturnType<typeof buildWorkItemPlanningDetail>>;
  relatedTasks: IndexedTaskLike[];
  runByKey: Map<string, IndexedRunLike>;
}): WorkItemReviewSummary {
  const currentPlan = resolveCurrentCyclePlan(options.workItem, options.detail);
  const gateRuntime = buildGateRuntime(currentPlan, options.relatedTasks);
  const runtimeByGateType = new Map(gateRuntime.map((gate) => [gate.type, gate]));
  const totals = {
    total: options.relatedTasks.length,
    queued: 0,
    running: 0,
    blocked: 0,
    failed: 0,
    succeeded: 0
  };
  for (const task of options.relatedTasks) {
    const status = task.status.trim().toLowerCase();
    if (status === "queued") totals.queued += 1;
    else if (status === "running" || status === "active") totals.running += 1;
    else if (status === "blocked" || status === "paused") totals.blocked += 1;
    else if (status === "failed" || status === "cancelled" || status === "canceled") totals.failed += 1;
    else if (status === "succeeded" || status === "completed") totals.succeeded += 1;
  }

  const signals: WorkItemReviewSummary["signals"] = [];
  if (options.workItem.executionMode === "mission") {
    const run = options.workItem.linkedRunId
      ? options.runByKey.get(`${options.workItem.workspaceId}:${options.workItem.linkedRunId}`) ?? null
      : null;
    signals.push({
      label: "Mission execution",
        status: reviewSignalStatusForExecution(run?.status ?? options.workItem.linkedRunStatus ?? null),
      summary: summarizeMissionReviewSignal(run?.status ?? options.workItem.linkedRunStatus ?? null, run?.verdict ?? options.workItem.linkedRunVerdict ?? null)
    });
  } else {
    signals.push(buildTaskGroupSignal("Execution graph", options.relatedTasks));
  }
  signals.push(buildGateSignal("Validation", runtimeByGateType.get("validation") ?? null));
  signals.push(buildTaskGroupSignal("Browser Smoke", options.relatedTasks.filter((task) => task.type === "qa" && (task.qaMode ?? "smoke") === "smoke")));
  if (options.detail.qaCoverage === "scenario" || runtimeByGateType.has("qa_scenario")) {
    signals.push(buildGateSignal("Browser Scenario", runtimeByGateType.get("qa_scenario") ?? null));
  }
  signals.push(buildGateSignal("Audit", runtimeByGateType.get("audit") ?? null));

  const openRisks: string[] = [];
  if (options.detail.sourceSnapshot.warnings.length > 0) {
    openRisks.push(`${options.detail.sourceSnapshot.warnings.length} source parsing warning(s) need human attention.`);
  }
  if (totals.failed > 0) {
    openRisks.push(`${totals.failed} execution task(s) failed.`);
  }
  if (totals.blocked > 0) {
    openRisks.push(`${totals.blocked} execution task(s) are blocked.`);
  }
  if (options.relatedTasks.length > 0 && totals.succeeded !== options.relatedTasks.length) {
    openRisks.push("Not every execution task completed successfully.");
  }
  if ((runtimeByGateType.get("validation")?.required ?? true) && runtimeByGateType.get("validation")?.status !== "passed") {
    openRisks.push("Validation evidence is incomplete or failed.");
  }
  if (options.detail.qaCoverage === "scenario" && runtimeByGateType.get("qa_scenario")?.status !== "passed") {
    openRisks.push("Browser scenario gate has not produced a passing verdict yet.");
  }
  if ((runtimeByGateType.get("audit")?.required ?? true) && runtimeByGateType.get("audit")?.status !== "passed") {
    openRisks.push("No successful audit/review signal is recorded yet.");
  }

  const requiredGates = gateRuntime.filter((gate) => gate.required);
  const isGateReady =
    options.workItem.executionMode === "mission"
      ? options.workItem.status === "ready_for_review" || options.workItem.status === "completed"
      : requiredGates.length > 0 &&
        requiredGates.every((gate) => gate.status === "passed" || gate.status === "skipped") &&
        totals.failed === 0 &&
        totals.blocked === 0 &&
        options.relatedTasks.length > 0 &&
        totals.succeeded === options.relatedTasks.length;
  const gate =
    options.workItem.reviewStatus === "approved"
      ? "approved"
      : options.workItem.reviewStatus === "changes_requested"
        ? "changes_requested"
        : isGateReady
          ? "ready"
          : "not_ready";

  const headline =
    gate === "approved"
      ? "Approved by operator. This work item is closed."
      : gate === "changes_requested"
        ? options.workItem.remediationPlan
          ? "Sent back by operator. A remediation plan is ready for the next cycle."
          : "Sent back by operator. Additional changes are required."
        : gate === "ready"
          ? "Execution is complete enough for final human review."
          : options.workItem.status === "running"
            ? "Execution is still in progress."
            : options.workItem.status === "failed"
              ? "Execution failed and needs intervention before review."
              : "Execution is not yet ready for final review.";

  return {
    gate,
    headline,
    executionMode: options.workItem.executionMode ?? null,
    operatorDecision: options.workItem.reviewStatus ?? "pending",
    operatorNote: options.workItem.reviewNote ?? null,
    reviewedAt: options.workItem.reviewedAt ?? null,
    totals,
    signals,
    openRisks: Array.from(new Set(openRisks))
  };
}

function buildTaskGroupSignal(label: string, tasks: IndexedTaskLike[]): WorkItemReviewSummary["signals"][number] {
  if (tasks.length === 0) {
    return {
      label,
      status: "missing",
      summary: "No evidence recorded yet."
    };
  }

  const statuses = tasks.map((task) => task.status.trim().toLowerCase());
  const firstSummary = tasks.find((task) => task.resultSummary?.trim())?.resultSummary?.trim();
  if (statuses.every((status) => status === "succeeded" || status === "completed")) {
    return {
      label,
      status: "passed",
      summary: firstSummary ?? `All ${tasks.length} task(s) completed successfully.`
    };
  }
  if (statuses.some((status) => status === "failed" || status === "cancelled" || status === "canceled")) {
    return {
      label,
      status: "failed",
      summary: firstSummary ?? `${tasks.length} task(s) produced a failed outcome.`
    };
  }
  if (statuses.some((status) => status === "blocked" || status === "paused")) {
    return {
      label,
      status: "blocked",
      summary: firstSummary ?? `${tasks.length} task(s) are blocked or paused.`
    };
  }
  return {
    label,
    status: "pending",
    summary: firstSummary ?? `${tasks.length} task(s) are still queued or running.`
  };
}

function buildGateSignal(label: string, gate: WorkItemGateRuntime | null): WorkItemReviewSummary["signals"][number] {
  if (!gate) {
    return {
      label,
      status: "missing",
      summary: "No gate evidence recorded yet."
    };
  }
  return {
    label,
    status:
      gate.status === "passed"
        ? "passed"
        : gate.status === "failed"
          ? "failed"
          : gate.status === "blocked"
            ? "blocked"
            : gate.status === "skipped"
              ? "missing"
              : "pending",
    summary: gate.summary
  };
}

function reviewSignalStatusForExecution(status: string | null): WorkItemReviewSummary["signals"][number]["status"] {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!normalized) return "missing";
  if (normalized === "completed" || normalized === "succeeded" || normalized === "finished") return "passed";
  if (normalized === "failed" || normalized === "cancelled" || normalized === "canceled") return "failed";
  if (normalized === "blocked" || normalized === "paused" || normalized === "interrupted") return "blocked";
  return "pending";
}

function summarizeMissionReviewSignal(status: string | null, verdict: RunVerdict | null): string {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!normalized) return "No linked mission execution is recorded.";
  if (normalized === "completed" || normalized === "succeeded" || normalized === "finished") {
    return verdict ? `Mission completed with verdict ${verdict}.` : "Mission completed successfully.";
  }
  if (normalized === "failed") return "Mission failed.";
  if (normalized === "blocked" || normalized === "paused" || normalized === "interrupted") {
    return "Mission requires operator intervention before approval.";
  }
  return "Mission execution is still active.";
}

function compileMissionGoal(workItem: WorkItemRecord, detail?: {
  lanes?: Array<{ label: string }>;
  tasks?: Array<{ laneLabel?: string; title: string }>;
  acceptanceCriteria?: string[];
  constraints?: string[];
  teamAssignments?: Array<{
    laneLabel: string;
    coverage: string;
    matches: Array<{ name: string; specialization: string; seniority: string }>;
  }>;
  summary?: string;
}): string {
  const sections: string[] = [
    `Work intake type: ${workItem.brief.sourceType}`,
    `Title: ${workItem.brief.title}`,
    `Request:\n${workItem.brief.request.trim()}`
  ];
  if (detail?.summary && detail.summary.trim() && detail.summary.trim() !== workItem.brief.request.trim()) {
    sections.push(`Planning summary:\n${detail.summary.trim()}`);
  }
  if (workItem.brief.sourceRef) {
    sections.push(`Source reference: ${workItem.brief.sourceRef}`);
  }
  const acceptanceCriteria = (detail?.acceptanceCriteria?.length ?? 0) > 0
    ? detail?.acceptanceCriteria ?? []
    : workItem.brief.acceptanceCriteria;
  if (acceptanceCriteria.length > 0) {
    sections.push(
      `Acceptance criteria:\n${acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
    );
  }
  const constraints = (detail?.constraints?.length ?? 0) > 0
    ? detail?.constraints ?? []
    : workItem.brief.constraints;
  if (constraints.length > 0) {
    sections.push(
      `Constraints:\n${constraints.map((item) => `- ${item}`).join("\n")}`
    );
  }
  if (workItem.reviewStatus === "changes_requested" && workItem.reviewNote?.trim()) {
    sections.push(`Remediation note from operator:\n- ${workItem.reviewNote.trim()}`);
  }
  if ((detail?.lanes?.length ?? 0) > 0) {
    sections.push(
      `Preferred execution lanes:\n${detail!.lanes!.map((lane) => `- ${lane.label}`).join("\n")}`
    );
  }
  if ((detail?.tasks?.length ?? 0) > 0) {
    sections.push(
      `Planned tasks:\n${detail!.tasks!.slice(0, 10).map((task) => `- [${task.laneLabel ?? "General"}] ${task.title}`).join("\n")}`
    );
  }
  if ((detail?.teamAssignments?.length ?? 0) > 0) {
    sections.push(
      `Available team coverage:\n${detail!.teamAssignments!.map((assignment) => {
        const match = assignment.matches[0];
        if (!match) {
          return `- ${assignment.laneLabel}: missing specialist`;
        }
        return `- ${assignment.laneLabel}: ${match.name} (${match.specialization}/${match.seniority}, ${assignment.coverage})`;
      }).join("\n")}`
    );
  }
  sections.push(
    "Execution context: This work item was launched from the Orchestrum Work Intake surface. Keep the change scoped to the intake and surface unresolved risks explicitly."
  );
  return sections.join("\n\n");
}

function normalizeRunStartOptions(raw: unknown): {
  concurrency?: number;
  modelOverrides?: Record<string, string>;
  strategyMode?: string;
} {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const concurrencyRaw = typeof parsed.concurrency === "number" ? parsed.concurrency : Number(parsed.concurrency ?? NaN);
  const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
    ? Math.max(1, Math.floor(concurrencyRaw))
    : undefined;
  const strategyMode = typeof parsed.strategyMode === "string" && parsed.strategyMode.trim()
    ? parsed.strategyMode.trim()
    : undefined;
  const modelOverrides: Record<string, string> = {};
  if (parsed.modelOverrides && typeof parsed.modelOverrides === "object") {
    for (const [key, value] of Object.entries(parsed.modelOverrides as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        modelOverrides[key] = value.trim();
      }
    }
  }
  return {
    concurrency,
    modelOverrides: Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined,
    strategyMode
  };
}

function createWorkRunId(workItemId: string): string {
  return `work-${workItemId.slice(0, 8)}-${Date.now()}`;
}
