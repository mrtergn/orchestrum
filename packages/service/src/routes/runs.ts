import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type express from "express";
import {
  addWorkspaceApproval,
  cancelRun,
  exportRunBundle,
  getWorkspaceSignalsPath,
  getWorkspaceWorkItemsPath,
  importRunBundle,
  loadWorkspaces,
  loadDeliverySession,
  loadMissionRun,
  missionGraphToStepStates,
  readAppendedLines,
  readTailLines,
  type RunOverviewItem,
  type RunSummary,
  type WorkItemRecord,
  writeJson,
  writeText,
  type MissionGraph,
  type StateIndex
} from "@orchestrum/core";

type RunRecordLike = {
  runId: string;
  runDir: string;
  workspaceId: string;
  meta: any;
};

type RunIndexLike = {
  list(filter?: { workspaceId?: string; status?: string; tag?: string; search?: string }): any[];
  get(runId: string, workspaceId?: string): RunRecordLike | null;
  update(runId: string, workspaceId: string, meta: any): void;
  sync(filter?: { workspaceId?: string; runId?: string }): Promise<void>;
};

type AgentPlatformLike = {
  resumeMission(options: {
    runId: string;
    runsDir: string;
    workspaceId: string;
  }): Promise<{ ok: boolean }>;
  listTasks(options?: { workspaceId?: string; workItemId?: string }): Array<{
    id: string;
    workspaceId?: string;
    linkedWorkItemId?: string;
    linkedRunId?: string;
    status: string;
  }>;
  importMissionNode(options: {
    runsDir: string;
    workspaceId: string;
    runId: string;
    nodeId: string;
    text: string;
    targetTool?: string;
  }): Promise<any>;
};

export function registerRunRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    runsDir: string;
    stateIndex: StateIndex;
    runIndex: RunIndexLike;
    agentPlatform: AgentPlatformLike;
    listWorkspacePaths: () => Promise<string[]>;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  }
): void {
  const rebuildStateIndex = () => {
    void options.stateIndex.rebuild().catch(() => undefined);
  };

  const loadRunWithSync = async (runId: string, workspaceId?: string) => {
    let run = options.runIndex.get(runId, workspaceId);
    if (!run) {
      await options.runIndex.sync({ workspaceId, runId });
      run = options.runIndex.get(runId, workspaceId);
    }
    return run;
  };

  app.get("/runs", async (req, res) => {
    const view = req.query.view === "overview" ? "overview" : "raw";
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const tag = req.query.tag ? String(req.query.tag) : undefined;
    const search = req.query.search ? String(req.query.search).toLowerCase() : undefined;
    let runs = options.runIndex.list({ workspaceId, status, tag, search });
    if (runs.length === 0) {
      await options.runIndex.sync({ workspaceId });
      runs = options.runIndex.list({ workspaceId, status, tag, search });
    }
    if (view === "overview") {
      const overview = await buildRunOverview({
        rootDir: options.rootDir,
        workspaceId,
        status,
        tag,
        search,
        runs,
        listWorkspacePaths: options.listWorkspacePaths,
        resolveWorkspacePath: options.resolveWorkspacePath,
        agentPlatform: options.agentPlatform
      });
      return res.json(overview);
    }
    res.json(runs);
  });

  app.get("/runs/recovery", async (_req, res) => {
    const runs = options.runIndex.list({ status: "interrupted" });
    res.json({ runs });
  });

  app.get("/runs/:id/logs", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const tailRaw = req.query.tail ? Number(req.query.tail) : 200;
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? tailRaw : 200;
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const logPath = resolveRunLogPath(run.runDir, run.meta);
    const lines = fsSync.existsSync(logPath) ? await readTailLines(logPath, tail) : [];
    res.json({ lines });
  });

  app.get("/runs/:id", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const detail = await buildRunDetail(run);
    res.json(detail);
  });

  app.patch("/runs/:id", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const { pinned, tags } = req.body ?? {};
    const updated = { ...run.meta };
    if (typeof pinned === "boolean") updated.pinned = pinned;
    if (Array.isArray(tags)) updated.tags = tags.map((tag: any) => String(tag));
    await writeJson(path.join(run.runDir, "run.json"), updated);
    options.runIndex.update(run.runId, run.workspaceId, updated);
    res.json(updated);
  });

  app.get("/runs/:id/steps", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const steps = await loadRunSteps(run);
    res.json(steps);
  });

  app.get("/runs/:id/steps/:stepId/artifacts", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const stepPath = getRunStepDir(run, req.params.stepId);
    const files = await listArtifacts(stepPath);
    res.json({ files });
  });

  app.get("/runs/:id/steps/:stepId/artifacts/*", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const artifactPath = (req.params as Record<string, string | undefined>)["0"] ?? "";
    const baseDir = getRunStepDir(run, req.params.stepId);
    const full = path.resolve(baseDir, artifactPath);
    if (!full.startsWith(path.resolve(baseDir))) {
      return res.status(400).json({ error: "Invalid path" });
    }
    const buffer = await fs.readFile(full).catch(() => null);
    if (buffer == null) return res.status(404).json({ error: "Not found" });
    const ext = path.extname(full).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
      return res.json({
        content: buffer.toString("base64"),
        encoding: "base64",
        mimeType: mimeTypeForExtension(ext)
      });
    }
    res.json({
      content: buffer.toString("utf8"),
      encoding: "utf8",
      mimeType: ext === ".json" ? "application/json" : "text/plain"
    });
  });

  app.get("/runs/:id/stream", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) {
      res.status(404).end();
      return;
    }
    const eventsPath = path.join(run.runDir, "events.ndjson");
    await streamEvents(req, res, eventsPath, () => buildSnapshot(run.runDir));
  });

  app.get("/events", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let closed = false;
    const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
    const tails = new Map<string, { position: number; buffer: string }>();
    req.on("close", () => {
      closed = true;
    });

    const sendSignal = (payload: Record<string, unknown>) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const signalFiles = async () => {
      if (workspaceId) {
        const workspacePath = await options.resolveWorkspacePath(workspaceId);
        return workspacePath ? [getWorkspaceSignalsPath(workspacePath)] : [];
      }
      const repoPaths = await options.listWorkspacePaths().catch(() => []);
      return repoPaths.map((repoPath) => getWorkspaceSignalsPath(repoPath));
    };

    const tick = async () => {
      if (closed) return;
      for (const filePath of await signalFiles()) {
        const current = tails.get(filePath) ?? { position: 0, buffer: "" };
        const result = await readAppendedLines(filePath, current).catch(() => ({ lines: [], state: current }));
        tails.set(filePath, result.state);
        for (const line of result.lines) {
          try {
            sendSignal(JSON.parse(line));
          } catch {
            // ignore malformed signal lines
          }
        }
      }
    };

    await tick();
    const timer = setInterval(() => {
      void tick();
    }, 1500);
    req.on("close", () => clearInterval(timer));
  });

  const resumeRunHandler = async (req: express.Request, res: express.Response) => {
    const runId = String(req.params.id ?? "");
    if (!runId) return res.status(400).json({ error: "run id required" });
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const run = await loadRunWithSync(runId, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!isMissionRunMeta(run.meta)) {
      return res.status(400).json({ error: "Resume is only supported for mission runs." });
    }
    const result = await options.agentPlatform.resumeMission({
      runId,
      runsDir: options.runsDir,
      workspaceId: run.workspaceId
    });
    res.json({ ok: result.ok, fromStepId: inferMissionResumeNodeId(run.meta) ?? undefined });
  };

  const cancelRunHandler = async (req: express.Request, res: express.Response) => {
    const runId = String(req.params.id ?? "");
    if (!runId) return res.status(400).json({ error: "run id required" });
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const run = await loadRunWithSync(runId, workspaceId);
    if (run && isMissionRunMeta(run.meta)) {
      const updated = {
        ...run.meta,
        status: "cancelled",
        end: run.meta?.end ?? new Date().toISOString()
      };
      await writeJson(path.join(run.runDir, "run.json"), updated);
      options.runIndex.update(run.runId, run.workspaceId, updated);
      rebuildStateIndex();
      return res.json({ ok: true });
    }
    await cancelRun(options.runsDir, runId, workspaceId);
    res.json({ ok: true });
  };

  app.post("/runs/:id/resume", resumeRunHandler);
  app.post("/api/runs/:id/resume", resumeRunHandler);
  app.post("/runs/:id/cancel", cancelRunHandler);
  app.post("/api/runs/:id/cancel", cancelRunHandler);

  app.post("/runs/:id/share", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : "default";
    try {
      const archive = await exportRunBundle({
        runsDir: options.runsDir,
        runId: req.params.id,
        workspaceId,
        outputDir: req.body?.outputDir ? String(req.body.outputDir) : undefined
      });
      res.json({ archive });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Share failed" });
    }
  });

  app.post("/runs/import", async (req, res) => {
    const data = req.body?.data ? String(req.body.data) : "";
    const filePath = req.body?.file ? String(req.body.file) : "";
    let archivePath = filePath;
    if (!archivePath && data) {
      const tempDir = path.join(os.tmpdir(), `orchestrum-run-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
      archivePath = path.join(tempDir, "run.orun");
      await fs.writeFile(archivePath, Buffer.from(data, "base64"));
    }
    if (!archivePath) return res.status(400).json({ error: "file or data required" });
    try {
      const result = await importRunBundle({ archivePath, runsDir: options.runsDir });
      rebuildStateIndex();
      res.json({ ok: true, result });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Import failed" });
    }
  });

  app.post("/runs/:id/approve", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const stepId = String(req.body?.stepId ?? "");
    const always = Boolean(req.body?.always);
    if (!stepId) return res.status(400).json({ error: "stepId required" });
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    await writeText(path.join(run.runDir, "approvals", `${stepId}.approved`), new Date().toISOString());
    if (always) {
      const repoPath = run.meta?.repoPath;
      if (repoPath) {
        await addWorkspaceApproval(repoPath, { stepId, kind: "command", createdAt: new Date().toISOString() });
        await addWorkspaceApproval(repoPath, { stepId, kind: "diff", createdAt: new Date().toISOString() });
        await addWorkspaceApproval(repoPath, { stepId, kind: "governance", createdAt: new Date().toISOString() });
      }
    }
    rebuildStateIndex();
    res.json({ ok: true });
  });

  app.post("/runs/:id/nodes/:nodeId/import", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const targetTool = typeof req.body?.targetTool === "string" ? req.body.targetTool : undefined;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
    if (!text.trim()) return res.status(400).json({ error: "text required" });
    const run = await loadRunWithSync(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!isMissionRunMeta(run.meta)) {
      return res.status(400).json({ error: "Node imports are only supported for mission runs." });
    }
    try {
      const missionRun = await options.agentPlatform.importMissionNode({
        runsDir: options.runsDir,
        workspaceId,
        runId: req.params.id,
        nodeId: req.params.nodeId,
        text,
        targetTool
      });
      options.runIndex.update(run.runId, run.workspaceId, missionRun);
      rebuildStateIndex();
      res.json({ ok: true, run: missionRun });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Mission node import failed." });
    }
  });
}

function statusPriority(status: string): number {
  if (status === "blocked") return 0;
  if (status === "failed") return 1;
  if (status === "paused" || status === "interrupted") return 2;
  if (status === "running") return 3;
  if (status === "ready_for_review") return 4;
  return 5;
}

async function buildRunOverview(options: {
  rootDir: string;
  workspaceId?: string;
  status?: string;
  tag?: string;
  search?: string;
  runs: RunSummary[];
  listWorkspacePaths: () => Promise<string[]>;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  agentPlatform: AgentPlatformLike;
}): Promise<RunOverviewItem[]> {
  const workItems = await loadOverviewWorkItems({
    rootDir: options.rootDir,
    workspaceId: options.workspaceId,
    listWorkspacePaths: options.listWorkspacePaths,
    resolveWorkspacePath: options.resolveWorkspacePath
  });

  const taskByWorkItemId = new Map<string, ReturnType<AgentPlatformLike["listTasks"]>>();
  for (const workItem of workItems) {
    const tasks = options.agentPlatform.listTasks({
      workspaceId: workItem.workspaceId,
      workItemId: workItem.id
    });
    taskByWorkItemId.set(workItem.id, tasks);
  }

  const workItemRows = workItems
    .filter((workItem) => isTaskGraphOverviewWorkItem(workItem))
    .map((workItem) => {
      const relatedTasks = taskByWorkItemId.get(workItem.id) ?? [];
      const childRunIds = new Set<string>();
      if (typeof workItem.linkedRunId === "string" && workItem.linkedRunId.trim()) {
        childRunIds.add(workItem.linkedRunId.trim());
      }
      for (const task of relatedTasks) {
        if (typeof task.linkedRunId === "string" && task.linkedRunId.trim()) {
          childRunIds.add(task.linkedRunId.trim());
        }
      }
      return {
        itemType: "work_item" as const,
        id: workItem.id,
        workspaceId: workItem.workspaceId,
        title: workItem.brief.title,
        sourceType: workItem.brief.sourceType,
        status: workItem.status,
        executionMode: resolveWorkItemExecutionMode(workItem),
        reviewStatus: workItem.reviewStatus ?? null,
        summary: summarizeWorkItemExecution(workItem),
        recommendedAction: recommendedWorkItemAction(workItem),
        lastActivityAt: workItem.updatedAt ?? workItem.lastStartedAt ?? workItem.createdAt,
        childRunCount: childRunIds.size,
        childTaskCount: Array.isArray(workItem.linkedTaskIds) ? workItem.linkedTaskIds.length : relatedTasks.length
      };
    })
    .filter((item) => matchesOverviewFilters(item, options.search, options.status, options.tag));

  const parentWorkItemByRunId = new Map<string, { id: string; title: string }>();
  for (const workItem of workItems) {
    if (typeof workItem.linkedRunId === "string" && workItem.linkedRunId.trim()) {
      parentWorkItemByRunId.set(workItem.linkedRunId.trim(), {
        id: workItem.id,
        title: workItem.brief.title
      });
    }
    for (const task of taskByWorkItemId.get(workItem.id) ?? []) {
      if (typeof task.linkedRunId === "string" && task.linkedRunId.trim()) {
        parentWorkItemByRunId.set(task.linkedRunId.trim(), {
          id: workItem.id,
          title: workItem.brief.title
        });
      }
    }
  }

  const runRows = options.runs.map((run) => {
    const parent = parentWorkItemByRunId.get(run.runId) ?? null;
    return {
      ...run,
      itemType: "run" as const,
      summary: summarizeRunRow(run, parent),
      recommendedAction: recommendedRunAction(run),
      lastActivityAt: run.end ?? run.start,
      parentWorkItemId: parent?.id ?? null,
      parentWorkItemTitle: parent?.title ?? null
    };
  });

  // Keep child runs subordinate to their parent work item session by default.
  // Only standalone runs (no parentWorkItemId) are surfaced at the top level
  // in the overview. Raw run listings and run detail endpoints remain unchanged.
  const topLevelRuns = runRows.filter((row) => !row.parentWorkItemId);

  return [...workItemRows, ...topLevelRuns].sort((left, right) => {
    if (left.itemType !== right.itemType) {
      return left.itemType === "work_item" ? -1 : 1;
    }
    if (left.itemType === "run" && right.itemType === "run") {
      const leftParent = left.parentWorkItemId ? 1 : 0;
      const rightParent = right.parentWorkItemId ? 1 : 0;
      if (leftParent !== rightParent) return leftParent - rightParent;
    }
    const priority = statusPriority(left.status) - statusPriority(right.status);
    if (priority !== 0) return priority;
    return overviewTimestamp(right) - overviewTimestamp(left);
  });
}

async function loadOverviewWorkItems(options: {
  rootDir: string;
  workspaceId?: string;
  listWorkspacePaths: () => Promise<string[]>;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
}): Promise<WorkItemRecord[]> {
  const candidates = await resolveWorkspaceCandidates(options);
  const items: WorkItemRecord[] = [];
  for (const candidate of candidates) {
    const filePath = getWorkspaceWorkItemsPath(candidate.path);
    const raw = await fs.readFile(filePath, "utf8").then((text) => JSON.parse(text) as unknown[]).catch(() => []);
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (entry && typeof entry === "object") {
        items.push(entry as WorkItemRecord);
      }
    }
  }
  return items;
}

async function resolveWorkspaceCandidates(options: {
  rootDir: string;
  workspaceId?: string;
  listWorkspacePaths: () => Promise<string[]>;
  resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
}): Promise<Array<{ id: string; path: string }>> {
  if (options.workspaceId) {
    const workspacePath = await options.resolveWorkspacePath(options.workspaceId);
    return workspacePath ? [{ id: options.workspaceId, path: workspacePath }] : [];
  }
  const manifests = await loadWorkspaces(options.rootDir, {
    repoPaths: await options.listWorkspacePaths().catch(() => [])
  }).catch(() => []);
  return manifests.map((workspace) => ({ id: workspace.id, path: workspace.path }));
}

function isTaskGraphOverviewWorkItem(workItem: WorkItemRecord): boolean {
  const executionMode = resolveWorkItemExecutionMode(workItem);
  if (executionMode !== "task_graph") return false;
  return ["running", "blocked", "ready_for_review", "failed"].includes(workItem.status)
    || workItem.reviewStatus === "changes_requested";
}

function resolveWorkItemExecutionMode(workItem: WorkItemRecord): "task_graph" | "mission" | "not_started" {
  if (workItem.executionMode === "task_graph" || (workItem.linkedTaskIds?.length ?? 0) > 0) return "task_graph";
  if (workItem.executionMode === "mission" || workItem.linkedRunId) return "mission";
  return "not_started";
}

function summarizeWorkItemExecution(workItem: WorkItemRecord): string {
  if (workItem.reviewStatus === "changes_requested") {
    return "Changes were requested on the latest cycle. Launch remediation when you are ready to address them.";
  }
  if (workItem.status === "ready_for_review") {
    return "The current cycle is ready for a human review decision.";
  }
  if (workItem.status === "blocked") {
    return "Execution is blocked. Open the work item to inspect the current lane, gate, or recovery guidance.";
  }
  if (workItem.status === "failed") {
    return "The latest execution failed. Inspect the work item to see which lane or child run failed.";
  }
  if (workItem.status === "running") {
    if (resolveWorkItemExecutionMode(workItem) === "task_graph") {
      return "Task-graph execution is in flight. Work remains the top-level truth for team, gate, and evidence state.";
    }
    return "Mission execution is still running.";
  }
  return "Open the work item for the latest summary, readiness, and next action.";
}

function recommendedWorkItemAction(workItem: WorkItemRecord): string {
  if (workItem.reviewStatus === "changes_requested") return "Launch remediation";
  if (workItem.status === "ready_for_review") return "Review work item";
  if (workItem.status === "blocked" || workItem.status === "failed") return "Inspect work item";
  if (workItem.status === "running") return "Open work item";
  return "Open work item";
}

function summarizeRunRow(run: RunSummary, parent: { id: string; title: string } | null): string {
  if (parent) {
    return `Child run for ${parent.title}. Open the parent work item for the top-level task-graph summary.`;
  }
  if (run.status === "blocked") return "Run finished with blocking findings or approval debt.";
  if (run.status === "failed") return "Run failed before completion.";
  if (run.status === "paused" || run.status === "interrupted") return "Run is paused and may need resume or recovery.";
  if (run.status === "running") return "Run execution is still in flight.";
  return "Standalone run history and evidence.";
}

function recommendedRunAction(run: RunSummary): string {
  if (run.status === "blocked") return "Review findings";
  if (run.status === "failed") return "Inspect failure";
  if (run.status === "paused" || run.status === "interrupted") return "Resume";
  return "Open run";
}

function overviewTimestamp(item: RunOverviewItem): number {
  if (item.itemType === "work_item") {
    return Date.parse(item.lastActivityAt);
  }
  return Date.parse(item.lastActivityAt ?? item.start ?? "");
}

function matchesOverviewFilters(
  item: {
    itemType: "work_item" | "run";
    title?: string;
    runId?: string;
    summary?: string;
    sourceType?: string;
    status: string;
  },
  search?: string,
  status?: string,
  tag?: string
): boolean {
  if (status) {
    const normalized = status.toLowerCase();
    if (normalized === "finished") {
      if (!["completed", "finished"].includes(item.status)) return false;
    } else if (item.status !== normalized) {
      return false;
    }
  }
  if (tag && item.itemType === "work_item") {
    return false;
  }
  if (!search) return true;
  const haystack = [item.title, item.runId, item.summary, item.sourceType].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search);
}

function isMissionRunMeta(run: any): run is {
  kind: "mission";
  end?: string | null;
  graph: MissionGraph;
} {
  return Boolean(
    run &&
    run.kind === "mission" &&
    run.graph &&
    typeof run.graph.templateId === "string" &&
    typeof run.graph.name === "string" &&
    typeof run.graph.description === "string" &&
    Array.isArray(run.graph.nodes)
  );
}

async function loadStepStatesFromDir(stepsDir: string) {
  const entries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const statusPath = path.join(stepsDir, entry.name, "status.json");
        const raw = await fs.readFile(statusPath, "utf8").catch(() => null);
        return raw ? JSON.parse(raw) : { stepId: entry.name, ok: false, error: "Missing status" };
      })
  );
}

async function loadRunSteps(run: RunRecordLike) {
  if (isMissionRunMeta(run.meta)) {
    return missionGraphToStepStates(run.meta.graph);
  }
  return loadStepStatesFromDir(path.join(run.runDir, "steps"));
}

function getRunStepDir(run: RunRecordLike, stepId: string): string {
  return isMissionRunMeta(run.meta)
    ? path.join(run.runDir, "nodes", stepId)
    : path.join(run.runDir, "steps", stepId);
}

function resolveRunLogPath(runDir: string, runMeta: any): string {
  if (isMissionRunMeta(runMeta)) {
    return path.join(runDir, "events.ndjson");
  }
  const runnerLog = path.join(runDir, "logs", "runner.ndjson");
  return fsSync.existsSync(runnerLog) ? runnerLog : path.join(runDir, "events.ndjson");
}

function inferMissionResumeNodeId(runMeta: any): string | null {
  if (!isMissionRunMeta(runMeta)) return null;
  const resumable = runMeta.graph.nodes.find((node: any) =>
    node.status === "awaiting_approval" ||
    node.status === "waiting_input" ||
    node.status === "failed" ||
    node.status === "blocked" ||
    node.status === "pending"
  );
  return resumable?.id ?? null;
}

async function listArtifacts(stepPath: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, relativePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  };
  await walk(stepPath, "");
  return results.sort();
}

async function streamEvents(
  req: express.Request,
  res: express.Response,
  eventsPath: string,
  snapshot: () => Promise<any>
) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let state = { position: 0, buffer: "" };
  let backlog: any[] = [];
  let lastHeartbeat = Date.now();
  let closed = false;

  req.on("close", () => {
    closed = true;
  });

  const send = (payload: any) => {
    if (closed) return;
    const ok = res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (!ok) {
      backlog = [];
    }
  };

  const initial = await snapshot().catch(() => null);
  if (initial) {
    send({ t: "run.snapshot", ...initial, ts: Date.now() });
  }

  const tick = async () => {
    if (closed) return;
    const result = await readAppendedLines(eventsPath, state);
    state = result.state;
    if (result.lines.length > 0) {
      backlog.push(...result.lines);
    }

    if (backlog.length > 800) {
      backlog = [];
      const nextSnapshot = await snapshot();
      send({ t: "run.snapshot", ...nextSnapshot, ts: Date.now() });
    } else {
      for (const line of backlog.splice(0, backlog.length)) {
        try {
          send(JSON.parse(line));
        } catch {
          // ignore malformed
        }
      }
    }

    if (Date.now() - lastHeartbeat > 3000) {
      send({ t: "heartbeat", ts: Date.now() });
      lastHeartbeat = Date.now();
    }
  };

  const timer = setInterval(tick, 250);
  req.on("close", () => clearInterval(timer));
}

async function buildSnapshot(runDir: string) {
  const runMetaPath = path.join(runDir, "run.json");
  const runRaw = await fs.readFile(runMetaPath, "utf8").catch(() => null);
  const run = runRaw ? JSON.parse(runRaw) : null;
  const steps = isMissionRunMeta(run)
    ? missionGraphToStepStates(run.graph)
    : await loadStepStatesFromDir(path.join(runDir, "steps"));
  const total = run?.totalSteps ?? steps.length;
  const done = run?.completedSteps ?? steps.filter((step: any) => step.ok).length;
  const progress = {
    done,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
    remaining: Math.max(0, total - done)
  };
  return { run, steps, progress };
}

async function buildRunDetail(run: RunRecordLike) {
  if (isMissionRunMeta(run.meta)) {
    const missionRun = await loadMissionRun(run.runDir).catch(() => null);
    const graph = missionRun?.graph ?? run.meta.graph ?? null;
    const delivery = await loadDeliverySession({
      runsDir: path.resolve(run.runDir, "..", ".."),
      runId: run.runId,
      workspaceId: run.workspaceId
    }).catch(() => null);
    const steps = graph ? missionGraphToStepStates(graph) : [];
    return {
      run: missionRun ?? run.meta,
      steps,
      graph: graph
        ? {
            templateId: graph.templateId,
            name: graph.name,
            description: graph.description,
            category: graph.category,
            defaultGoalHint: graph.defaultGoalHint,
            recommendedRoles: graph.recommendedRoles,
            outcomes: graph.outcomes,
            nodes: graph.nodes
          }
        : null,
      delivery
    };
  }
  if (run.meta?.kind === "delivery") {
    const delivery = await loadDeliverySession({
      runsDir: path.resolve(run.runDir, "..", ".."),
      runId: run.runId,
      workspaceId: run.workspaceId
    }).catch(() => null);
    return {
      run: run.meta,
      steps: [],
      graph: null,
      delivery
    };
  }
  const steps = await loadStepStatesFromDir(path.join(run.runDir, "steps"));
  return { run: run.meta, steps, graph: null, delivery: null };
}

function mimeTypeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
