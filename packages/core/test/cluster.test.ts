import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTask, enqueueTask, ensureClusterPaths } from "../src/cluster/queue.js";

test("cluster queue creates paths and enqueues tasks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-cluster-"));
  const paths = await ensureClusterPaths(root);
  assert.ok(paths.queueDir.endsWith("queue"));
  const task = buildTask({
    provider: "openai",
    model: "gpt-5",
    prompt: "ping",
    agentId: "dev",
    stepId: "implement",
    runId: "run-1"
  });
  const filePath = await enqueueTask(root, task);
  assert.ok(filePath.includes(task.id));
});
