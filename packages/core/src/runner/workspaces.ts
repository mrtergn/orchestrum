import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { ensureDir, writeJson } from "./fs.js";

export type Workspace = {
  id: string;
  path: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
};

type WorkspaceFile = {
  workspaces: Workspace[];
};

export type WorkspacePathValidation = {
  exists: boolean;
  readable: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: string;
};

export function getWorkspacesPath(rootDir: string): string {
  return path.join(rootDir, "data", "workspaces.json");
}

export function getLegacyWorkspacesPath(rootDir: string): string {
  return path.join(rootDir, "workspaces.json");
}

export async function loadWorkspaces(rootDir: string): Promise<Workspace[]> {
  const filePath = getWorkspacesPath(rootDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as WorkspaceFile;
    return normalizeWorkspaces(parsed.workspaces);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const legacyPath = getLegacyWorkspacesPath(rootDir);
  try {
    const raw = await fs.readFile(legacyPath, "utf8");
    const parsed = JSON.parse(raw) as WorkspaceFile;
    const normalized = normalizeWorkspaces(parsed.workspaces);
    if (normalized.length > 0) {
      await saveWorkspaces(rootDir, normalized);
    }
    return normalized;
  } catch (legacyErr) {
    if ((legacyErr as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw legacyErr;
  }
}

export async function saveWorkspaces(rootDir: string, workspaces: Workspace[]): Promise<void> {
  const filePath = getWorkspacesPath(rootDir);
  await ensureDir(path.dirname(filePath));
  const payload: WorkspaceFile = { workspaces: normalizeWorkspaces(workspaces) };
  await writeJson(filePath, payload);
}

export async function addWorkspace(
  rootDir: string,
  repoPath: string,
  options?: string | { id?: string; name?: string }
): Promise<Workspace> {
  const id = typeof options === "string" ? options : options?.id;
  const name = typeof options === "string" ? undefined : options?.name;
  const workspaces = await loadWorkspaces(rootDir);
  const resolvedPath = path.resolve(repoPath);
  const validation = await validateWorkspacePath(resolvedPath);
  if (!validation.exists || !validation.isDirectory || !validation.readable) {
    throw new Error(validation.error ?? "Workspace path must exist, be a directory, and be readable.");
  }
  const existing = workspaces.find((ws) => path.resolve(ws.path) === resolvedPath);
  if (existing) {
    if (name && name.trim() && existing.name !== name.trim()) {
      existing.name = name.trim();
      existing.updatedAt = new Date().toISOString();
      await saveWorkspaces(rootDir, workspaces);
    }
    return existing;
  }

  const baseId = id ?? slugify(path.basename(resolvedPath));
  const nextId = ensureUniqueId(baseId, workspaces.map((ws) => ws.id));
  const timestamp = new Date().toISOString();
  const workspace: Workspace = {
    id: nextId,
    path: resolvedPath,
    name: name?.trim() || undefined,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  workspaces.push(workspace);
  await saveWorkspaces(rootDir, workspaces);
  return workspace;
}

export async function updateWorkspace(
  rootDir: string,
  workspaceId: string,
  patch: { name?: string }
): Promise<Workspace | null> {
  const workspaces = await loadWorkspaces(rootDir);
  const index = workspaces.findIndex((ws) => ws.id === workspaceId);
  if (index < 0) return null;
  const current = workspaces[index]!;
  const name = typeof patch.name === "string" ? patch.name.trim() : current.name;
  const updated: Workspace = {
    ...current,
    name: name || undefined,
    updatedAt: new Date().toISOString()
  };
  workspaces[index] = updated;
  await saveWorkspaces(rootDir, workspaces);
  return updated;
}

export async function removeWorkspace(rootDir: string, workspaceId: string): Promise<Workspace | null> {
  const workspaces = await loadWorkspaces(rootDir);
  const index = workspaces.findIndex((ws) => ws.id === workspaceId);
  if (index < 0) return null;
  const [removed] = workspaces.splice(index, 1);
  await saveWorkspaces(rootDir, workspaces);
  return removed ?? null;
}

export function findWorkspaceById(workspaces: Workspace[], id: string): Workspace | undefined {
  return workspaces.find((ws) => ws.id === id);
}

export function findWorkspaceByPath(workspaces: Workspace[], repoPath: string): Workspace | undefined {
  const resolvedPath = path.resolve(repoPath);
  return workspaces.find((ws) => path.resolve(ws.path) === resolvedPath);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "workspace";
}

function ensureUniqueId(baseId: string, existingIds: string[]): string {
  if (!existingIds.includes(baseId)) {
    return baseId;
  }
  let counter = 2;
  while (existingIds.includes(`${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
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

function normalizeWorkspaces(workspaces: unknown): Workspace[] {
  if (!Array.isArray(workspaces)) return [];
  return workspaces
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const id = typeof (entry as Workspace).id === "string" ? (entry as Workspace).id.trim() : "";
      const rawPath = typeof (entry as Workspace).path === "string" ? (entry as Workspace).path.trim() : "";
      if (!id || !rawPath) return null;
      const normalized: Workspace = {
        id,
        path: path.resolve(rawPath)
      };
      if (typeof (entry as Workspace).name === "string" && (entry as Workspace).name?.trim()) {
        normalized.name = (entry as Workspace).name!.trim();
      }
      if (typeof (entry as Workspace).createdAt === "string") {
        normalized.createdAt = (entry as Workspace).createdAt;
      }
      if (typeof (entry as Workspace).updatedAt === "string") {
        normalized.updatedAt = (entry as Workspace).updatedAt;
      }
      return normalized;
    })
    .filter((workspace): workspace is Workspace => Boolean(workspace));
}
