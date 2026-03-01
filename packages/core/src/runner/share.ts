import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as tar from "tar";
import { ensureDir, writeJson, readJsonIfExists, safeRunId } from "./fs.js";

export async function exportRunBundle(options: {
  runsDir: string;
  runId: string;
  workspaceId: string;
  outputDir?: string;
}): Promise<string> {
  const runDir = path.join(options.runsDir, options.workspaceId, options.runId);
  if (!fsSync.existsSync(runDir)) {
    throw new Error("Run folder not found.");
  }
  const tempDir = path.join(os.tmpdir(), `orchestrum-run-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await ensureDir(tempDir);
  const runCopy = path.join(tempDir, "run");
  await copyRecursive(runDir, runCopy);
  await writeJson(path.join(tempDir, "bundle.json"), {
    runId: safeRunId(options.runId),
    workspaceId: options.workspaceId,
    createdAt: new Date().toISOString()
  });
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : path.resolve("exports");
  await ensureDir(outputDir);
  const archivePath = path.join(outputDir, `${options.runId}.orun`);
  await tar.c({ gzip: true, file: archivePath, cwd: tempDir }, ["run", "bundle.json"]);
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return archivePath;
}

export async function importRunBundle(options: {
  archivePath: string;
  runsDir: string;
}): Promise<{ runId: string; workspaceId: string; runDir: string }> {
  const archivePath = path.resolve(options.archivePath);
  if (!fsSync.existsSync(archivePath)) {
    throw new Error("Bundle not found.");
  }
  const tempDir = path.join(os.tmpdir(), `orchestrum-import-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await ensureDir(tempDir);
  await tar.x({
    file: archivePath,
    cwd: tempDir,
    strict: true,
    filter: (entryPath) => isSafeArchivePath(entryPath)
  });
  const bundle = await readJsonIfExists<{ runId: string; workspaceId: string }>(path.join(tempDir, "bundle.json"));
  if (!bundle?.runId || !bundle.workspaceId) {
    throw new Error("Invalid bundle metadata.");
  }
  const runId = safeRunId(bundle.runId);
  const sourceRun = path.join(tempDir, "run");
  const targetDir = path.join(options.runsDir, bundle.workspaceId, runId);
  await ensureDir(path.dirname(targetDir));
  if (fsSync.existsSync(targetDir)) {
    const backupDir = path.join(options.runsDir, bundle.workspaceId, `${runId}-imported-${Date.now()}`);
    await fs.rename(targetDir, backupDir);
  }
  await copyRecursive(sourceRun, targetDir);
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return { runId, workspaceId: bundle.workspaceId, runDir: targetDir };
}

function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath) return false;
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) return false;
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.includes("..")) return false;
  return true;
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await ensureDir(dest);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}
