import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateIndex } from "../src/state/index.js";

test("state index rebuilds from workspace and run files", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-state-root-"));
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(rootDir, "data"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "data", "workspaces.json"),
    JSON.stringify({ workspaces: [{ id: "demo", path: path.join(rootDir, "repo"), name: "Demo" }] }, null, 2),
    "utf8"
  );
  await fs.mkdir(path.join(rootDir, "repo", ".memory"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "repo", ".memory", "learnings.json"), "[]", "utf8");
  await fs.mkdir(path.join(runsDir, "demo", "run-1"), { recursive: true });
  await fs.writeFile(
    path.join(runsDir, "demo", "run-1", "run.json"),
    JSON.stringify({
      runId: "run-1",
      kind: "workflow",
      status: "finished",
      start: new Date().toISOString(),
      end: new Date().toISOString(),
      repoPath: path.join(rootDir, "repo"),
      workflow: "test.yaml",
      readiness: { score: 80, blocking: [] }
    }, null, 2),
    "utf8"
  );

  const index = new StateIndex({
    rootDir,
    runsDir,
    dbPath: path.join(rootDir, "state-index.sqlite")
  });
  const health = await index.rebuild();
  assert.equal(health.ok, true);

  const runs = await index.queryRuns("demo");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runId, "run-1");
  assert.equal(runs[0]!.readinessScore, 80);
});
