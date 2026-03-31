import path from "node:path";
import { spawn } from "node:child_process";
import type express from "express";
import {
  addWorkspace,
  loadWorkspaces,
  removeWorkspace,
  updateWorkspace,
  validateWorkspacePath
} from "@orchestrum/core";

type RunIndexLike = {
  list(filter?: { workspaceId?: string; status?: string; tag?: string; search?: string }): any[];
};

export function registerWorkspaceRegistryRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    runIndex: RunIndexLike;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  }
): void {
  const workspaceListRoutes = ["/workspaces", "/api/workspaces"] as const;
  for (const route of workspaceListRoutes) {
    app.get(route, async (_req, res) => {
      const workspaces = await loadWorkspaces(options.rootDir);
      const enriched = await Promise.all(workspaces.map((workspace) => buildWorkspaceSummary(workspace, options.runIndex)));
      res.json({ workspaces: enriched });
    });

    app.post(route, async (req, res) => {
      const workspacePath = String(req.body?.path ?? "");
      const id = req.body?.id ? String(req.body.id) : undefined;
      const name = req.body?.name ? String(req.body.name) : undefined;
      if (!workspacePath) return res.status(400).json({ error: "path required" });
      try {
        const workspace = await addWorkspace(options.rootDir, workspacePath, { id, name });
        const summary = await buildWorkspaceSummary(workspace, options.runIndex);
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
      const workspace = await updateWorkspace(options.rootDir, req.params.id, { name });
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const summary = await buildWorkspaceSummary(workspace, options.runIndex);
      res.json({ workspace: summary });
    });

    app.delete(route, async (req, res) => {
      const removed = await removeWorkspace(options.rootDir, req.params.id);
      if (!removed) return res.status(404).json({ error: "Workspace not found" });
      res.json({ ok: true, workspace: removed });
    });
  }

  const workspaceGitRoutes = ["/workspaces/:id/git/init", "/api/workspaces/:id/git/init"] as const;
  for (const route of workspaceGitRoutes) {
    app.post(route, async (req, res) => {
      const workspacePath = await options.resolveWorkspacePath(req.params.id);
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
}

async function buildWorkspaceSummary(
  workspace: { id: string; path: string; name?: string; createdAt?: string; updatedAt?: string },
  runIndex: RunIndexLike
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
