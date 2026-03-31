import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadDocsSyncState, syncWorkspaceDocs } from "../src/docs/sync.js";

test("docs sync updates docs state for changed source files", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-docs-"));
  await runGit(repoPath, ["init"]);
  await fs.writeFile(path.join(repoPath, "README.md"), "# Test Repo\n", "utf8");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");

  const result = await syncWorkspaceDocs(repoPath);
  assert.equal(result.ok, true);
  assert.ok((result.updatedFiles ?? []).length >= 1);

  const state = await loadDocsSyncState(repoPath);
  assert.equal(state?.ok, true);
});

function runGit(repoPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git ${args.join(" ")} failed`));
    });
  });
}
