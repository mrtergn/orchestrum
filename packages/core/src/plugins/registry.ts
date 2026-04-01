import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ensureDir, readJsonIfExists, writeJson } from "../runner/fs.js";
import type { OrchestrumPlugin } from "../runner/plugins.js";
import { getWorkspacePluginsDir } from "../runner/control.js";

const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().optional(),
  capabilities_required: z.array(z.string()).optional(),
  description: z.string().optional()
});

export type PluginManifest = z.infer<typeof ManifestSchema>;

export type InstalledPlugin = {
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  manifest: PluginManifest;
};

type RegistryFile = {
  plugins: InstalledPlugin[];
};

const DEFAULT_ENTRY = "index.js";
const SUPPORTED_PLUGIN_CAPABILITIES = new Set([
  "run.start",
  "run.finish",
  "step.start",
  "step.finish",
  "browser.run.start",
  "browser.run.finish",
  "browser.step.start",
  "browser.step.finish"
]);

export function getPluginsDir(repoPath = process.cwd()): string {
  return getWorkspacePluginsDir(repoPath);
}

export function getRegistryPath(repoPath = process.cwd()): string {
  return path.join(getPluginsDir(repoPath), "plugins.json");
}

export async function listInstalledPlugins(repoPath = process.cwd()): Promise<InstalledPlugin[]> {
  const registry = await loadRegistry(repoPath);
  return registry.plugins;
}

export async function installPlugin(repoPath: string, sourcePath: string): Promise<InstalledPlugin> {
  const resolved = path.resolve(sourcePath);
  if (!fsSync.existsSync(resolved)) {
    throw new Error("Plugin path not found.");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Plugin path must be a directory.");
  }
  const manifest = await loadManifest(resolved);
  assertManifestCapabilities(manifest);
  const targetDir = path.join(getPluginsDir(repoPath), manifest.name);
  await ensureDir(targetDir);
  await copyRecursive(resolved, targetDir);
  const installed: InstalledPlugin = {
    name: manifest.name,
    version: manifest.version,
    path: targetDir,
    enabled: false,
    manifest
  };
  const registry = await loadRegistry(repoPath);
  const existingIndex = registry.plugins.findIndex((p) => p.name === manifest.name);
  if (existingIndex >= 0) {
    registry.plugins[existingIndex] = installed;
  } else {
    registry.plugins.push(installed);
  }
  await saveRegistry(repoPath, registry);
  return installed;
}

export async function removePlugin(repoPath: string, name: string): Promise<void> {
  const registry = await loadRegistry(repoPath);
  const entry = registry.plugins.find((p) => p.name === name);
  if (entry) {
    await fs.rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
  }
  registry.plugins = registry.plugins.filter((p) => p.name !== name);
  await saveRegistry(repoPath, registry);
}

export async function setPluginEnabled(repoPath: string, name: string, enabled: boolean): Promise<void> {
  const registry = await loadRegistry(repoPath);
  const entry = registry.plugins.find((p) => p.name === name);
  if (!entry) throw new Error("Plugin not installed.");
  assertManifestCapabilities(entry.manifest);
  entry.enabled = enabled;
  await saveRegistry(repoPath, registry);
}

export async function loadEnabledPlugins(repoPath = process.cwd()): Promise<InstalledPlugin[]> {
  const registry = await loadRegistry(repoPath);
  return registry.plugins.filter((plugin) => {
    try {
      assertManifestCapabilities(plugin.manifest);
      return plugin.enabled;
    } catch {
      return false;
    }
  });
}

export async function loadPluginModule(plugin: InstalledPlugin): Promise<OrchestrumPlugin | null> {
  const entry = plugin.manifest.entry ?? DEFAULT_ENTRY;
  const entryPath = path.join(plugin.path, entry);
  if (!fsSync.existsSync(entryPath)) {
    throw new Error(`Plugin entry not found: ${entryPath}`);
  }
  const moduleUrl = `${pathToFileURL(entryPath).href}?t=${Date.now()}`;
  const loaded = await import(moduleUrl);
  const pluginExport = (loaded as any)?.default ?? loaded;
  const pluginObj: OrchestrumPlugin | undefined = pluginExport?.default ?? pluginExport?.plugin ?? pluginExport;
  if (!pluginObj || typeof pluginObj !== "object") return null;
  return pluginObj;
}

async function loadManifest(sourcePath: string): Promise<PluginManifest> {
  const manifestPath = path.join(sourcePath, "plugin.json");
  const raw = await fs.readFile(manifestPath, "utf8").catch(() => "");
  if (!raw) {
    throw new Error("plugin.json missing.");
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid plugin manifest: ${message}`);
  }
  return parsed.data;
}

async function loadRegistry(repoPath: string): Promise<RegistryFile> {
  const filePath = getRegistryPath(repoPath);
  const existing = await readJsonIfExists<RegistryFile>(filePath);
  if (existing?.plugins) return existing;
  return { plugins: [] };
}

async function saveRegistry(repoPath: string, registry: RegistryFile): Promise<void> {
  await ensureDir(path.dirname(getRegistryPath(repoPath)));
  await writeJson(getRegistryPath(repoPath), registry);
}

function assertManifestCapabilities(manifest: PluginManifest): void {
  const unsupported = (manifest.capabilities_required ?? []).filter((entry) => !SUPPORTED_PLUGIN_CAPABILITIES.has(entry));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported plugin capabilities: ${unsupported.join(", ")}`);
  }
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await ensureDir(dest);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".orchestrum") {
        continue;
      }
      await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}
