"use client";

const RECENT_WORKSPACE_PATHS_KEY = "orchestrum.ui.workspacePaths";

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getRecentWorkspacePaths(): string[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(RECENT_WORKSPACE_PATHS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean)))
      : [];
  } catch {
    return [];
  }
}

export function saveRecentWorkspacePaths(paths: string[]): string[] {
  const normalized = Array.from(new Set(paths.map((entry) => String(entry ?? "").trim()).filter(Boolean)));
  if (canUseStorage()) {
    window.localStorage.setItem(RECENT_WORKSPACE_PATHS_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function rememberRecentWorkspacePath(repoPath: string): string[] {
  return saveRecentWorkspacePaths([repoPath, ...getRecentWorkspacePaths()]);
}

export function forgetRecentWorkspacePath(repoPath: string): string[] {
  const resolved = String(repoPath ?? "").trim();
  return saveRecentWorkspacePaths(getRecentWorkspacePaths().filter((entry) => entry !== resolved));
}

export function buildWorkspaceApiPath(basePath = "/api/workspaces", search?: URLSearchParams): string {
  const params = new URLSearchParams(search);
  for (const repoPath of getRecentWorkspacePaths()) {
    params.append("path", repoPath);
  }
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

