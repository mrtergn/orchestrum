import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writeText } from "./fs.js";

export type PatchConflictArtifactBundle = {
  patchPath: string;
  gitStatusPath: string;
  conflictsPath: string;
  summaryPath: string;
  recoveryGuidePath: string;
};

export class PatchApplyError extends Error {
  constructor(
    message: string,
    readonly code: "dirty_tree" | "apply_failed",
    readonly artifacts?: PatchConflictArtifactBundle
  ) {
    super(message);
    this.name = "PatchApplyError";
  }
}

type DirtyEntry = {
  code: string;
  path: string;
  originalPath?: string;
};

const MERGE_CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const INTERNAL_DIR_PREFIXES = [
  ".orchestrum/control/",
  ".orchestrum/patch-conflicts/"
];

async function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function ensureGitRepo(repoPath: string): Promise<void> {
  try {
    const stat = await fs.stat(path.join(repoPath, ".git"));
    if (!stat.isDirectory()) {
      throw new Error();
    }
  } catch {
    throw new Error(`Repo at ${repoPath} is not a git repository. Run git init first.`);
  }
}

export async function getHeadSha(repoPath: string): Promise<string> {
  const result = await run("git", ["rev-parse", "HEAD"], repoPath);
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes("unknown revision") || stderr.includes("ambiguous argument")) {
      return "UNBORN";
    }
    throw new Error(`git rev-parse failed: ${stderr}`);
  }
  return result.stdout.trim();
}

export async function applyPatch(repoPath: string, diffText: string): Promise<void> {
  const dirty = await run("git", ["status", "--porcelain"], repoPath);
  if (dirty.code !== 0) {
    throw new PatchApplyError(`git status failed: ${dirty.stderr.trim()}`, "apply_failed");
  }
  const artifactsDir = path.join(repoPath, ".orchestrum", "patch-conflicts");
  await fs.mkdir(artifactsDir, { recursive: true });
  const patchPath = path.join(artifactsDir, "apply.patch");
  const gitStatusPath = path.join(artifactsDir, "git-status.txt");
  const conflictsPath = path.join(artifactsDir, "conflicts.json");
  const summaryPath = path.join(artifactsDir, "conflict-summary.md");
  const recoveryGuidePath = path.join(artifactsDir, "recovery-guide.md");
  const normalizedDiffText = normalizeDiffForGitApply(diffText);
  await writeText(patchPath, normalizedDiffText);

  const dirtyEntries = parseDirtyEntries(dirty.stdout).filter((entry) => !isInternalDirtyPath(entry.path));
  const patchedPaths = extractPatchedPaths(diffText);
  const hasConflict = dirtyEntries.some((entry) => MERGE_CONFLICT_CODES.has(entry.code));
  const overlappingPaths = dirtyEntries
    .filter((entry) => {
      if (patchedPaths.size === 0) return true;
      if (patchedPaths.has(entry.path)) return true;
      return entry.originalPath ? patchedPaths.has(entry.originalPath) : false;
    })
    .map((entry) => entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path);
  const overlapsPatchedPath = dirtyEntries.some((entry) => {
    if (patchedPaths.size === 0) return true;
    if (patchedPaths.has(entry.path)) return true;
    return entry.originalPath ? patchedPaths.has(entry.originalPath) : false;
  });
  if (hasConflict || overlapsPatchedPath) {
    await writeText(gitStatusPath, dirty.stdout.trim());
    await writeText(conflictsPath, JSON.stringify({
      reason: "dirty_tree",
      patchedPaths: Array.from(patchedPaths),
      dirtyEntries,
      overlappingPaths,
      hasMergeConflicts: hasConflict
    }, null, 2));
    await writeText(summaryPath, [
      "# Patch Apply Blocked",
      "",
      "Patch apply stopped before execution because the repository already contains conflicting local state.",
      "",
      `- overlapping paths: ${overlappingPaths.join(", ") || "none detected"}`,
      `- merge conflicts present: ${hasConflict ? "yes" : "no"}`
    ].join("\n"));
    await writeText(recoveryGuidePath, [
      "# Recovery Guide",
      "",
      "1. Inspect `git-status.txt` and `conflicts.json` to see which files already changed locally.",
      "2. Commit, stash, discard, or manually resolve the overlapping files outside `.orchestrum`.",
      "3. Re-run the blocked step or resume the work item after the repository is clean enough to accept the patch.",
      "4. Keep `apply.patch` as the source diff if you need to apply it manually."
    ].join("\n"));
    throw new PatchApplyError(
      "Patch apply blocked because the repository has overlapping uncommitted changes or merge conflicts. Commit, stash, or clean the affected files first.",
      "dirty_tree",
      {
        patchPath,
        gitStatusPath,
        conflictsPath,
        summaryPath,
        recoveryGuidePath
      }
    );
  }

  const gitApply = await run("git", ["apply", "--3way", "--whitespace=fix", patchPath], repoPath);
  if (gitApply.code === 0) {
    return;
  }

  const status = await run("git", ["status", "--short"], repoPath);
  const conflicts = await run("git", ["diff", "--name-only", "--diff-filter=U"], repoPath);
  await writeText(gitStatusPath, `${status.stdout}${status.stderr}`.trim());
  await writeText(conflictsPath, JSON.stringify({
    conflictedFiles: conflicts.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    gitApplyStdout: gitApply.stdout.trim(),
    gitApplyStderr: gitApply.stderr.trim()
  }, null, 2));
  await writeText(summaryPath, [
    "# Patch Apply Conflict",
    "",
    "Patch apply failed during `git apply --3way`.",
    "",
    `- stderr: ${gitApply.stderr.trim() || "n/a"}`,
    `- conflicted files: ${conflicts.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(", ") || "none detected"}`
  ].join("\n"));
  await writeText(recoveryGuidePath, [
    "# Recovery Guide",
    "",
    "1. Inspect `conflict-summary.md` and `conflicts.json` for the exact conflict set.",
    "2. Resolve the conflicted files in the repository and make sure `git status` no longer shows merge conflicts.",
    "3. Retry the blocked step or resume the run once the repository can accept the patch cleanly.",
    "4. Use `apply.patch` if you need to inspect or re-apply the original diff manually."
  ].join("\n"));
  throw new PatchApplyError(
    `Patch apply failed after 3-way merge attempt: ${gitApply.stderr.trim() || gitApply.stdout.trim() || "unknown error"}`,
    "apply_failed",
    {
      patchPath,
      gitStatusPath,
      conflictsPath,
      summaryPath,
      recoveryGuidePath
    }
  );
}

export async function checkPatchApplies(repoPath: string, diffText: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", "--check", "-"], { cwd: repoPath });
    child.stdin.write(diffText);
    child.stdin.end();
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function parseDirtyEntries(output: string): DirtyEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const [originalPath, nextPath] = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").map((entry) => entry.trim())
        : [undefined, rawPath];
      return {
        code,
        path: nextPath,
        originalPath
      };
    });
}

function extractPatchedPaths(diffText: string): Set<string> {
  const paths = new Set<string>();
  let pendingOldPath: string | null = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      const candidate = normalizePatchPath(line.slice(4).trim());
      pendingOldPath = candidate;
      if (candidate) paths.add(candidate);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const candidate = normalizePatchPath(line.slice(4).trim()) ?? pendingOldPath;
      if (candidate) paths.add(candidate);
      pendingOldPath = null;
    }
  }
  return paths;
}

function normalizePatchPath(rawPath: string): string | null {
  if (!rawPath || rawPath === "/dev/null") return null;
  const normalized = rawPath.replace(/^([ab])\//, "").trim();
  return normalized || null;
}

function isInternalDirtyPath(filePath: string): boolean {
  return INTERNAL_DIR_PREFIXES.some((prefix) => filePath === prefix.slice(0, -1) || filePath.startsWith(prefix));
}

function normalizeDiffForGitApply(diffText: string): string {
  if (/\bdiff --git\b/.test(diffText)) {
    return diffText.endsWith("\n") ? diffText : `${diffText}\n`;
  }
  const lines = diffText.split(/\r?\n/);
  const normalized: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (typeof line !== "string") {
      continue;
    }
    const nextLine = lines[index + 1];
    if (line.startsWith("--- ") && typeof nextLine === "string" && nextLine.startsWith("+++ ")) {
      const oldPath = normalizePatchPath(line.slice(4).trim());
      const newPath = normalizePatchPath(nextLine.slice(4).trim());
      const headerOld = oldPath ?? newPath;
      const headerNew = newPath ?? oldPath;
      if (headerOld && headerNew) {
        normalized.push(`diff --git a/${headerOld} b/${headerNew}`);
      }
      normalized.push(`--- ${oldPath ? `a/${oldPath}` : "/dev/null"}`);
      normalized.push(`+++ ${newPath ? `b/${newPath}` : "/dev/null"}`);
      index += 1;
      continue;
    }
    normalized.push(line);
  }
  const output = normalized.join("\n");
  return output.endsWith("\n") ? output : `${output}\n`;
}

export async function gitDiff(repoPath: string): Promise<string> {
  const result = await run("git", ["diff"], repoPath);
  if (result.code !== 0) {
    throw new Error(`git diff failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function gitDiffStat(repoPath: string): Promise<string> {
  const result = await run("git", ["diff", "--stat"], repoPath);
  if (result.code !== 0) {
    throw new Error(`git diff --stat failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function gitChangedFiles(repoPath: string): Promise<string[]> {
  const result = await run("git", ["diff", "--name-only"], repoPath);
  if (result.code !== 0) {
    throw new Error(`git diff --name-only failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  const result = await run("git", ["checkout", "-B", branch], repoPath);
  if (result.code !== 0) {
    throw new Error(`git checkout failed: ${result.stderr.trim()}`);
  }
}

export async function commitAll(repoPath: string, message: string): Promise<string | null> {
  const add = await run("git", ["add", "-A"], repoPath);
  if (add.code !== 0) {
    throw new Error(`git add failed: ${add.stderr.trim()}`);
  }
  const commit = await run("git", ["commit", "-m", message], repoPath);
  if (commit.code !== 0) {
    if (commit.stderr.includes("nothing to commit")) {
      return null;
    }
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
  const sha = await getHeadSha(repoPath);
  return sha;
}
