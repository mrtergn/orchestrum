import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  loadWorkspaces,
  migrateRuns,
  writeCrashReport,
  getCurrentVersion,
  StateIndex,
  Logger,
  recoverInterruptedRuns,
  DEFAULT_SERVICE_PORT
} from "@orchestrum/core";
import { writeJson } from "@orchestrum/core";
import { AgentPlatform } from "./agentPlatform.js";
import { registerDeliveryRoutes } from "./routes/delivery.js";
import { registerInsightsOpsRoutes } from "./routes/insightsOps.js";
import { registerMetaOpsRoutes } from "./routes/metaOps.js";
import { registerMissionRoutes } from "./routes/missions.js";
import { registerPromptOpsRoutes } from "./routes/promptOps.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSecretOpsRoutes } from "./routes/secretOps.js";
import { registerSystemOpsRoutes } from "./routes/systemOps.js";
import { registerWorkspaceRegistryRoutes } from "./routes/workspaceRegistry.js";
import { registerWorkspaceSupportRoutes } from "./routes/workspaceSupport.js";

export type ServiceOptions = {
  port?: number;
  runsDir?: string;
  rootDir?: string;
};

type RunRecord = {
  runId: string;
  runDir: string;
  workspaceId: string;
  meta: any;
};

export async function startService(options: ServiceOptions = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const runsDir =
    options.runsDir ??
    process.env.ORCHESTRUM_RUNS_DIR ??
    path.join(rootDir, "runs");
  const port =
    options.port ??
    Number(process.env.ORCHESTRUM_SERVICE_PORT ?? DEFAULT_SERVICE_PORT);

  await migrateRuns(runsDir);
  await recoverInterruptedRuns(runsDir);

  const runIndex = new RunIndex(runsDir);
  await runIndex.init();
  await recoverInterruptedRunsIndex(runIndex);
  const stateIndex = new StateIndex({ rootDir, runsDir });
  await stateIndex.init();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "20mb" }));

  const logger = new Logger(path.join(rootDir, "logs", "service.ndjson"));
  const agentPlatform = new AgentPlatform({ rootDir });
  await agentPlatform.init(logger);
  const versionMeta = await getCurrentVersion(rootDir).catch(() => null);
  if (!versionMeta) {
    console.warn("[orchestrum] version.json missing. Integrity check failed.");
    void logger.warn("integrity.missing_version", { rootDir });
  }
  app.use((req, res, next) => {
    const correlationId = crypto.randomUUID();
    res.setHeader("x-correlation-id", correlationId);
    const start = Date.now();
    void logger.info("request", {
      correlationId,
      method: req.method,
      path: req.path
    });
    res.on("finish", () => {
      void logger.info("response", {
        correlationId,
        status: res.statusCode,
        durationMs: Date.now() - start
      });
    });
    next();
  });

  const useKeychain = process.env.ORCHESTRUM_USE_KEYCHAIN === "1";

  const resolveWorkspace = (workspaceId?: string) => resolveWorkspacePath(rootDir, workspaceId);

  registerMetaOpsRoutes(app, {
    rootDir,
    runsDir
  });
  registerInsightsOpsRoutes(app, {
    runsDir,
    stateIndex,
    agentPlatform,
    resolveWorkspacePath: resolveWorkspace
  });
  registerWorkspaceRegistryRoutes(app, {
    rootDir,
    runIndex,
    resolveWorkspacePath: resolveWorkspace
  });
  registerSecretOpsRoutes(app, {
    rootDir,
    useKeychain,
    resolveWorkspacePath: resolveWorkspace
  });
  registerWorkspaceSupportRoutes(app, {
    rootDir,
    runsDir,
    stateIndex,
    resolveWorkspacePath
  });
  registerSystemOpsRoutes(app, {
    rootDir
  });
  registerMissionRoutes(app, {
    runsDir,
    stateIndex,
    resolveWorkspacePath: resolveWorkspace,
    agentPlatform,
    logger,
    useKeychain
  });
  registerPromptOpsRoutes(app, {
    resolveWorkspacePath: resolveWorkspace
  });
  registerRunRoutes(app, {
    runsDir,
    stateIndex,
    runIndex,
    agentPlatform
  });
  registerDeliveryRoutes(app, {
    runsDir,
    stateIndex
  });

  agentPlatform.registerRoutes(app);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void logger.error("error", { message: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(port, () => {
    console.log(`[orchestrum] service listening on http://localhost:${port}`);
    void logger.info("service.started", { port, runsDir });
  });

  const shutdown = () => {
    agentPlatform.shutdown();
    server.close(() => {
      void logger.info("service.stopped", { port });
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    void logger.error("service.crash", { message: err.message, stack: err.stack });
    void writeCrashReport(rootDir, err);
  });

  return { app, server };
}

class RunIndex {
  private runs = new Map<string, RunRecord>();

  constructor(private runsDir: string) {}

  async init() {
    await this.scan();
    this.watch();
  }

  list(filter: { workspaceId?: string; status?: string; tag?: string; search?: string } = {}) {
    const entries = Array.from(this.runs.values());
    return entries
      .filter((entry) => {
        if (filter.workspaceId && entry.workspaceId !== filter.workspaceId) return false;
        if (filter.status && entry.meta?.status !== filter.status) return false;
        if (filter.tag && !(entry.meta?.tags ?? []).includes(filter.tag)) return false;
        if (filter.search) {
          const text = `${entry.meta?.runId ?? ""} ${entry.meta?.repoPath ?? ""}`.toLowerCase();
          if (!text.includes(filter.search)) return false;
        }
        return true;
      })
      .map((entry) => entry.meta)
      .sort((a, b) => (a.start < b.start ? 1 : -1));
  }

  get(runId: string, workspaceId?: string): RunRecord | null {
    if (workspaceId) {
      const key = `${workspaceId}:${runId}`;
      return this.runs.get(key) ?? null;
    }
    for (const entry of this.runs.values()) {
      if (entry.runId === runId) return entry;
    }
    return null;
  }

  update(runId: string, workspaceId: string, meta: any) {
    const key = `${workspaceId}:${runId}`;
    const existing = this.runs.get(key);
    if (existing) {
      existing.meta = meta;
    }
  }

  private async scan() {
    this.runs.clear();
    const entries = await fs.readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(this.runsDir, entry.name);
      const workspaceRuns = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
      for (const runEntry of workspaceRuns) {
        if (!runEntry.isDirectory()) continue;
        await this.upsert(entry.name, path.join(candidate, runEntry.name));
      }
    }
  }

  private watch() {
    const watcher = chokidar.watch(path.join(this.runsDir, "**", "run.json"), {
      ignoreInitial: true
    });
    watcher.on("add", async (file) => this.refresh(file));
    watcher.on("change", async (file) => this.refresh(file));
    watcher.on("unlink", async (file) => this.remove(file));
  }

  private async refresh(filePath: string) {
    const runDir = path.dirname(filePath);
    const workspaceId = resolveWorkspaceIdFromRunDir(this.runsDir, runDir);
    if (!workspaceId) return;
    await this.upsert(workspaceId, runDir);
  }

  private remove(filePath: string) {
    const runDir = path.dirname(filePath);
    const workspaceId = resolveWorkspaceIdFromRunDir(this.runsDir, runDir);
    if (!workspaceId) return;
    const runId = path.basename(runDir);
    this.runs.delete(`${workspaceId}:${runId}`);
  }

  private async upsert(workspaceId: string, runDir: string) {
    const runPath = path.join(runDir, "run.json");
    const raw = await fs.readFile(runPath, "utf8").catch(() => null);
    if (!raw) return;
    try {
      const meta = JSON.parse(raw);
      const runId = meta.runId ?? path.basename(runDir);
      const key = `${workspaceId}:${runId}`;
      this.runs.set(key, {
        runId,
        runDir,
        workspaceId,
        meta: {
          ...meta,
          workspaceId: meta.workspaceId ?? workspaceId
        }
      });
    } catch {
      // ignore
    }
  }
}

function resolveWorkspaceIdFromRunDir(runsDir: string, runDir: string): string | null {
  const relative = path.relative(runsDir, runDir);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length >= 2) return parts[0]!;
  return null;
}

async function resolveWorkspacePath(rootDir: string, workspaceId?: string): Promise<string | null> {
  const workspaces = await loadWorkspaces(rootDir);
  if (workspaceId) {
    const match = workspaces.find((ws) => ws.id === workspaceId);
    return match?.path ?? null;
  }
  if (workspaces.length === 1) {
    const onlyWorkspace = workspaces[0];
    return onlyWorkspace ? onlyWorkspace.path : null;
  }
  return null;
}

async function recoverInterruptedRunsIndex(index: RunIndex) {
  const runs = index.list({ status: "running" });
  for (const run of runs) {
    if (!run.end) {
      run.status = "interrupted";
      run.interruptedAt = new Date().toISOString();
      run.end = run.end ?? run.interruptedAt;
      const record = index.get(run.runId, run.workspaceId);
      if (record) {
        await writeJson(path.join(record.runDir, "run.json"), run);
        index.update(run.runId, record.workspaceId, run);
      }
    }
  }
}

function getWorkspaceMetaDirForWrite(workspacePath: string): string {
  return path.join(workspacePath, ".orchestrum");
}

function resolveWorkspaceMetaDir(workspacePath: string, segments: string[] = []): string {
  return path.join(workspacePath, ".orchestrum", ...segments);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath || entryPath.endsWith("server.ts") || entryPath.endsWith("server.js")) {
  startService();
}
