import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import chokidar from "chokidar";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runWorkflow,
  resumeWorkflow,
  cancelRun,
  loadWorkspaces,
  addWorkspace,
  updateWorkspace,
  removeWorkspace,
  validateWorkspacePath,
  loadConfig,
  loadGlobalConfig,
  loadWorkspaceConfig,
  saveGlobalConfig,
  saveWorkspaceConfig,
  loadAnalytics,
  loadPromptHistory,
  loadOpportunities,
  generateOpportunities,
  loadRoadmap,
  loadWorkflow,
  migrateRuns,
  exportDiagnostics,
  writeCrashReport,
  runDoctor,
  exportTemplate,
  importTemplate,
  exportRunBundle,
  importRunBundle,
  checkForUpdates,
  installUpdate,
  getCurrentVersion,
  selectUpdateAsset,
  listInstalledPlugins,
  installPlugin,
  removePlugin,
  setPluginEnabled,
  loadWorkspaceProfile,
  saveWorkspaceProfile,
  listSecrets,
  setSecret,
  unsetSecret,
  getSecret,
  applySecretsToEnv,
  addWorkspaceApproval,
  runBrowserRunDetailed,
  loadLearnings,
  syncWorkspaceDocs,
  computeReleaseReadiness,
  StateIndex,
  discoverDeliverySetup,
  loadTeamPreset,
  saveTeamPreset,
  initTeamPreset,
  runDeliverySessionDetailed,
  loadDeliverySession,
  listDeliveryPackets,
  exportDeliveryPacket,
  analyzeDeliveryImport,
  importDeliveryPacketResponse,
  loadDeliveryFindings,
  loadDeliveryRemediations,
  Logger,
  readAppendedLines,
  readTailLines,
  recoverInterruptedRuns,
  getLicenseStatus,
  isFeatureAllowed,
  listMissionTemplates,
  missionGraphToStepStates,
  loadMissionRun,
  discoverMissionProviders,
  DEFAULT_SERVICE_PORT,
  type DeliveryTargetTool
} from "@orchestrum/core";
import { writeJson, writeText } from "@orchestrum/core";
import { AgentPlatform } from "./agentPlatform.js";

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

  app.get("/health", (_req, res) => {
    res.json({ ok: true, runsDir });
  });

  app.get("/meta/version", async (_req, res) => {
    const version = await getCurrentVersion(rootDir).catch(() => null);
    res.json({ version });
  });

  app.get("/meta/changelog", async (_req, res) => {
    const filePath = path.join(rootDir, "CHANGELOG.md");
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    res.json({ content });
  });

  app.get("/meta/eula", async (_req, res) => {
    const licensePath = path.join(rootDir, "LICENSE");
    const fallbackPath = path.join(rootDir, "EULA.md");
    const content =
      (await fs.readFile(licensePath, "utf8").catch(() => "")) ||
      (await fs.readFile(fallbackPath, "utf8").catch(() => ""));
    res.json({ content });
  });

  app.get("/meta/about", async (_req, res) => {
    const version = await getCurrentVersion(rootDir).catch(() => null);
    res.json({ version, edition: "Open Source", license: { name: "MIT" } });
  });

  app.get("/updates/status", async (req, res) => {
    try {
      const remote =
        req.query.remote === "1" ||
        req.query.remote === "true";
      const repo = req.query.repo ? String(req.query.repo) : undefined;
      const status = await checkForUpdates({ rootDir, remote, repo });
      res.json(status);
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Update check failed" });
    }
  });

  app.post("/updates/install", async (req, res) => {
    const filePath = req.body?.file ? String(req.body.file) : "";
    const data = req.body?.data ? String(req.body.data) : "";
    const remote = Boolean(req.body?.remote);
    const repo = req.body?.repo ? String(req.body.repo) : undefined;
    const assetUrl = req.body?.url ? String(req.body.url) : "";
    const expectedSha256 = req.body?.sha256 ? String(req.body.sha256) : undefined;
    const assetName = req.body?.assetName ? String(req.body.assetName) : undefined;
    let archivePath = filePath;
    if (!archivePath && data) {
      const tempDir = path.join(os.tmpdir(), `orchestrum-update-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
      archivePath = path.join(tempDir, "update.tar.gz");
      await fs.writeFile(archivePath, Buffer.from(data, "base64"));
    }
    try {
      if (!archivePath && !assetUrl && remote) {
        const status = await checkForUpdates({ rootDir, remote: true, repo });
        if (!status.available || !status.updateAvailable) {
          return res.status(400).json({ error: status.reason ?? "No update available." });
        }
        const asset =
          status.selectedAsset ??
          selectUpdateAsset(status.available, {
            platform: process.platform,
            arch: process.arch,
            kind: "archive"
          });
        if (!asset) {
          return res.status(400).json({ error: "No installable archive asset found for this platform." });
        }
        const result = await installUpdate({
          downloadUrl: asset.url,
          expectedSha256: asset.sha256,
          assetName: asset.name,
          targetDir: rootDir
        });
        return res.json({ ...result, version: status.available.version, asset, releaseUrl: status.available.releaseUrl });
      }

      if (!archivePath && !assetUrl) {
        return res.status(400).json({ error: "file, data, or url required" });
      }

      const result = await installUpdate({
        archivePath,
        downloadUrl: assetUrl || undefined,
        expectedSha256,
        assetName,
        targetDir: rootDir
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Update install failed" });
    }
  });

  const useKeychain = process.env.ORCHESTRUM_USE_KEYCHAIN === "1";

  const workspaceListRoutes = ["/workspaces", "/api/workspaces"] as const;
  for (const route of workspaceListRoutes) {
    app.get(route, async (_req, res) => {
      const workspaces = await loadWorkspaces(rootDir);
      const enriched = await Promise.all(workspaces.map((workspace) => buildWorkspaceSummary(workspace, runIndex)));
      res.json({ workspaces: enriched });
    });

    app.post(route, async (req, res) => {
      const workspacePath = String(req.body?.path ?? "");
      const id = req.body?.id ? String(req.body.id) : undefined;
      const name = req.body?.name ? String(req.body.name) : undefined;
      if (!workspacePath) return res.status(400).json({ error: "path required" });
      try {
        const workspace = await addWorkspace(rootDir, workspacePath, { id, name });
        const summary = await buildWorkspaceSummary(workspace, runIndex);
        res.json({ workspace: summary });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "Failed to add workspace." });
      }
    });
  }

  const workspaceItemRoutes = ["/workspaces/:id", "/api/workspaces/:id"] as const;
  for (const route of workspaceItemRoutes) {
    app.patch(route, async (req, res) => {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const workspace = await updateWorkspace(rootDir, req.params.id, { name });
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const summary = await buildWorkspaceSummary(workspace, runIndex);
      res.json({ workspace: summary });
    });

    app.delete(route, async (req, res) => {
      const removed = await removeWorkspace(rootDir, req.params.id);
      if (!removed) return res.status(404).json({ error: "Workspace not found" });
      res.json({ ok: true, workspace: removed });
    });
  }

  const workspaceGitRoutes = ["/workspaces/:id/git/init", "/api/workspaces/:id/git/init"] as const;
  for (const route of workspaceGitRoutes) {
    app.post(route, async (req, res) => {
      const workspacePath = await resolveWorkspacePath(rootDir, req.params.id);
      if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
      try {
        await initializeGitRepo(workspacePath);
        const validation = await validateWorkspacePath(workspacePath);
        res.json({ ok: true, validation });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "Failed to initialize git repository." });
      }
    });
  }

  const secretsListRoutes = ["/secrets", "/api/secrets"] as const;
  for (const route of secretsListRoutes) {
    app.get(route, async (req, res) => {
      const scope = req.query.scope === "workspace" ? "workspace" : "global";
      const workspacePath =
        scope === "workspace" ? await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined) : null;
      if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
      const names = await listSecrets(scope, workspacePath ?? undefined);
      const keysToReport = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
      const keyStatus: Record<string, boolean> = {};
      for (const keyName of keysToReport) {
        const hasStoredName = names.includes(keyName);
        const hasEnv = Boolean(process.env[keyName]);
        const value = await getSecret({
          name: keyName,
          scope,
          repoPath: workspacePath ?? undefined,
          useKeychain
        }).catch(() => null);
        keyStatus[keyName] = hasStoredName || hasEnv || Boolean(value);
      }
      res.json({
        scope,
        keys: keyStatus,
        names,
        keychainEnabled: useKeychain,
        encryptionMode: useKeychain ? "os-keychain" : "encrypted-file"
      });
    });
  }

  const setSecretRoutes = ["/secrets", "/api/secrets/set"] as const;
  for (const route of setSecretRoutes) {
    app.post(route, async (req, res) => {
      const scope = req.body?.scope === "workspace" ? "workspace" : "global";
      const keyName = String(req.body?.keyName ?? req.body?.name ?? "");
      const value = String(req.body?.value ?? "");
      const passphrase = req.body?.passphrase ? String(req.body.passphrase) : undefined;
      const workspacePath = scope === "workspace" ? await resolveWorkspacePath(rootDir, req.body?.workspaceId) : null;
      if (!keyName || !value) return res.status(400).json({ error: "keyName and value required" });
      if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
      try {
        await setSecret({
          name: keyName,
          value,
          scope,
          repoPath: workspacePath ?? undefined,
          passphrase,
          useKeychain
        });
        res.json({ ok: true });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "Failed to set secret" });
      }
    });
  }

  const unsetSecretRoutes = ["/secrets/unset", "/api/secrets/unset"] as const;
  for (const route of unsetSecretRoutes) {
    app.post(route, async (req, res) => {
      const scope = req.body?.scope === "workspace" ? "workspace" : "global";
      const keyName = String(req.body?.keyName ?? req.body?.name ?? "");
      const passphrase = req.body?.passphrase ? String(req.body.passphrase) : undefined;
      const workspacePath = scope === "workspace" ? await resolveWorkspacePath(rootDir, req.body?.workspaceId) : null;
      if (!keyName) return res.status(400).json({ error: "keyName required" });
      if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
      try {
        await unsetSecret({
          name: keyName,
          scope,
          repoPath: workspacePath ?? undefined,
          passphrase,
          useKeychain
        });
        res.json({ ok: true });
      } catch (err: any) {
        res.status(400).json({ error: err?.message ?? "Failed to unset secret" });
      }
    });
  }

  app.post("/api/secrets/test", async (req, res) => {
    const provider = String(req.body?.vendor ?? req.body?.provider ?? "openai").toLowerCase();
    const transport = req.body?.transport ? String(req.body.transport).toLowerCase() : (provider === "openai" ? "api" : provider === "claude" ? "api" : "cli");
    const scope = req.body?.scope === "workspace" ? "workspace" : "global";
    const workspacePath = scope === "workspace" ? await resolveWorkspacePath(rootDir, req.body?.workspaceId) : null;
    if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const passphrase = req.body?.passphrase ? String(req.body.passphrase) : undefined;
    if (transport !== "api") {
      const discovery = await buildProviderDiscovery({
        rootDir,
        workspacePath: workspacePath ?? undefined,
        scope,
        passphrase,
        useKeychain
      });
      const record = discovery.find((entry) => entry.vendor === provider);
      const match = record?.transports.find((entry) => entry.transport === transport);
      if (!match) {
        return res.status(400).json({ ok: false, error: `Unsupported provider transport: ${provider}/${transport}` });
      }
      if (!match.available) {
        return res.status(400).json({ ok: false, provider, transport, error: match.reason ?? "Provider transport is unavailable." });
      }
      if (!match.configured) {
        return res.status(400).json({ ok: false, provider, transport, error: match.reason ?? "Provider transport is not configured." });
      }
      return res.json({
        ok: true,
        provider,
        transport,
        model: match.profiles.find((profile) => profile.recommended)?.model ?? match.models?.[0] ?? undefined
      });
    }
    const secretName =
      provider === "claude"
        ? "ANTHROPIC_API_KEY"
        : provider === "openai"
          ? "OPENAI_API_KEY"
          : "";
    if (!secretName) {
      return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }
    const apiKey = await getSecret({
      name: secretName,
      scope,
      repoPath: workspacePath ?? undefined,
      passphrase,
      useKeychain
    }).catch(() => null);
    if (!apiKey) {
      return res.status(400).json({ ok: false, error: `${secretName} is not configured.` });
    }
    const testResult = provider === "claude"
      ? await testClaudeConnection(apiKey)
      : await testOpenAiConnection(apiKey);
    if (!testResult.ok) {
      return res.status(400).json(testResult);
    }
    res.json(testResult);
  });

  app.get("/api/providers/discover", async (req, res) => {
    const scope = req.query.scope === "workspace" ? "workspace" : "global";
    const workspacePath = scope === "workspace" ? await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined) : null;
    if (scope === "workspace" && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const discovery = await buildProviderDiscovery({
      rootDir,
      workspacePath: workspacePath ?? undefined,
      scope,
      useKeychain
    });
    res.json({ providers: discovery });
  });

  app.get("/plugins", async (_req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    const plugins = await listInstalledPlugins();
    res.json({ plugins, tier });
  });

  app.post("/plugins/install", async (req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    if (!isFeatureAllowed(tier, "plugins")) {
      return res.status(403).json({ error: "Plugins require Studio tier." });
    }
    const pluginPath = String(req.body?.path ?? "");
    if (!pluginPath) return res.status(400).json({ error: "path required" });
    try {
      const plugin = await installPlugin(pluginPath);
      res.json({ plugin });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Plugin install failed" });
    }
  });

  app.post("/plugins/enable", async (req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    if (!isFeatureAllowed(tier, "plugins")) {
      return res.status(403).json({ error: "Plugins require Studio tier." });
    }
    const name = String(req.body?.name ?? "");
    const enabled = Boolean(req.body?.enabled);
    if (!name) return res.status(400).json({ error: "name required" });
    try {
      await setPluginEnabled(name, enabled);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Plugin update failed" });
    }
  });

  app.post("/plugins/remove", async (req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    if (!isFeatureAllowed(tier, "plugins")) {
      return res.status(403).json({ error: "Plugins require Studio tier." });
    }
    const name = String(req.body?.name ?? "");
    if (!name) return res.status(400).json({ error: "name required" });
    await removePlugin(name);
    res.json({ ok: true });
  });

  app.get("/workspaces", async (_req, res) => {
    const workspaces = await loadWorkspaces(rootDir);
    res.json({ workspaces });
  });

  app.post("/workspaces", async (req, res) => {
    const workspacePath = String(req.body?.path ?? "");
    const id = req.body?.id ? String(req.body.id) : undefined;
    if (!workspacePath) return res.status(400).json({ error: "path required" });
    try {
      const ws = await addWorkspace(rootDir, workspacePath, id);
      res.json(ws);
    } catch (err: any) {
      res.status(403).json({ error: err?.message ?? "Workspace limit reached." });
    }
  });

  app.get("/runs", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const tag = req.query.tag ? String(req.query.tag) : undefined;
    const search = req.query.search ? String(req.query.search).toLowerCase() : undefined;
    const runs = runIndex.list({ workspaceId, status, tag, search });
    res.json(runs);
  });

  app.get("/runs/recovery", async (_req, res) => {
    const runs = runIndex.list({ status: "interrupted" });
    res.json({ runs });
  });

  const startRunHandler = async (_req: express.Request, res: express.Response) => {
    return res.status(410).json({
      ok: false,
      error: "Workflow execution was removed. Use POST /missions/start with missionTemplateId."
    });
  };

  const startMissionHandler = async (req: express.Request, res: express.Response) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const missionTemplateId = String(req.body?.missionTemplateId ?? "");
    const goal = String(req.body?.userGoal ?? req.body?.goal ?? "");
    const options = normalizeRunStartOptions(req.body?.options);
    if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
    if (!missionTemplateId) return res.status(400).json({ error: "missionTemplateId required" });

    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });

    await applySecretsToEnv({
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      scope: "global",
      passphrase: options.passphrase,
      useKeychain
    });
    await applySecretsToEnv({
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      scope: "workspace",
      repoPath: workspacePath,
      passphrase: options.passphrase,
      useKeychain
    });

    try {
      const runId = sanitizeRunId(req.body?.runId ? String(req.body.runId) : createServiceRunId("mission"));
      const result = await agentPlatform.startMission({
        runsDir,
        workspaceId,
        repoPath: workspacePath,
        templateId: missionTemplateId,
        goal,
        runId
      });
      void stateIndex.rebuild().catch(() => undefined);
      void logger.info("mission.start.accepted", { runId: result.runId, workspaceId, missionTemplateId });
      return res.json(result);
    } catch (err: any) {
      const message = String(err?.message ?? "Mission start failed");
      void logger.error("mission.start.failed", { workspaceId, missionTemplateId, message });
      return res.status(400).json({ ok: false, error: message });
    }
  };

  const startBrowserRunHandler = (kind: "qa" | "benchmark" | "canary") =>
    async (req: express.Request, res: express.Response) => {
      const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
      const options = normalizeBrowserRunOptions(req.body?.options ?? req.body);
      if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
      const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
      if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
      const runId = sanitizeRunId(req.body?.runId ? String(req.body.runId) : createServiceRunId());
      void runBrowserRunDetailed({
        kind,
        repoPath: workspacePath,
        runsDir,
        workspaceId,
        runId,
        baseUrl: options.baseUrl,
        targetPath: options.targetPath,
        options
      })
        .then(() => {
          void stateIndex.rebuild().catch(() => undefined);
          void logger.info("browser.run.completed", { runId, workspaceId, kind });
        })
        .catch((err: any) => {
          void stateIndex.rebuild().catch(() => undefined);
          void logger.error("browser.run.failed", { runId, workspaceId, kind, message: String(err?.message ?? err) });
        });
      return res.json({ ok: true, runId, kind });
    };

  app.post("/runs/start", startRunHandler);
  app.post("/api/runs/start", startRunHandler);
  app.post("/missions/start", startMissionHandler);
  app.post("/api/missions/start", startMissionHandler);
  app.post("/qa/run", startBrowserRunHandler("qa"));
  app.post("/qa/benchmark", startBrowserRunHandler("benchmark"));
  app.post("/qa/canary", startBrowserRunHandler("canary"));

  app.get("/logs/service", async (req, res) => {
    const tailRaw = req.query.tail ? Number(req.query.tail) : 200;
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? tailRaw : 200;
    const logPath = path.join(rootDir, "logs", "service.ndjson");
    const lines = fsSync.existsSync(logPath) ? await readTailLines(logPath, tail) : [];
    res.json({ lines });
  });

  app.get("/runs/:id/logs", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const tailRaw = req.query.tail ? Number(req.query.tail) : 200;
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? tailRaw : 200;
    const run = runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const logPath = resolveRunLogPath(run.runDir, run.meta);
    const lines = fsSync.existsSync(logPath) ? await readTailLines(logPath, tail) : [];
    res.json({ lines });
  });

  app.get("/runs/:id", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const detail = await buildRunDetail(run);
    res.json(detail);
  });

  app.patch("/runs/:id", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const run = runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const { pinned, tags } = req.body ?? {};
    const updated = { ...run.meta };
    if (typeof pinned === "boolean") updated.pinned = pinned;
    if (Array.isArray(tags)) updated.tags = tags.map((t: any) => String(t));
    await writeJson(path.join(run.runDir, "run.json"), updated);
    runIndex.update(run.runId, run.workspaceId, updated);
    res.json(updated);
  });

  app.get("/runs/:id/steps", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const steps = await loadRunSteps(run);
    res.json(steps);
  });

  app.get("/runs/:id/steps/:stepId/artifacts", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const stepPath = getRunStepDir(run, req.params.stepId);
    const files = await listArtifacts(stepPath);
    res.json({ files });
  });

  app.get("/runs/:id/steps/:stepId/artifacts/*", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const run = runIndex.get(req.params.id, workspaceId);
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
    const run = runIndex.get(req.params.id, workspaceId);
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
      const runs = runIndex.list().slice(0, 100);
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
          sendEvent("run:finished", {
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
    const run = runIndex.get(runId, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (isMissionRunMeta(run.meta)) {
      const result = await agentPlatform.resumeMission({
        runsDir,
        workspaceId: run.workspaceId,
        runId
      });
      return res.json({ ok: result.ok, fromStepId: inferMissionResumeNodeId(run.meta) ?? undefined });
    }
    const requestedFrom = req.body?.fromStepId ? String(req.body.fromStepId) : "";
    const fromStepId = requestedFrom || (await inferResumeStepId(run.runDir));
    if (!fromStepId) return res.status(400).json({ error: "Unable to infer resume step. Provide fromStepId." });
    const ok = await resumeWorkflow({
      runId,
      runsDir,
      fromStepId,
      workspaceId: run.workspaceId
    });
    res.json({ ok, fromStepId });
  };

  const cancelRunHandler = async (req: express.Request, res: express.Response) => {
    const runId = String(req.params.id ?? "");
    if (!runId) return res.status(400).json({ error: "run id required" });
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const run = runIndex.get(runId, workspaceId);
    if (run && isMissionRunMeta(run.meta)) {
      const updated = {
        ...run.meta,
        status: "cancelled",
        end: run.meta?.end ?? new Date().toISOString()
      };
      await writeJson(path.join(run.runDir, "run.json"), updated);
      runIndex.update(run.runId, run.workspaceId, updated);
      void stateIndex.rebuild().catch(() => undefined);
      return res.json({ ok: true });
    }
    await cancelRun(runsDir, runId, workspaceId);
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
        runsDir,
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
      const result = await importRunBundle({ archivePath, runsDir });
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
    const run = runIndex.get(req.params.id, workspaceId);
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
    void stateIndex.rebuild().catch(() => undefined);
    res.json({ ok: true });
  });

  app.post("/runs/:id/nodes/:nodeId/import", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const targetTool = typeof req.body?.targetTool === "string" ? req.body.targetTool : undefined;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
    if (!text.trim()) return res.status(400).json({ error: "text required" });
    const run = runIndex.get(req.params.id, workspaceId);
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (!isMissionRunMeta(run.meta)) {
      return res.status(400).json({ error: "Node imports are only supported for mission runs." });
    }
    try {
      const missionRun = await agentPlatform.importMissionNode({
        runsDir,
        workspaceId,
        runId: req.params.id,
        nodeId: req.params.nodeId,
        text,
        targetTool
      });
      runIndex.update(run.runId, run.workspaceId, missionRun);
      void stateIndex.rebuild().catch(() => undefined);
      res.json({ ok: true, run: missionRun });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Mission node import failed." });
    }
  });

  app.get("/analytics", async (req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    if (!isFeatureAllowed(tier, "analytics")) {
      return res.status(403).json({ error: "Analytics requires Pro tier." });
    }
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.json({ analytics: null });
    let analytics = await loadAnalytics(workspacePath);
    if (!analytics || analytics.runs === 0) {
      const runs = await stateIndex.queryRuns(workspaceId).catch(() => []);
      analytics = {
        runs: runs.length,
        successes: runs.filter((run) => run.status === "finished").length,
        failures: runs.filter((run) => run.status === "failed").length,
        totalCost: 0,
        costPerFeature: 0,
        perAgent: {},
        loopCounts: { total: 0, avg: 0 },
        failureTypes: { policy: 0, audit: 0, test: 0, security: 0 },
        trends: { cost: [], successRate: [], loops: [], reward: [] },
        testStability: { total: 0, failed: 0, index: 0 },
        modelUsage: {}
      };
    }
    res.json({ analytics });
  });

  app.get("/prompts", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.json({ prompts: {} });
    const data = await loadPromptHistory(workspacePath);
    res.json(data);
  });

  app.post("/prompts/approve", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const { promptPath, suggestionId } = req.body ?? {};
    await (await import("@orchestrum/core")).approvePromptSuggestion({
      workspacePath,
      promptPath,
      suggestionId
    });
    res.json({ ok: true });
  });

  app.post("/prompts/reject", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const { promptPath, suggestionId } = req.body ?? {};
    await (await import("@orchestrum/core")).rejectPromptSuggestion({
      workspacePath,
      promptPath,
      suggestionId
    });
    res.json({ ok: true });
  });

  app.post("/prompts/rollback", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const { promptPath, versionId } = req.body ?? {};
    await (await import("@orchestrum/core")).rollbackPromptVersion({
      workspacePath,
      promptPath,
      versionId
    });
    res.json({ ok: true });
  });

  app.get("/opportunities", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.json({ opportunities: [] });
    const opportunities = await loadOpportunities(workspacePath);
    res.json({ opportunities });
  });

  app.post("/opportunities/run", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const workspaceId = String(req.body?.workspaceId ?? "");
    const goal = req.body?.title ?? "Improve project";
    try {
      const result = await agentPlatform.startMission({
        runsDir,
        workspaceId,
        repoPath: workspacePath,
        templateId: "feature-dev",
        goal
      });
      void stateIndex.rebuild().catch(() => undefined);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? "Mission start failed" });
    }
  });

  app.get("/roadmap", async (req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    if (!isFeatureAllowed(tier, "roadmap")) {
      return res.status(403).json({ error: "Roadmap requires Pro tier." });
    }
    const workspacePath = await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.json({ roadmap: [] });
    const data = await loadRoadmap(workspacePath);
    res.json(data);
  });

  app.get("/tournaments", async (req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    if (!isFeatureAllowed(tier, "tournament")) {
      return res.status(403).json({ error: "Tournament requires Studio tier." });
    }
    const workspacePath = await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.json({ tournaments: [] });
    const filePath = path.join(workspacePath, ".memory", "tournaments.json");
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const data = raw ? JSON.parse(raw) : [];
    res.json({ tournaments: Array.isArray(data) ? data : [] });
  });

  app.get("/experiments", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : "default";
    const experimentsDir = path.join(runsDir, workspaceId, "experiments");
    const entries = await fs.readdir(experimentsDir, { withFileTypes: true }).catch(() => []);
    const experiments: any[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(experimentsDir, entry.name);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        experiments.push(JSON.parse(raw));
      } catch {
        // ignore
      }
    }
    experiments.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json({ experiments });
  });

  app.get("/evaluations", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.json({ evaluations: [] });
    const filePath = path.join(workspacePath, ".memory", "evaluations.json");
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const data = raw ? JSON.parse(raw) : [];
    res.json({ evaluations: Array.isArray(data) ? data : [] });
  });

  app.get("/config", async (req, res) => {
    const scope = (req.query.scope as string) ?? "workspace";
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    if (scope === "global") {
      const config = await loadGlobalConfig();
      return res.json({ config, scope });
    }
    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const config = await loadWorkspaceConfig(workspacePath);
    res.json({ config, scope: "workspace" });
  });

  app.get("/profile", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const profile = await loadWorkspaceProfile(workspacePath).catch(() => null);
    res.json({ profile });
  });

  app.put("/profile", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    await saveWorkspaceProfile(workspacePath, req.body?.profile ?? {});
    res.json({ ok: true });
  });

  app.get("/capabilities", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const result = await discoverDeliverySetup({ repoPath: workspacePath, workspaceId });
    res.json(result);
  });

  app.get("/team-preset", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const discovered = await discoverDeliverySetup({ repoPath: workspacePath, workspaceId });
    res.json({
      workspaceId,
      repoPath: workspacePath,
      path: path.join(workspacePath, ".orchestrum", "team-preset.json"),
      preset: discovered.preset,
      scaffoldPreset: discovered.scaffoldPreset,
      capabilities: discovered.capabilities,
      suggestedBindings: discovered.suggestedBindings
    });
  });

  app.put("/team-preset", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const preset = await saveTeamPreset(workspacePath, req.body?.preset ?? {});
    const discovered = await discoverDeliverySetup({ repoPath: workspacePath, workspaceId });
    res.json({
      workspaceId,
      repoPath: workspacePath,
      path: path.join(workspacePath, ".orchestrum", "team-preset.json"),
      preset,
      scaffoldPreset: discovered.scaffoldPreset,
      capabilities: discovered.capabilities,
      suggestedBindings: discovered.suggestedBindings
    });
  });

  app.post("/team-preset/init", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const result = await initTeamPreset({
      repoPath: workspacePath,
      workspaceId,
      force: Boolean(req.body?.force)
    });
    res.json(result);
  });

  app.get("/config/merged", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const config = await loadConfig(workspacePath);
    res.json({ config });
  });

  app.put("/config", async (req, res) => {
    const scope = (req.body?.scope as string) ?? "workspace";
    if (scope === "global") {
      await saveGlobalConfig(req.body?.config ?? {});
      return res.json({ ok: true });
    }
    const workspacePath = await resolveWorkspacePath(rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    await saveWorkspaceConfig(workspacePath, req.body?.config ?? {});
    res.json({ ok: true });
  });

  app.get("/templates", async (req, res) => {
    res.json({ templates: listMissionTemplates() });
  });

  app.post("/templates/clone", async (req, res) => {
    res.status(410).json({ error: "Mission templates are built-in. Template cloning was removed." });
  });

  app.post("/templates/export", async (req, res) => {
    res.status(410).json({ error: "Mission templates are built-in. Template export was removed." });
  });

  app.post("/templates/import", async (req, res) => {
    res.status(410).json({ error: "Template import was removed with mission template unification." });
  });

  app.post("/diagnostics/export", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const runId = req.body?.runId ? String(req.body.runId) : undefined;
    const archive = await exportDiagnostics({
      rootDir,
      runsDir,
      workspaceId,
      runId
    });
    res.json({ archive });
  });

  app.get("/doctor", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const repoPath = await resolveWorkspacePath(rootDir, workspaceId);
    await stateIndex.health();
    const report = await runDoctor({
      rootDir,
      runsDir,
      workspaceId,
      repoPath: repoPath ?? undefined
    });
    res.json(report);
  });

  app.get("/learnings", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const repoPath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!repoPath) return res.json({ workspaceId, learnings: [] });
    const learnings = await loadLearnings(repoPath).catch(() => []);
    res.json({ workspaceId, learnings });
  });

  app.post("/docs/sync", async (req, res) => {
    const workspacePath = await resolveWorkspacePath(rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const payload = await syncWorkspaceDocs(workspacePath);
    void stateIndex.rebuild().catch(() => undefined);
    res.json(payload);
  });

  app.get("/release/readiness", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await resolveWorkspacePath(rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    await stateIndex.rebuild().catch(() => undefined);
    const readiness = await computeReleaseReadiness({
      workspacePath,
      runsDir,
      workspaceId
    });
    const indexed = await stateIndex.getLatestReadiness(workspaceId).catch(() => null);
    if (indexed?.runId && !readiness.latestRunId) {
      readiness.latestRunId = indexed.runId;
    }
    res.json(readiness);
  });

  app.post("/delivery/start", async (req, res) => {
    res.status(410).json({
      error: "Standalone delivery sessions were removed. Start the delivery-sprint mission with POST /missions/start."
    });
  });

  app.get("/delivery/summary", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    await stateIndex.health();
    const summary = await stateIndex.getDeliverySummary(workspaceId);
    res.json(summary);
  });

  app.get("/delivery/:id", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const session = await loadDeliverySession({ runsDir, runId: req.params.id, workspaceId });
    if (!session) return res.status(404).json({ error: "Delivery session not found" });
    res.json(session);
  });

  app.get("/delivery/:id/packets", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const packets = await listDeliveryPackets({ runsDir, runId: req.params.id, workspaceId });
    res.json({ packets });
  });

  app.get("/delivery/:id/packets/:packetId/export", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const target = req.query.target ? String(req.query.target) : "";
    if (!target) return res.status(400).json({ error: "target query param is required" });
    try {
      const exported = await exportDeliveryPacket({
        runsDir,
        runId: req.params.id,
        workspaceId,
        packetId: req.params.packetId,
        targetTool: target as DeliveryTargetTool
      });
      void stateIndex.rebuild().catch(() => undefined);
      res.json(exported);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Packet export failed." });
    }
  });

  app.post("/delivery/:id/import", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    let text = typeof req.body?.text === "string" ? req.body.text : "";
    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName : undefined;
    const targetTool = typeof req.body?.targetTool === "string" ? req.body.targetTool : undefined;
    if (!text && typeof req.body?.data === "string" && req.body.data.trim()) {
      text = Buffer.from(String(req.body.data), "base64").toString("utf8");
    }
    try {
      const result = await analyzeDeliveryImport({
        runsDir,
        runId: req.params.id,
        workspaceId,
        text,
        fileName,
        targetTool: targetTool as DeliveryTargetTool | undefined,
        source: fileName ? "file" : "paste",
        recordAttempt: true
      });
      void stateIndex.rebuild().catch(() => undefined);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Delivery import analysis failed." });
    }
  });

  app.post("/delivery/:id/packets/:packetId/import", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    let text = typeof req.body?.text === "string" ? req.body.text : "";
    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName : undefined;
    const targetTool = typeof req.body?.targetTool === "string" ? req.body.targetTool : undefined;
    if (!text && typeof req.body?.data === "string" && req.body.data.trim()) {
      text = Buffer.from(String(req.body.data), "base64").toString("utf8");
    }
    try {
      const result = await importDeliveryPacketResponse({
        runsDir,
        runId: req.params.id,
        workspaceId,
        packetId: req.params.packetId,
        text,
        fileName,
        targetTool: targetTool as DeliveryTargetTool | undefined,
        source: fileName ? "file" : "paste"
      });
      void stateIndex.rebuild().catch(() => undefined);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Packet import failed." });
    }
  });

  app.get("/delivery/:id/findings", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const findings = await loadDeliveryFindings({ runsDir, runId: req.params.id, workspaceId });
    res.json({ findings });
  });

  app.get("/delivery/:id/remediations", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const remediations = await loadDeliveryRemediations({ runsDir, runId: req.params.id, workspaceId });
    res.json({ remediations });
  });

  app.post("/run", async (req, res) => {
    res.status(410).json({
      ok: false,
      error: "Workflow execution was removed. Use POST /missions/start with missionTemplateId."
    });
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

async function buildWorkspaceSummary(
  workspace: { id: string; path: string; name?: string; createdAt?: string; updatedAt?: string },
  runIndex: RunIndex
) {
  const validation = await validateWorkspacePath(workspace.path);
  const runs = runIndex.list({ workspaceId: workspace.id });
  const latest = runs[0] ?? null;
  const lastRun = latest
    ? {
        runId: String(latest.runId ?? ""),
        status: String(latest.status ?? ""),
        start: String(latest.start ?? ""),
        end: latest.end ? String(latest.end) : null
      }
    : null;
  const status = !validation.exists || !validation.readable || !validation.isDirectory
    ? "invalid"
    : (lastRun?.status ?? "idle");
  return {
    ...workspace,
    validation,
    status,
    lastRun
  };
}

async function initializeGitRepo(repoPath: string): Promise<void> {
  const validation = await validateWorkspacePath(repoPath);
  if (!validation.exists || !validation.readable || !validation.isDirectory) {
    throw new Error(validation.error ?? "Workspace path is invalid.");
  }
  if (validation.isGitRepo) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init"], {
      cwd: repoPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git init failed with exit code ${code ?? -1}`));
      }
    });
  });
}

function normalizeRunStartOptions(raw: unknown): {
  sandboxEnabled: boolean;
  concurrency?: number;
  modelOverrides?: Record<string, string>;
  strategyMode?: string;
  passphrase?: string;
} {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sandboxEnabled = parsed.sandbox !== false;
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
    sandboxEnabled,
    concurrency,
    modelOverrides: Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined,
    strategyMode,
    passphrase
  };
}

function isMissionRunMeta(run: any): run is {
  kind: "mission";
  end?: string | null;
  graph: {
    templateId: string;
    name: string;
    description: string;
    nodes: any[];
  };
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

async function loadRunSteps(run: RunRecord) {
  if (isMissionRunMeta(run.meta)) {
    return missionGraphToStepStates(run.meta.graph);
  }
  return loadStepStatesFromDir(path.join(run.runDir, "steps"));
}

function getRunStepDir(run: RunRecord, stepId: string): string {
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

function normalizeBrowserRunOptions(raw: unknown): {
  baseUrl?: string;
  targetPath?: string;
  iterations?: number;
  intervalMs?: number;
  passphrase?: string;
} {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const baseUrl = typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : undefined;
  const targetPath = typeof parsed.targetPath === "string" && parsed.targetPath.trim() ? parsed.targetPath.trim() : undefined;
  const iterationsRaw = typeof parsed.iterations === "number" ? parsed.iterations : Number(parsed.iterations ?? NaN);
  const intervalRaw = typeof parsed.intervalMs === "number" ? parsed.intervalMs : Number(parsed.intervalMs ?? NaN);
  const passphrase = typeof parsed.passphrase === "string" && parsed.passphrase.trim() ? parsed.passphrase : undefined;
  return {
    baseUrl,
    targetPath,
    iterations: Number.isFinite(iterationsRaw) && iterationsRaw > 0 ? Math.floor(iterationsRaw) : undefined,
    intervalMs: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.floor(intervalRaw) : undefined,
    passphrase
  };
}

async function resolveWorkflowPath(workspacePath: string, workflowId: string, rootDir: string): Promise<string | null> {
  const trimmed = workflowId.trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  if (path.isAbsolute(trimmed)) {
    candidates.push(path.resolve(trimmed));
  } else {
    candidates.push(path.resolve(workspacePath, trimmed));
    candidates.push(path.join(workspacePath, ".orchestrum", "workflows", trimmed));
    if (!trimmed.endsWith(".yaml") && !trimmed.endsWith(".yml")) {
      candidates.push(path.join(workspacePath, ".orchestrum", "workflows", `${trimmed}.yaml`));
    }
    candidates.push(path.join(rootDir, "packages", "core", "workflows", "templates", trimmed));
    candidates.push(path.join(rootDir, "packages", "core", "workflows", trimmed));
    if (!trimmed.endsWith(".yaml") && !trimmed.endsWith(".yml")) {
      candidates.push(path.join(rootDir, "packages", "core", "workflows", "templates", `${trimmed}.yaml`));
      candidates.push(path.join(rootDir, "packages", "core", "workflows", `${trimmed}.yaml`));
    }
  }
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
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

async function writeRunBootstrapFailure(options: {
  runsDir: string;
  workspaceId: string;
  runId: string;
  repoPath: string;
  workflowPath: string;
  userGoal: string;
  error: string;
}): Promise<void> {
  const runDir = path.join(options.runsDir, options.workspaceId, options.runId);
  await fs.mkdir(runDir, { recursive: true });
  const now = new Date().toISOString();
  await writeJson(path.join(runDir, "run.json"), {
    runId: options.runId,
    kind: "workflow",
    status: "failed",
    start: now,
    end: now,
    goal: options.userGoal,
    userGoal: options.userGoal,
    repoPath: options.repoPath,
    workflow: options.workflowPath,
    workspaceId: options.workspaceId,
    workspacePath: options.repoPath,
    error: options.error,
    totalSteps: 0,
    completedSteps: 0,
    worktreePath: null,
    readiness: null,
    pinned: false,
    tags: []
  });
  const event = JSON.stringify({
    t: "run.failed",
    runId: options.runId,
    error: options.error,
    ts: Date.now()
  });
  await fs.writeFile(path.join(runDir, "events.ndjson"), `${event}\n`, { flag: "a" });
}

async function inferResumeStepId(runDir: string): Promise<string | null> {
  const runMetaRaw = await fs.readFile(path.join(runDir, "run.json"), "utf8").catch(() => "");
  const runMeta = runMetaRaw ? (JSON.parse(runMetaRaw) as { workflow?: string }) : null;
  const ordered = runMeta?.workflow ? await loadOrderedStepIds(runMeta.workflow).catch(() => []) : [];

  const stepsDir = path.join(runDir, "steps");
  const entries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  const statusMap = new Map<string, { ok: boolean | null; endTs: number }>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(stepsDir, entry.name, "status.json");
    const raw = await fs.readFile(statusPath, "utf8").catch(() => "");
    if (!raw) {
      statusMap.set(entry.name, { ok: null, endTs: 0 });
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { ok?: boolean; end?: string | null };
      const endTs = parsed.end ? Date.parse(parsed.end) : 0;
      statusMap.set(entry.name, { ok: typeof parsed.ok === "boolean" ? parsed.ok : null, endTs });
    } catch {
      statusMap.set(entry.name, { ok: null, endTs: 0 });
    }
  }

  for (const stepId of ordered) {
    const status = statusMap.get(stepId);
    if (!status || status.ok !== true) {
      return stepId;
    }
  }

  let latestFailed: { stepId: string; endTs: number } | null = null;
  for (const [stepId, status] of statusMap.entries()) {
    if (status.ok === false && (!latestFailed || status.endTs >= latestFailed.endTs)) {
      latestFailed = { stepId, endTs: status.endTs };
    }
  }
  if (latestFailed) return latestFailed.stepId;

  let latest: { stepId: string; endTs: number } | null = null;
  for (const [stepId, status] of statusMap.entries()) {
    if (!latest || status.endTs >= latest.endTs) {
      latest = { stepId, endTs: status.endTs };
    }
  }
  return latest?.stepId ?? ordered[ordered.length - 1] ?? null;
}

async function loadOrderedStepIds(workflowPath: string): Promise<string[]> {
  const workflow = await loadWorkflow(workflowPath);
  const stepIds: string[] = [];
  for (const step of workflow.steps) {
    stepIds.push(step.id);
    if (step.parallel && step.substeps) {
      for (const sub of step.substeps) {
        stepIds.push(`${step.id}.${sub.id}`);
      }
    }
  }
  return stepIds;
}

async function testOpenAiConnection(apiKey: string): Promise<{ ok: boolean; provider: string; model?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401) {
        return { ok: false, provider: "openai", error: "Authentication failed. Check OPENAI_API_KEY." };
      }
      return { ok: false, provider: "openai", error: `OpenAI API returned ${response.status}.` };
    }
    const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    const model = payload.data?.[0]?.id;
    return { ok: true, provider: "openai", model };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, provider: "openai", error: "Connection timed out." };
    }
    return { ok: false, provider: "openai", error: "Unable to reach OpenAI API." };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildProviderDiscovery(options: {
  rootDir: string;
  workspacePath?: string;
  scope: "workspace" | "global";
  passphrase?: string;
  useKeychain?: boolean;
}) {
  const [openAiKey, claudeKey] = await Promise.all([
    getSecret({
      name: "OPENAI_API_KEY",
      scope: options.scope,
      repoPath: options.workspacePath,
      passphrase: options.passphrase,
      useKeychain: options.useKeychain
    }).catch(() => null),
    getSecret({
      name: "ANTHROPIC_API_KEY",
      scope: options.scope,
      repoPath: options.workspacePath,
      passphrase: options.passphrase,
      useKeychain: options.useKeychain
    }).catch(() => null)
  ]);

  return discoverMissionProviders({
    cwd: options.workspacePath ?? options.rootDir,
    env: process.env,
    apiSecrets: {
      openai: Boolean(openAiKey),
      claude: Boolean(claudeKey)
    }
  });
}

async function testClaudeConnection(apiKey: string): Promise<{ ok: boolean; provider: string; model?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401) {
        return { ok: false, provider: "claude", error: "Authentication failed. Check ANTHROPIC_API_KEY." };
      }
      return { ok: false, provider: "claude", error: `Anthropic API returned ${response.status}.` };
    }
    return { ok: true, provider: "claude", model: "claude-3-5-sonnet-latest" };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, provider: "claude", error: "Connection timed out." };
    }
    return { ok: false, provider: "claude", error: "Unable to reach Anthropic API." };
  } finally {
    clearTimeout(timeout);
  }
}

async function listArtifacts(stepPath: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  await walk(stepPath, "");
  return results.sort();
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
      const snap = await snapshot();
      send({ t: "run.snapshot", ...snap, ts: Date.now() });
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
  const done = run?.completedSteps ?? steps.filter((s: any) => s.ok).length;
  const progress = {
    done,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
    remaining: Math.max(0, total - done)
  };
  return { run, steps, progress };
}

async function buildRunDetail(run: RunRecord) {
  if (isMissionRunMeta(run.meta)) {
    const missionRun = await loadMissionRun(run.runDir).catch(() => null);
    const graph = missionRun?.graph ?? run.meta.graph ?? null;
    const steps = graph ? missionGraphToStepStates(graph) : [];
    return {
      run: missionRun ?? run.meta,
      steps,
      graph: graph
        ? {
            templateId: graph.templateId,
            name: graph.name,
            description: graph.description,
            nodes: graph.nodes
          }
        : null,
      workflow: null,
      delivery: null
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
      workflow: null,
      delivery
    };
  }
  const steps = await loadStepStatesFromDir(path.join(run.runDir, "steps"));
  let workflow = null;
  const workflowPath = run.meta?.workflow;
  if (workflowPath) {
    try {
      const wf = await loadWorkflow(workflowPath);
      workflow = {
        name: wf.name,
        agents: wf.agents,
        loop: wf.loop,
        enable_auto_tests: wf.enable_auto_tests,
        security: wf.security,
        steps: wf.steps.map((step) => ({
          id: step.id,
          agent: step.agent,
          phase: step.phase,
          parallel: step.parallel,
          type: step.type,
          substeps: step.substeps?.map((sub) => ({
            id: sub.id,
            agent: sub.agent,
            phase: sub.phase,
            type: sub.type
          }))
        }))
      };
    } catch {
      workflow = null;
    }
  }
  return { run: run.meta, steps, graph: null, workflow, delivery: null };
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

function getWorkspaceMetaDirForWrite(workspacePath: string): string {
  return path.join(workspacePath, ".orchestrum");
}

function resolveWorkspaceMetaDir(workspacePath: string, segments: string[] = []): string {
  return path.join(workspacePath, ".orchestrum", ...segments);
}

async function loadCustomTemplates(workspacePath: string): Promise<any[]> {
  const templatesDir = resolveWorkspaceMetaDir(workspacePath, ["templates"]);
  const entries = await fs.readdir(templatesDir, { withFileTypes: true }).catch(() => []);
  const templates: any[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const baseDir = path.join(templatesDir, entry.name);
    const metaPath = path.join(baseDir, "template.json");
    const workflowPath = path.join(baseDir, "workflow.yaml");
    const metaRaw = await fs.readFile(metaPath, "utf8").catch(() => "");
    let meta: any = {};
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw);
      } catch {
        meta = {};
      }
    }
    templates.push({
      name: entry.name,
      title: meta.title ?? meta.name ?? entry.name,
      description: meta.description ?? "Imported template",
      source: "custom",
      workflowPath
    });
  }
  return templates;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath || entryPath.endsWith("server.ts") || entryPath.endsWith("server.js")) {
  startService();
}
