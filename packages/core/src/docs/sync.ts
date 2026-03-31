import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DocsSyncResponse } from "../contracts/service.js";
import { ensureDir, readJsonIfExists, writeJson, writeText } from "../runner/fs.js";

const DOC_CANDIDATES = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/HELP.md",
  "docs/RELEASE.md",
  "CHANGELOG.md",
  "TODO.md",
  "docs/TODO.md"
];

const START_MARKER = "<!-- orchestrum:docs-sync:start -->";
const END_MARKER = "<!-- orchestrum:docs-sync:end -->";

export function getDocsSyncStatePath(repoPath: string): string {
  return path.join(repoPath, ".orchestrum", "docs-sync.json");
}

export async function loadDocsSyncState(repoPath: string): Promise<DocsSyncResponse | null> {
  return readJsonIfExists<DocsSyncResponse>(getDocsSyncStatePath(repoPath));
}

export async function syncWorkspaceDocs(repoPath: string): Promise<DocsSyncResponse> {
  const changedFiles = await listChangedFiles(repoPath);
  const sourceChanges = changedFiles.filter((file) => !isDocFile(file));
  const stale = sourceChanges.length > 0;

  if (!stale) {
    const response: DocsSyncResponse = {
      ok: true,
      syncedAt: new Date().toISOString(),
      summary: "No source changes detected since the current working tree is clean.",
      changedFiles,
      updatedFiles: []
    };
    await persistDocsSyncState(repoPath, response);
    return response;
  }

  const existingCandidates = DOC_CANDIDATES.filter((candidate) => fsSync.existsSync(path.join(repoPath, candidate)));
  const targets = existingCandidates.length > 0 ? existingCandidates.slice(0, 4) : ["docs/RELEASE.md"];
  const syncBlock = buildSyncBlock(sourceChanges);
  const updatedFiles: string[] = [];

  for (const target of targets) {
    const fullPath = path.join(repoPath, target);
    await ensureDir(path.dirname(fullPath));
    const current = await fs.readFile(fullPath, "utf8").catch(() => "");
    const next = replaceOrAppendSyncBlock(current, syncBlock);
    if (!current && target.endsWith("RELEASE.md")) {
      await writeText(fullPath, `# Release Notes\n\n${syncBlock}\n`);
    } else if (current !== next) {
      await writeText(fullPath, next);
    } else {
      continue;
    }
    updatedFiles.push(target);
  }

  const response: DocsSyncResponse = {
    ok: true,
    syncedAt: new Date().toISOString(),
    summary: `Updated ${updatedFiles.length} documentation file(s) for ${sourceChanges.length} changed source file(s).`,
    changedFiles,
    updatedFiles
  };
  await persistDocsSyncState(repoPath, response);
  return response;
}

function buildSyncBlock(changedFiles: string[]): string {
  const syncedAt = new Date().toISOString();
  const lines = [
    START_MARKER,
    `## Orchestrum Docs Sync`,
    ``,
    `Synced at: ${syncedAt}`,
    `Changed source files:`,
    ...changedFiles.slice(0, 20).map((file) => `- ${file}`),
    changedFiles.length > 20 ? `- ...and ${changedFiles.length - 20} more` : "",
    END_MARKER
  ].filter(Boolean);
  return lines.join("\n");
}

function replaceOrAppendSyncBlock(content: string, block: string): string {
  if (!content.trim()) return `${block}\n`;
  const pattern = new RegExp(`${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }
  return `${content.trim()}\n\n${block}\n`;
}

function isDocFile(file: string): boolean {
  return /^docs\//i.test(file) || /\.md$/i.test(file);
}

async function persistDocsSyncState(repoPath: string, response: DocsSyncResponse): Promise<void> {
  await ensureDir(path.dirname(getDocsSyncStatePath(repoPath)));
  await writeJson(getDocsSyncStatePath(repoPath), response);
}

async function listChangedFiles(repoPath: string): Promise<string[]> {
  const output = await runGit(repoPath, ["status", "--porcelain"]);
  return output
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code ?? -1}`));
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
