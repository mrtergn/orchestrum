import path from "node:path";
import type express from "express";
import {
  computeReleaseReadiness,
  discoverDeliverySetup,
  exportDiagnostics,
  initTeamPreset,
  listMissionTemplates,
  loadConfig,
  loadGlobalConfig,
  loadLearnings,
  loadWorkspaceConfig,
  loadWorkspaceProfile,
  runDoctor,
  saveGlobalConfig,
  saveTeamPreset,
  saveWorkspaceConfig,
  saveWorkspaceProfile,
  syncWorkspaceDocs,
  type StateIndex
} from "@orchestrum/core";

export function registerWorkspaceSupportRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    runsDir: string;
    stateIndex: StateIndex;
    resolveWorkspacePath: (rootDir: string, workspaceId?: string) => Promise<string | null>;
  }
): void {
  app.get("/config", async (req, res) => {
    const scope = (req.query.scope as string) ?? "workspace";
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    if (scope === "global") {
      const config = await loadGlobalConfig();
      return res.json({ config, scope });
    }
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const config = await loadWorkspaceConfig(workspacePath);
    res.json({ config, scope: "workspace" });
  });

  app.get("/profile", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, req.query.workspace as string | undefined);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const profile = await loadWorkspaceProfile(workspacePath).catch(() => null);
    res.json({ profile });
  });

  app.put("/profile", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    await saveWorkspaceProfile(workspacePath, req.body?.profile ?? {});
    res.json({ ok: true });
  });

  app.get("/capabilities", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const result = await discoverDeliverySetup({ repoPath: workspacePath, workspaceId });
    res.json(result);
  });

  app.get("/team-preset", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
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
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
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
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const result = await initTeamPreset({
      repoPath: workspacePath,
      workspaceId,
      force: Boolean(req.body?.force)
    });
    res.json(result);
  });

  app.get("/config/merged", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, req.query.workspace as string | undefined);
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
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    await saveWorkspaceConfig(workspacePath, req.body?.config ?? {});
    res.json({ ok: true });
  });

  app.get("/templates", async (_req, res) => {
    res.json({ templates: listMissionTemplates() });
  });

  app.post("/diagnostics/export", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const runId = req.body?.runId ? String(req.body.runId) : undefined;
    const archive = await exportDiagnostics({
      rootDir: options.rootDir,
      runsDir: options.runsDir,
      workspaceId,
      runId
    });
    res.json({ archive });
  });

  app.get("/doctor", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const repoPath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
    await options.stateIndex.health();
    const report = await runDoctor({
      rootDir: options.rootDir,
      runsDir: options.runsDir,
      workspaceId,
      repoPath: repoPath ?? undefined
    });
    res.json(report);
  });

  app.get("/learnings", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const repoPath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
    if (!repoPath) return res.json({ workspaceId, learnings: [] });
    const learnings = await loadLearnings(repoPath).catch(() => []);
    res.json({ workspaceId, learnings });
  });

  app.post("/docs/sync", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const payload = await syncWorkspaceDocs(workspacePath);
    void options.stateIndex.rebuild().catch(() => undefined);
    res.json(payload);
  });

  app.get("/release/readiness", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await options.resolveWorkspacePath(options.rootDir, workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    void options.stateIndex.rebuild().catch(() => undefined);
    const readiness = await computeReleaseReadiness({
      workspacePath,
      runsDir: options.runsDir,
      workspaceId
    });
    const indexed = await options.stateIndex.getLatestReadiness(workspaceId).catch(() => null);
    if (indexed?.runId && !readiness.latestRunId) {
      readiness.latestRunId = indexed.runId;
    }
    res.json(readiness);
  });
}
