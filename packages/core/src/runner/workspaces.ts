import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  discoverWorkspaceManifests,
  ensureWorkspaceManifest,
  type WorkspaceManifest
} from "./control.js";

export type Workspace = WorkspaceManifest;

export type WorkspacePathValidation = {
  exists: boolean;
  readable: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: string;
};

export function getWorkspacesPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), ".orchestrum", "control", "workspace.json");
}

export async function loadWorkspaces(rootDir: string, options: { repoPaths?: string[] } = {}): Promise<Workspace[]> {
  return discoverWorkspaceManifests(rootDir, options.repoPaths ?? []);
}

export async function saveWorkspaces(rootDir: string, workspaces: Workspace[]): Promise<void> {
  await Promise.all(
    workspaces.map((workspace) =>
      ensureWorkspaceManifest(workspace.path, {
        id: workspace.id,
        name: workspace.name
      })
    )
  );
}

export async function addWorkspace(
  rootDir: string,
  repoPath: string,
  options?: string | { id?: string; name?: string }
): Promise<Workspace> {
  const id = typeof options === "string" ? options : options?.id;
  const name = typeof options === "string" ? undefined : options?.name;
  const resolvedPath = path.resolve(repoPath);
  const validation = await validateWorkspacePath(resolvedPath);
  if (!validation.exists || !validation.isDirectory || !validation.readable) {
    throw new Error(validation.error ?? "Workspace path must exist, be a directory, and be readable.");
  }

  const manifest = await ensureWorkspaceManifest(resolvedPath, { id, name });
  return manifest;
}

export async function updateWorkspace(
  rootDir: string,
  workspaceId: string,
  patch: { name?: string },
  options: { repoPaths?: string[] } = {}
): Promise<Workspace | null> {
  const workspaces = await loadWorkspaces(rootDir, options);
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!current) return null;
  return ensureWorkspaceManifest(current.path, { id: current.id, name: typeof patch.name === "string" ? patch.name : current.name });
}

export async function removeWorkspace(rootDir: string, workspaceId: string, options: { repoPaths?: string[] } = {}): Promise<Workspace | null> {
  const workspaces = await loadWorkspaces(rootDir, options);
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!current) return null;
  return current;
}

export function findWorkspaceById(workspaces: Workspace[], id: string): Workspace | undefined {
  return workspaces.find((ws) => ws.id === id);
}

export function findWorkspaceByPath(workspaces: Workspace[], repoPath: string): Workspace | undefined {
  const resolvedPath = path.resolve(repoPath);
  return workspaces.find((ws) => path.resolve(ws.path) === resolvedPath);
}

export async function validateWorkspacePath(repoPath: string): Promise<WorkspacePathValidation> {
  const resolvedPath = path.resolve(repoPath);
  try {
    const stat = await fs.stat(resolvedPath);
    const isDirectory = stat.isDirectory();
    if (!isDirectory) {
      return {
        exists: true,
        readable: false,
        isDirectory: false,
        isGitRepo: false,
        error: "Path exists but is not a directory."
      };
    }

    let readable = true;
    try {
      await fs.access(resolvedPath, fsSync.constants.R_OK);
    } catch {
      readable = false;
    }

    const isGitRepo =
      fsSync.existsSync(path.join(resolvedPath, ".git")) ||
      (await fs
        .access(path.join(resolvedPath, ".git"), fsSync.constants.R_OK)
        .then(() => true)
        .catch(() => false));

    return {
      exists: true,
      readable,
      isDirectory,
      isGitRepo,
      error: readable ? undefined : "Directory is not readable."
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        readable: false,
        isDirectory: false,
        isGitRepo: false,
        error: "Path does not exist."
      };
    }
    return {
      exists: false,
      readable: false,
      isDirectory: false,
      isGitRepo: false,
      error: (err as Error).message
    };
  }
}
