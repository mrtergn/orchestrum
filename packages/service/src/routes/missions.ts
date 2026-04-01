import crypto from "node:crypto";
import type express from "express";
import {
  applySecretsToEnv,
  runBrowserRunDetailed,
  type BrowserRunOptions,
  type StateIndex
} from "@orchestrum/core";

type MissionAgentPlatform = {
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
  }): Promise<Record<string, unknown>>;
};

type LoggerLike = {
  info(event: string, payload?: Record<string, unknown>): Promise<unknown> | void;
  error(event: string, payload?: Record<string, unknown>): Promise<unknown> | void;
};

export function registerMissionRoutes(
  app: express.Express,
  options: {
    runsDir: string;
    stateIndex: StateIndex;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
    agentPlatform: MissionAgentPlatform;
    logger: LoggerLike;
    useKeychain: boolean;
  }
): void {
  const rebuildStateIndex = () => {
    void options.stateIndex.rebuild().catch(() => undefined);
  };

  const startMissionHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const missionTemplateId = String(req.body?.missionTemplateId ?? "");
    const goal = String(req.body?.userGoal ?? req.body?.goal ?? "");
    const startOptions = normalizeRunStartOptions(req.body?.options);
    if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
    if (!missionTemplateId) return res.status(400).json({ error: "missionTemplateId required" });

    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });

    await applySecretsToEnv({
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      scope: "global",
      passphrase: startOptions.passphrase,
      useKeychain: options.useKeychain
    });
    await applySecretsToEnv({
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      scope: "workspace",
      repoPath: workspacePath,
      passphrase: startOptions.passphrase,
      useKeychain: options.useKeychain
    });

    try {
      const runId = sanitizeRunId(req.body?.runId ? String(req.body.runId) : createServiceRunId("mission"));
      const result = await options.agentPlatform.startMission({
        runsDir: options.runsDir,
        workspaceId,
        repoPath: workspacePath,
        templateId: missionTemplateId,
        goal,
        runId,
        runOptions: {
          concurrency: startOptions.concurrency,
          modelOverrides: startOptions.modelOverrides,
          strategyMode: startOptions.strategyMode
        }
      });
      rebuildStateIndex();
      void options.logger.info("mission.start.accepted", { runId: result.runId, workspaceId, missionTemplateId });
      return res.json(result);
    } catch (err: any) {
      const message = String(err?.message ?? "Mission start failed");
      void options.logger.error("mission.start.failed", { workspaceId, missionTemplateId, message });
      return res.status(400).json({ ok: false, error: message });
    }
  };

  const startBrowserRunHandler = (kind: "qa" | "benchmark" | "canary") =>
    async (req: express.Request, res: express.Response) => {
      const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
      const runOptions = normalizeBrowserRunOptions(req.body?.options ?? req.body);
      if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
      const workspacePath = await options.resolveWorkspacePath(workspaceId);
      if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
      const runId = sanitizeRunId(req.body?.runId ? String(req.body.runId) : createServiceRunId());
      void runBrowserRunDetailed({
        kind,
        repoPath: workspacePath,
        runsDir: options.runsDir,
        workspaceId,
        runId,
        baseUrl: runOptions.baseUrl,
        targetPath: runOptions.targetPath,
        options: runOptions
      })
        .then(() => {
          rebuildStateIndex();
          void options.logger.info("browser.run.completed", { runId, workspaceId, kind });
        })
        .catch((err: any) => {
          rebuildStateIndex();
          void options.logger.error("browser.run.failed", {
            runId,
            workspaceId,
            kind,
            message: String(err?.message ?? err)
          });
        });
      return res.json({ ok: true, runId, kind });
    };

  app.post("/missions/start", startMissionHandler);
  app.post("/api/missions/start", startMissionHandler);
  app.post("/qa/run", startBrowserRunHandler("qa"));
  app.post("/qa/benchmark", startBrowserRunHandler("benchmark"));
  app.post("/qa/canary", startBrowserRunHandler("canary"));
}

function normalizeRunStartOptions(raw: unknown): {
  concurrency?: number;
  modelOverrides?: Record<string, string>;
  strategyMode?: string;
  passphrase?: string;
} {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const concurrencyRaw = typeof parsed.concurrency === "number" ? parsed.concurrency : Number(parsed.concurrency ?? NaN);
  const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
    ? Math.max(1, Math.floor(concurrencyRaw))
    : undefined;
  const strategyMode = typeof parsed.strategyMode === "string" && parsed.strategyMode.trim()
    ? parsed.strategyMode.trim()
    : undefined;
  const passphrase = typeof parsed.passphrase === "string" && parsed.passphrase.trim()
    ? parsed.passphrase
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
    strategyMode,
    passphrase
  };
}

function normalizeBrowserRunOptions(raw: unknown): BrowserRunOptions {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const baseUrl = typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : undefined;
  const targetPath = typeof parsed.targetPath === "string" && parsed.targetPath.trim() ? parsed.targetPath.trim() : undefined;
  const iterationsRaw = typeof parsed.iterations === "number" ? parsed.iterations : Number(parsed.iterations ?? NaN);
  const intervalRaw = typeof parsed.intervalMs === "number" ? parsed.intervalMs : Number(parsed.intervalMs ?? NaN);
  const passphrase = typeof parsed.passphrase === "string" && parsed.passphrase.trim() ? parsed.passphrase : undefined;
  const scenario = Array.isArray(parsed.scenario)
    ? parsed.scenario.filter((step): step is NonNullable<BrowserRunOptions["scenario"]>[number] => Boolean(step) && typeof step === "object" && typeof (step as { action?: unknown }).action === "string")
    : undefined;
  return {
    baseUrl,
    targetPath,
    iterations: Number.isFinite(iterationsRaw) && iterationsRaw > 0 ? Math.floor(iterationsRaw) : undefined,
    intervalMs: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.floor(intervalRaw) : undefined,
    passphrase,
    scenario
  };
}

function createServiceRunId(prefix = "run"): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${Date.now()}-${suffix}`;
}

function sanitizeRunId(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return createServiceRunId();
  return cleaned.slice(0, 100);
}
