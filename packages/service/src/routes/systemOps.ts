import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type express from "express";
import {
  checkForUpdates,
  installPlugin,
  installUpdate,
  listInstalledPlugins,
  removePlugin,
  selectUpdateAsset,
  setPluginEnabled
} from "@orchestrum/core";

export function registerSystemOpsRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  }
): void {
  const requireWorkspacePath = async (workspaceId?: string) => {
    if (!workspaceId) return null;
    return options.resolveWorkspacePath(workspaceId);
  };

  app.get("/updates/status", async (req, res) => {
    try {
      const remote =
        req.query.remote === "1" ||
        req.query.remote === "true";
      const repo = req.query.repo ? String(req.query.repo) : undefined;
      const status = await checkForUpdates({ rootDir: options.rootDir, remote, repo });
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
        const status = await checkForUpdates({ rootDir: options.rootDir, remote: true, repo });
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
          targetDir: options.rootDir
        });
        return res.json({
          ...result,
          version: status.available.version,
          asset,
          releaseUrl: status.available.releaseUrl
        });
      }

      if (!archivePath && !assetUrl) {
        return res.status(400).json({ error: "file, data, or url required" });
      }

      const result = await installUpdate({
        archivePath,
        downloadUrl: assetUrl || undefined,
        expectedSha256,
        assetName,
        targetDir: options.rootDir
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Update install failed" });
    }
  });

  app.get("/plugins", async (_req, res) => {
    const workspaceId = typeof _req.query.workspace === "string" ? _req.query.workspace : undefined;
    const workspacePath = await requireWorkspacePath(workspaceId);
    if (!workspacePath) {
      return res.status(400).json({ error: "workspace is required for plugin operations" });
    }
    const plugins = await listInstalledPlugins(workspacePath);
    res.json({ plugins });
  });

  app.post("/plugins/install", async (req, res) => {
    const pluginPath = String(req.body?.path ?? "");
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
    const workspacePath = await requireWorkspacePath(workspaceId);
    if (!pluginPath) return res.status(400).json({ error: "path required" });
    if (!workspacePath) return res.status(400).json({ error: "workspaceId required" });
    try {
      const plugin = await installPlugin(workspacePath, pluginPath);
      res.json({ plugin });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Plugin install failed" });
    }
  });

  app.post("/plugins/enable", async (req, res) => {
    const name = String(req.body?.name ?? "");
    const enabled = Boolean(req.body?.enabled);
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
    const workspacePath = await requireWorkspacePath(workspaceId);
    if (!name) return res.status(400).json({ error: "name required" });
    if (!workspacePath) return res.status(400).json({ error: "workspaceId required" });
    try {
      await setPluginEnabled(workspacePath, name, enabled);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Plugin update failed" });
    }
  });

  app.post("/plugins/remove", async (req, res) => {
    const name = String(req.body?.name ?? "");
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
    const workspacePath = await requireWorkspacePath(workspaceId);
    if (!name) return res.status(400).json({ error: "name required" });
    if (!workspacePath) return res.status(400).json({ error: "workspaceId required" });
    await removePlugin(workspacePath, name);
    res.json({ ok: true });
  });
}
