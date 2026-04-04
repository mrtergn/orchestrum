import os from "node:os";
import path from "node:path";
import { ensureDir, readJsonIfExists, writeJson } from "@orchestrum/core";

type WorkspaceRegistryFile = {
  paths?: unknown;
  updatedAt?: string;
};

function resolveAppHome() {
  const override = process.env.ORCHESTRUM_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".orchestrum");
}

export function getWorkspaceRegistryPath() {
  return path.join(resolveAppHome(), "control", "workspaces.json");
}

function normalizeWorkspacePaths(values: Iterable<unknown>) {
  return Array.from(
    new Set(
      Array.from(values)
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .map((value) => path.resolve(value))
    )
  );
}

export async function loadRememberedWorkspacePaths(registryPath = getWorkspaceRegistryPath()) {
  const file = await readJsonIfExists<WorkspaceRegistryFile>(registryPath);
  if (!file || typeof file !== "object") return [] as string[];
  const raw = Array.isArray(file.paths) ? file.paths : [];
  return normalizeWorkspacePaths(raw);
}

export async function saveRememberedWorkspacePaths(
  values: Iterable<unknown>,
  registryPath = getWorkspaceRegistryPath()
) {
  const normalized = normalizeWorkspacePaths(values);
  await ensureDir(path.dirname(registryPath));
  await writeJson(registryPath, {
    paths: normalized,
    updatedAt: new Date().toISOString()
  });
  return normalized;
}
