import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonIfExists, writeJson } from "./fs.js";

export type WorkspaceManifest = {
  id: string;
  path: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
};

export function getWorkspaceControlDir(repoPath: string): string {
  return path.join(path.resolve(repoPath), ".orchestrum", "control");
}

export function getWorkspaceManifestPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "workspace.json");
}

export function getWorkspaceConfigPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "config.json");
}

export function getWorkspacePoliciesPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "policies.json");
}

export function getWorkspaceSignalsPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "signals.ndjson");
}

export function getWorkspaceLearningsPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "learnings.ndjson");
}

export function getWorkspacePluginsDir(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "plugins");
}

export function getWorkspaceWorktreesRoot(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "worktrees");
}

export function getWorkspaceAgentsPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "agents.json");
}

export function getWorkspaceOrgPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "org.json");
}

export function getWorkspaceTasksPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "tasks.json");
}

export function getWorkspaceTaskArtifactsRoot(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "tasks");
}

export function getWorkspaceMessagesPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "messages.json");
}

export function getWorkspaceWorkItemsPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "work-items.json");
}

export function getWorkspaceSprintSupervisorsPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "sprint-supervisors.json");
}

export function getWorkspaceOrganizationSupervisorPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "organization-supervisor.json");
}

export function getWorkspaceStateIndexPath(repoPath: string): string {
  return path.join(getWorkspaceControlDir(repoPath), "state-index.sqlite");
}

export function getOperatorControlDir(rootDir: string): string {
  return path.join(path.resolve(rootDir), ".orchestrum", "control");
}

export async function loadWorkspaceManifest(repoPath: string): Promise<WorkspaceManifest | null> {
  const filePath = getWorkspaceManifestPath(repoPath);
  const existing = await readJsonIfExists<WorkspaceManifest>(filePath);
  if (!existing || typeof existing !== "object") return null;
  const id = typeof existing.id === "string" ? existing.id.trim() : "";
  const storedPath = typeof existing.path === "string" ? existing.path.trim() : "";
  if (!id || !storedPath) return null;
  return {
    id,
    path: path.resolve(storedPath),
    name: typeof existing.name === "string" && existing.name.trim() ? existing.name.trim() : undefined,
    createdAt: typeof existing.createdAt === "string" ? existing.createdAt : undefined,
    updatedAt: typeof existing.updatedAt === "string" ? existing.updatedAt : undefined
  };
}

export async function ensureWorkspaceManifest(repoPath: string, options: { id?: string; name?: string } = {}): Promise<WorkspaceManifest> {
  const resolvedPath = path.resolve(repoPath);
  const existing = await loadWorkspaceManifest(resolvedPath);
  const now = new Date().toISOString();
  const manifest: WorkspaceManifest = {
    id: options.id?.trim() || existing?.id || slugify(path.basename(resolvedPath)) || crypto.randomUUID(),
    path: resolvedPath,
    name: options.name?.trim() || existing?.name || undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await ensureDir(getWorkspaceControlDir(resolvedPath));
  await writeJson(getWorkspaceManifestPath(resolvedPath), manifest);
  return manifest;
}

export async function discoverWorkspaceManifests(rootDir: string, repoPaths: string[] = []): Promise<WorkspaceManifest[]> {
  const candidates = new Set<string>();
  candidates.add(path.resolve(rootDir));
  for (const repoPath of repoPaths) {
    if (!repoPath) continue;
    candidates.add(path.resolve(repoPath));
  }
  const manifests: WorkspaceManifest[] = [];
  for (const repoPath of candidates) {
    const manifest = await loadWorkspaceManifest(repoPath);
    if (manifest) manifests.push(manifest);
  }
  return manifests.sort((left, right) => {
    const leftUpdated = left.updatedAt ?? "";
    const rightUpdated = right.updatedAt ?? "";
    if (leftUpdated !== rightUpdated) return leftUpdated < rightUpdated ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
}

export async function statWorkspaceControl(repoPath: string): Promise<boolean> {
  try {
    await fs.stat(getWorkspaceManifestPath(repoPath));
    return true;
  } catch {
    return false;
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "workspace";
}
