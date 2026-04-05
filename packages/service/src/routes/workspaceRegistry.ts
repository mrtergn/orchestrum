import path from "node:path";
import { spawn } from "node:child_process";
import type express from "express";
import {
  addWorkspace,
  loadWorkspaces,
  removeWorkspace,
  updateWorkspace,
  validateWorkspacePath,
  normalizeTaskStatus
} from "@orchestrum/core";

type RunIndexLike = {
  list(filter?: { workspaceId?: string; status?: string; tag?: string; search?: string }): any[];
  sync(filter?: { workspaceId?: string; runId?: string }): Promise<void>;
};

export function registerWorkspaceRegistryRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    runIndex: RunIndexLike;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
    listWorkspacePaths: () => Promise<string[]>;
    rememberWorkspacePath: (repoPath: string) => Promise<{ id: string; path: string; name?: string; createdAt?: string; updatedAt?: string }>;
    forgetWorkspacePath: (repoPath: string) => Promise<void>;
  }
): void {
  const workspaceListRoutes = ["/workspaces", "/api/workspaces"] as const;
  for (const route of workspaceListRoutes) {
    app.get(route, async (req, res) => {
      const explicitPaths = extractWorkspacePaths(req.query);
      const workspaces = await loadWorkspaces(options.rootDir, {
        repoPaths: Array.from(new Set([...(await options.listWorkspacePaths()), ...explicitPaths]))
      });
      for (const workspace of workspaces) {
        await options.rememberWorkspacePath(workspace.path);
      }
      // Ensure run index is fresh so workspace.status reflects latest runs.
      // This allows UI indicators (e.g., sidebar dots) to react to status changes
      // as soon as SSE invalidates the cached query.
      try {
        await options.runIndex.sync();
      } catch {
        // Best-effort sync; fall back to current index snapshot on failure.
      }
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
        await options.rememberWorkspacePath(workspace.path);
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
      const explicitPaths = extractWorkspacePaths(req.body);
      const workspace = await updateWorkspace(options.rootDir, req.params.id, { name }, {
        repoPaths: Array.from(new Set([...(await options.listWorkspacePaths()), ...explicitPaths]))
      });
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const summary = await buildWorkspaceSummary(workspace, options.runIndex);
      res.json({ workspace: summary });
    });

    app.delete(route, async (req, res) => {
      const explicitPaths = extractWorkspacePaths(req.body);
      const removed = await removeWorkspace(options.rootDir, req.params.id, {
        repoPaths: Array.from(new Set([...(await options.listWorkspacePaths()), ...explicitPaths]))
      });
      if (!removed) return res.status(404).json({ error: "Workspace not found" });
      await options.forgetWorkspacePath(removed.path);
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

function extractWorkspacePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const query = input as Record<string, unknown>;
  const raw = query.path ?? query.paths ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  return Array.from(
    new Set(
      values
        .flatMap((value) => String(value ?? "").split(","))
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => path.resolve(value))
    )
  );
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
  // Map runtime status to a compact color indicator for sidebar dots.
  // Colors: green=idle/succeeded, amber=running/active, red=failed/blocked (and invalid).
  const statusColor: "green" | "amber" | "red" = (() => {
    const raw = String(status ?? "").trim().toLowerCase();
    if (raw === "invalid") return "red" as const;
    if (raw === "idle") return "green" as const;
    const normalized = normalizeTaskStatus(raw);
    if (normalized === "running") return "amber" as const;
    if (normalized === "failed" || normalized === "blocked") return "red" as const;
    if (normalized === "succeeded") return "green" as const;
    // Default: treat unknown/queued/cancelled as healthy to avoid sidebar noise.
    return "green" as const;
  })();
  return {
    ...workspace,
    validation,
    status,
    statusColor,
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
