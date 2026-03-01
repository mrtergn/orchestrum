import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";
import { ensureDir, readJsonIfExists, writeJson } from "../runner/fs.js";
import type { LicenseTier } from "../licensing/index.js";
import type { OrchestrumPlugin } from "../runner/plugins.js";
import { getAppHome } from "../appHome.js";

const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().optional(),
  capabilities_required: z.array(z.string()).optional(),
  min_tier: z.enum(["Free", "Pro", "Studio"]).optional(),
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

export function getPluginsDir(): string {
  return path.join(getAppHome(), "plugins");
}

export function getRegistryPath(): string {
  return path.join(getPluginsDir(), "plugins.json");
}

export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  const registry = await loadRegistry();
  return registry.plugins;
}

export async function installPlugin(sourcePath: string): Promise<InstalledPlugin> {
  const resolved = path.resolve(sourcePath);
  if (!fsSync.existsSync(resolved)) {
    throw new Error("Plugin path not found.");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Plugin path must be a directory.");
  }
  const manifest = await loadManifest(resolved);
  const targetDir = path.join(getPluginsDir(), manifest.name);
  await ensureDir(targetDir);
  await copyRecursive(resolved, targetDir);
  const installed: InstalledPlugin = {
    name: manifest.name,
    version: manifest.version,
    path: targetDir,
    enabled: false,
    manifest
  };
  const registry = await loadRegistry();
  const existingIndex = registry.plugins.findIndex((p) => p.name === manifest.name);
  if (existingIndex >= 0) {
    registry.plugins[existingIndex] = installed;
  } else {
    registry.plugins.push(installed);
  }
  await saveRegistry(registry);
  return installed;
}

export async function removePlugin(name: string): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry.plugins.find((p) => p.name === name);
  if (entry) {
    await fs.rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
  }
  registry.plugins = registry.plugins.filter((p) => p.name !== name);
  await saveRegistry(registry);
}

export async function setPluginEnabled(name: string, enabled: boolean): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry.plugins.find((p) => p.name === name);
  if (!entry) throw new Error("Plugin not installed.");
  entry.enabled = enabled;
  await saveRegistry(registry);
}

export async function loadEnabledPlugins(tier: LicenseTier): Promise<InstalledPlugin[]> {
  const registry = await loadRegistry();
  return registry.plugins.filter((plugin) => {
    const required = plugin.manifest.min_tier ?? "Free";
    return plugin.enabled && isTierAllowed(tier, required);
  });
}

export async function loadPluginModule(plugin: InstalledPlugin): Promise<OrchestrumPlugin | null> {
  const entry = plugin.manifest.entry ?? DEFAULT_ENTRY;
  const entryPath = path.join(plugin.path, entry);
  if (!fsSync.existsSync(entryPath)) {
    throw new Error(`Plugin entry not found: ${entryPath}`);
  }
  const source = await fs.readFile(entryPath, "utf8");
  const context = vm.createContext({
    console,
    exports: {},
    module: { exports: {} },
    process: undefined,
    require: undefined
  });
  const script = new vm.Script(source, { filename: entryPath });
  script.runInContext(context, { timeout: 1000 });
  const pluginExport = (context.module as any).exports ?? (context.exports as any);
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

async function loadRegistry(): Promise<RegistryFile> {
  const filePath = getRegistryPath();
  const existing = await readJsonIfExists<RegistryFile>(filePath);
  if (existing?.plugins) return existing;
  return { plugins: [] };
}

async function saveRegistry(registry: RegistryFile): Promise<void> {
  await ensureDir(path.dirname(getRegistryPath()));
  await writeJson(getRegistryPath(), registry);
}

function isTierAllowed(current: LicenseTier, required: LicenseTier): boolean {
  const rank = (tier: LicenseTier) => (tier === "Studio" ? 3 : tier === "Pro" ? 2 : 1);
  return rank(current) >= rank(required);
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
