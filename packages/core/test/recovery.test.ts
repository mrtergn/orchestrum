import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { recoverInterruptedRuns } from "../src/runner/recovery.js";
import { writeJson } from "../src/runner/fs.js";

test("recoverInterruptedRuns marks running runs as interrupted", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-recover-"));
  const runDir = path.join(tmp, "run1");
  await fs.mkdir(runDir, { recursive: true });
  await writeJson(path.join(runDir, "run.json"), {
    runId: "run1",
    status: "running",
    start: new Date().toISOString(),
    end: null
  });

  const result = await recoverInterruptedRuns(tmp);
  assert.equal(result.recovered, 1);

  const raw = await fs.readFile(path.join(runDir, "run.json"), "utf8");
  const updated = JSON.parse(raw) as { status: string; interruptedAt?: string };
  assert.equal(updated.status, "interrupted");
  assert.ok(updated.interruptedAt);
});
