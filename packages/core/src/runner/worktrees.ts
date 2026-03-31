import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAppHome } from "../appHome.js";
import { ensureDir } from "./fs.js";

export type ExecutionMode = "inline" | "worktree";

export type WorktreeContext = {
  mode: ExecutionMode;
  sourceRepoPath: string;
  repoPath: string;
  worktreePath: string | null;
  created: boolean;
};

export type StaleWorktree = {
  workspaceId: string;
  runId: string;
  worktreePath: string;
  reason: string;
};

export function getWorktreesRoot(): string {
  return path.join(getAppHome(), "worktrees");
}

export async function prepareWorktreeContext(options: {
  repoPath: string;
  workspaceId: string;
  runId: string;
  mode?: ExecutionMode | null;
  headSha?: string | null;
  existingWorktreePath?: string | null;
}): Promise<WorktreeContext> {
  const mode = options.mode ?? "inline";
  if (mode !== "worktree") {
    return {
      mode: "inline",
      sourceRepoPath: options.repoPath,
      repoPath: options.repoPath,
      worktreePath: null,
      created: false
    };
  }

  const existingPath = options.existingWorktreePath ? path.resolve(options.existingWorktreePath) : null;
  if (existingPath && fsSync.existsSync(existingPath)) {
    return {
      mode: "worktree",
      sourceRepoPath: options.repoPath,
      repoPath: existingPath,
      worktreePath: existingPath,
      created: false
    };
  }

  const worktreePath = await createRunWorktree({
    repoPath: options.repoPath,
    workspaceId: options.workspaceId,
    runId: options.runId,
    headSha: options.headSha ?? undefined
  });
  return {
    mode: "worktree",
    sourceRepoPath: options.repoPath,
    repoPath: worktreePath,
    worktreePath,
    created: true
  };
}

export async function createRunWorktree(options: {
  repoPath: string;
  workspaceId: string;
  runId: string;
  headSha?: string;
}): Promise<string> {
  const root = getWorktreesRoot();
  const worktreePath = path.join(root, sanitizeSegment(options.workspaceId), sanitizeSegment(options.runId));
  await ensureDir(path.dirname(worktreePath));

  if (fsSync.existsSync(worktreePath)) {
    const gitDir = path.join(worktreePath, ".git");
    if (fsSync.existsSync(gitDir)) {
      return worktreePath;
    }
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  }

  const ref = options.headSha?.trim() ? options.headSha.trim() : "HEAD";
  await runGit(options.repoPath, ["worktree", "add", "--detach", worktreePath, ref]);
  return worktreePath;
}

export async function removeRunWorktree(options: {
  repoPath: string;
  worktreePath?: string | null;
}): Promise<void> {
  if (!options.worktreePath) return;
  const resolved = path.resolve(options.worktreePath);
  if (!fsSync.existsSync(resolved)) return;
  await runGit(options.repoPath, ["worktree", "remove", "--force", resolved]).catch(async () => {
    await fs.rm(resolved, { recursive: true, force: true }).catch(() => undefined);
  });
}

export async function scanStaleWorktrees(runsDir: string): Promise<StaleWorktree[]> {
  const root = getWorktreesRoot();
  const results: StaleWorktree[] = [];
  const workspaceDirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const workspaceDir of workspaceDirs) {
    if (!workspaceDir.isDirectory()) continue;
    const workspaceId = workspaceDir.name;
    const runDirs = await fs.readdir(path.join(root, workspaceId), { withFileTypes: true }).catch(() => []);
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const runId = runDir.name;
      const worktreePath = path.join(root, workspaceId, runId);
      const runMetaPath = path.join(runsDir, workspaceId, runId, "run.json");
      const runMetaRaw = await fs.readFile(runMetaPath, "utf8").catch(() => "");
      if (!runMetaRaw) {
        results.push({ workspaceId, runId, worktreePath, reason: "Run metadata missing." });
        continue;
      }
      try {
        const runMeta = JSON.parse(runMetaRaw) as { status?: string; end?: string | null };
        const status = String(runMeta.status ?? "");
        if (status === "completed") {
          results.push({ workspaceId, runId, worktreePath, reason: "Completed run still has a worktree." });
          continue;
        }
        if (status === "failed" || status === "blocked" || status === "cancelled" || status === "interrupted") {
          const endTs = runMeta.end ? Date.parse(runMeta.end) : 0;
          if (endTs > 0 && Date.now() - endTs > 6 * 60 * 60 * 1000) {
            results.push({ workspaceId, runId, worktreePath, reason: `Inactive ${status} worktree older than 6 hours.` });
          }
        }
      } catch {
        results.push({ workspaceId, runId, worktreePath, reason: "Run metadata is corrupted." });
      }
    }
  }
  return results;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "default";
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
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code ?? -1}`));
      }
    });
  });
}
