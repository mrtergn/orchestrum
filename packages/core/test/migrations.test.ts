import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { migrateRun, CURRENT_SCHEMA_VERSION } from "../src/migrations/index.js";
import { writeJson } from "../src/runner/fs.js";

test("migrateRun applies schema defaults", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-migrate-"));
  const runDir = path.join(tmp, "run1");
  await fs.mkdir(runDir, { recursive: true });
  await writeJson(path.join(runDir, "run.json"), {
    runId: "run1",
    start: new Date().toISOString(),
    end: null
  });

  const migrated = await migrateRun(runDir);
  assert.equal(migrated, true);

  const raw = await fs.readFile(path.join(runDir, "run.json"), "utf8");
  const updated = JSON.parse(raw) as { schemaVersion: number; pinned: boolean; tags: string[]; status?: string };
  assert.equal(updated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(updated.pinned, false);
  assert.deepEqual(updated.tags, []);
  assert.ok(updated.status);
});
