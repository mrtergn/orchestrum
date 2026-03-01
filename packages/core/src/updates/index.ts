import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import * as tar from "tar";
import { ensureDir } from "../runner/fs.js";
import { getAppHome } from "../appHome.js";

export type VersionInfo = {
  version: string;
  channel: "stable" | "beta";
  buildDate?: string;
  notes?: string;
};

export type UpdateStatus = {
  current: VersionInfo | null;
  available: VersionInfo | null;
  updateAvailable: boolean;
  reason?: string;
};

const DEFAULT_CHANNEL: VersionInfo["channel"] = "stable";

export function getVersionPath(rootDir: string): string {
  return path.join(rootDir, "version.json");
}

export async function getCurrentVersion(rootDir: string): Promise<VersionInfo | null> {
  const filePath = getVersionPath(rootDir);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return null;
  return normalizeVersion(JSON.parse(raw));
}

export async function getAvailableVersion(options: { rootDir?: string; sourcePath?: string } = {}): Promise<VersionInfo | null> {
  if (options.sourcePath) {
    const raw = await fs.readFile(options.sourcePath, "utf8").catch(() => "");
    if (!raw) return null;
    return normalizeVersion(JSON.parse(raw));
  }
  const dir = path.join(getAppHome(), "updates");
  const filePath = path.join(dir, "version.json");
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return null;
  return normalizeVersion(JSON.parse(raw));
}

export async function checkForUpdates(options: { rootDir: string; sourcePath?: string }):
  Promise<UpdateStatus> {
  const current = await getCurrentVersion(options.rootDir);
  const available = await getAvailableVersion({ sourcePath: options.sourcePath });
  if (!current || !available) {
    return {
      current,
      available,
      updateAvailable: false,
      reason: !current ? "Current version metadata missing." : "No update metadata found."
    };
  }
  const updateAvailable = compareVersions(available.version, current.version) > 0;
  return { current, available, updateAvailable };
}

export async function installUpdate(options: {
  archivePath: string;
  targetDir: string;
}): Promise<{ ok: boolean; updatedFiles: number }> {
  const archivePath = path.resolve(options.archivePath);
  const targetDir = path.resolve(options.targetDir);
  if (!fsSync.existsSync(archivePath)) {
    throw new Error("Update package not found.");
  }

  const tempDir = path.join(os.tmpdir(), `orchestrum-update-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  await ensureDir(tempDir);

  await tar.x({
    file: archivePath,
    cwd: tempDir,
    strict: true,
    filter: (entryPath) => isSafeArchivePath(entryPath)
  });

  const files = await collectFiles(tempDir);
  for (const file of files) {
    const rel = path.relative(tempDir, file);
    const dest = path.join(targetDir, rel);
    await ensureDir(path.dirname(dest));
    await fs.copyFile(file, dest);
  }
  return { ok: true, updatedFiles: files.length };
}

function normalizeVersion(data: any): VersionInfo {
  return {
    version: String(data.version ?? "0.0.0"),
    channel: data.channel === "beta" ? "beta" : DEFAULT_CHANNEL,
    buildDate: data.buildDate ? String(data.buildDate) : undefined,
    notes: data.notes ? String(data.notes) : undefined
  };
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((part) => Number(part.replace(/[^0-9]/g, "")) || 0);
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath) return false;
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) return false;
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.includes("..")) return false;
  return true;
}

async function collectFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  await walk(root);
  return results;
}
