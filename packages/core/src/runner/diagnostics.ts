import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { ensureDir, writeJson, writeText } from "./fs.js";
import { isDockerAvailable } from "./sandbox.js";

export async function writeCrashReport(baseDir: string, error: unknown): Promise<string> {
  const diagnosticsDir = path.join(baseDir, "diagnostics");
  await ensureDir(diagnosticsDir);
  const filePath = path.join(diagnosticsDir, `crash-${Date.now()}.log`);
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  const payload = [
    `timestamp: ${new Date().toISOString()}`,
    `node: ${process.version}`,
    `platform: ${process.platform}`,
    `arch: ${process.arch}`,
    "",
    message
  ].join("\n");
  await writeText(filePath, payload);
  return filePath;
}

export async function exportDiagnostics(options: {
  rootDir: string;
  runsDir: string;
  workspaceId?: string;
  runId?: string;
  outputDir?: string;
  maxEvents?: number;
}): Promise<string> {
  const baseDir = options.outputDir ?? path.join(options.rootDir, "diagnostics");
  await ensureDir(baseDir);
  const bundleDir = path.join(baseDir, `bundle-${Date.now()}`);
  await ensureDir(bundleDir);

  const systemInfo = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    dockerAvailable: await isDockerAvailable().catch(() => false)
  };
  await writeJson(path.join(bundleDir, "system.json"), systemInfo);

  const serviceLog = path.join(options.rootDir, "logs", "service.ndjson");
  if (fsSync.existsSync(serviceLog)) {
    await fs.copyFile(serviceLog, path.join(bundleDir, "service.ndjson"));
  }

  if (options.runId) {
    const runDir = await findRunDir(options.runsDir, options.runId, options.workspaceId);
    if (runDir) {
      await copyRunDiagnostics(runDir, bundleDir, options.maxEvents ?? 200);
    }
  }

  const archivePath = `${bundleDir}.tar.gz`;
  await createArchive(bundleDir, archivePath);
  return archivePath;
}

async function copyRunDiagnostics(runDir: string, bundleDir: string, maxEvents: number): Promise<void> {
  const runMetaPath = path.join(runDir, "run.json");
  if (fsSync.existsSync(runMetaPath)) {
    await fs.copyFile(runMetaPath, path.join(bundleDir, "run.json"));
  }
  const runnerLog = path.join(runDir, "logs", "runner.ndjson");
  if (fsSync.existsSync(runnerLog)) {
    await fs.copyFile(runnerLog, path.join(bundleDir, "runner.ndjson"));
  }
  const eventsPath = path.join(runDir, "events.ndjson");
  if (fsSync.existsSync(eventsPath)) {
    const content = await fs.readFile(eventsPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-maxEvents).join("\n");
    await writeText(path.join(bundleDir, "events_tail.ndjson"), tail);
  }
}

async function findRunDir(runsDir: string, runId: string, workspaceId?: string): Promise<string | null> {
  if (workspaceId) {
    const candidate = path.join(runsDir, workspaceId, runId);
    if (fsSync.existsSync(candidate)) return candidate;
    return null;
  }
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name, runId);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

async function createArchive(sourceDir: string, outPath: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const tar = require("tar");
  await tar.c(
    {
      gzip: true,
      file: outPath,
      cwd: path.dirname(sourceDir)
    },
    [path.basename(sourceDir)]
  );
}
