import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type express from "express";
import {
  addWorkspaceApproval,
  cancelRun,
  exportRunBundle,
  importRunBundle,
  loadDeliverySession,
  loadMissionRun,
  missionGraphToStepStates,
  readAppendedLines,
  readTailLines,
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
};

type AgentPlatformLike = {
  resumeMission(options: {
    runId: string;
    runsDir: string;
    workspaceId: string;
  }): Promise<{ ok: boolean }>;
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
    runsDir: string;
    stateIndex: StateIndex;
    runIndex: RunIndexLike;
    agentPlatform: AgentPlatformLike;
  }
): void {
  const rebuildStateIndex = () => {
    void options.stateIndex.rebuild().catch(() => undefined);
  };

  app.get("/runs", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const tag = req.query.tag ? String(req.query.tag) : undefined;
    const search = req.query.search ? String(req.query.search).toLowerCase() : undefined;
    const runs = options.runIndex.list({ workspaceId, status, tag, search });
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
    const run = options.runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const logPath = resolveRunLogPath(run.runDir, run.meta);
    const lines = fsSync.existsSync(logPath) ? await readTailLines(logPath, tail) : [];
    res.json({ lines });
  });

  app.get("/runs/:id", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = options.runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const detail = await buildRunDetail(run);
    res.json(detail);
  });

  app.patch("/runs/:id", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const run = options.runIndex.get(req.params.id, workspaceId);
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
    const run = options.runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const steps = await loadRunSteps(run);
    res.json(steps);
  });

  app.get("/runs/:id/steps/:stepId/artifacts", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = options.runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const stepPath = getRunStepDir(run, req.params.stepId);
    const files = await listArtifacts(stepPath);
    res.json({ files });
  });

  app.get("/runs/:id/steps/:stepId/artifacts/*", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = options.runIndex.get(req.params.id, workspaceId);
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
    const run = options.runIndex.get(req.params.id, workspaceId);
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

    const seenStatuses = new Map<string, string>();
    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const sendEvent = (name: string, payload: Record<string, unknown>) => {
      if (closed) return;
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const tick = async () => {
      if (closed) return;
      const runs = options.runIndex.list().slice(0, 100);
      for (const run of runs) {
        const key = `${run.workspaceId}:${run.runId}`;
        const previous = seenStatuses.get(key);
        if (!previous && run.status === "running") {
          sendEvent("run:started", {
            runId: run.runId,
            workspaceId: run.workspaceId,
            status: run.status,
            ts: Date.now()
          });
        }
        if (run.status === "running") {
          sendEvent("run:step", {
            runId: run.runId,
            workspaceId: run.workspaceId,
            status: run.status,
            ts: Date.now()
          });
        }
        if (previous === "running" && run.status !== "running") {
          sendEvent("run:updated", {
            runId: run.runId,
            workspaceId: run.workspaceId,
            status: run.status,
            ts: Date.now()
          });
        }
        seenStatuses.set(key, run.status);
      }

      sendEvent("agent:updated", {
        queued: 0,
        running: runs.filter((run) => run.status === "running").length,
        ts: Date.now()
      });
    };

    await tick();
    const timer = setInterval(() => {
      void tick();
    }, 2000);
    req.on("close", () => clearInterval(timer));
  });

  const resumeRunHandler = async (req: express.Request, res: express.Response) => {
    const runId = String(req.params.id ?? "");
    if (!runId) return res.status(400).json({ error: "run id required" });
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const run = options.runIndex.get(runId, workspaceId);
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
    const run = options.runIndex.get(runId, workspaceId);
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
    const run = options.runIndex.get(req.params.id, workspaceId);
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
    const run = options.runIndex.get(req.params.id, workspaceId);
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
