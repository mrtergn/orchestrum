import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendLearnings, createLearning, loadLearnings, loadRelevantLearnings } from "../src/runner/learnings.js";

test("learnings are persisted and ranked by relevance", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-learnings-"));
  await appendLearnings(workspacePath, [
    createLearning({
      category: "failure_pattern",
      insight: "Builds often fail in src/server.ts when auth headers are missing.",
      relatedFiles: ["src/server.ts"],
      confidence: 0.8
    }),
    createLearning({
      category: "success_pattern",
      insight: "Use lint before release.",
      relatedFiles: ["package.json"],
      confidence: 0.4
    })
  ]);

  const stored = await loadLearnings(workspacePath);
  assert.equal(stored.length, 2);

  const relevant = await loadRelevantLearnings(workspacePath, "server auth headers", 1);
  assert.equal(relevant.length, 1);
  assert.match(relevant[0]!.insight, /src\/server\.ts/i);
});
