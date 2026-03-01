import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writeText } from "./fs.js";

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
  const patchPath = path.join(repoPath, ".orchestrum_patch.diff");
  await writeText(patchPath, diffText);

  const gitApply = await run("git", ["apply", "--whitespace=fix", patchPath], repoPath);
  if (gitApply.code === 0) {
    await fs.unlink(patchPath);
    return;
  }

  const patchApply = await run("patch", ["-p0", "-i", patchPath], repoPath);
  await fs.unlink(patchPath);

  if (patchApply.code !== 0) {
    const message = `Patch apply failed. git: ${gitApply.stderr.trim()} patch: ${patchApply.stderr.trim()}`;
    throw new Error(message);
  }
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

export async function gitDiff(repoPath: string): Promise<string> {
  const result = await run("git", ["diff"], repoPath);
  if (result.code !== 0) {
    throw new Error(`git diff failed: ${result.stderr.trim()}`);
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
