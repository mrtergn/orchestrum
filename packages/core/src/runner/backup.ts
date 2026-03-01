import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureDir, writeJson } from "./fs.js";
import { loadWorkspaces, getWorkspacesPath, getLegacyWorkspacesPath } from "./workspaces.js";
import { getGlobalConfigPath } from "./config.js";

export async function createBackup(options: {
  rootDir: string;
  runsDir: string;
  outputDir?: string;
}): Promise<string> {
  const backupDir = options.outputDir ?? path.join(options.rootDir, "backups");
  await ensureDir(backupDir);
  const staging = path.join(backupDir, `.staging-${Date.now()}`);
  await ensureDir(staging);

  const runsTarget = path.join(staging, "runs");
  if (fsSync.existsSync(options.runsDir)) {
    await fs.cp(options.runsDir, runsTarget, { recursive: true });
  }

  const workspacesFile = getWorkspacesPath(options.rootDir);
  const legacyWorkspacesFile = getLegacyWorkspacesPath(options.rootDir);
  if (fsSync.existsSync(workspacesFile)) {
    await fs.copyFile(workspacesFile, path.join(staging, "workspaces.json"));
  } else if (fsSync.existsSync(legacyWorkspacesFile)) {
    await fs.copyFile(legacyWorkspacesFile, path.join(staging, "workspaces.json"));
  }

  const globalConfig = getGlobalConfigPath();
  if (fsSync.existsSync(globalConfig)) {
    await fs.copyFile(globalConfig, path.join(staging, "global_config.json"));
  }
  const globalSecrets = path.join(path.dirname(globalConfig), ".secrets.enc");
  if (fsSync.existsSync(globalSecrets)) {
    await fs.copyFile(globalSecrets, path.join(staging, "global_secrets.enc"));
  }

  const workspaces = await loadWorkspaces(options.rootDir);
  const workspaceMeta: Array<{ id: string; path: string }> = [];
  for (const ws of workspaces) {
    workspaceMeta.push({ id: ws.id, path: ws.path });
    const memoryDir = path.join(ws.path, ".memory");
    const orchestrumDir = path.join(ws.path, ".orchestrum");
    if (fsSync.existsSync(memoryDir)) {
      await fs.cp(memoryDir, path.join(staging, `workspace_${ws.id}_memory`), { recursive: true });
    }
    if (fsSync.existsSync(orchestrumDir)) {
      await fs.cp(orchestrumDir, path.join(staging, `workspace_${ws.id}_orchestrum`), { recursive: true });
    }
  }
  await writeJson(path.join(staging, "workspace_map.json"), workspaceMeta);

  const archive = path.join(backupDir, `backup-${Date.now()}.tar.gz`);
  await createArchive(staging, archive);
  await fs.rm(staging, { recursive: true, force: true });
  return archive;
}

export async function restoreBackup(options: { archivePath: string; targetDir: string }): Promise<void> {
  await ensureDir(options.targetDir);
  await extractArchive(options.archivePath, options.targetDir);
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

async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const tar = require("tar");
  await tar.x({
    file: archivePath,
    cwd: targetDir
  });
}
