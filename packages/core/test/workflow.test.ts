import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadWorkflow } from "../src/runner/workflow.js";

test("loadWorkflow parses parallel steps", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-workflow-"));
  const promptPath = path.join(dir, "prompt.md");
  await fs.writeFile(promptPath, "# Prompt", "utf8");

  const yamlPath = path.join(dir, "workflow.yaml");
  await fs.writeFile(
    yamlPath,
    `name: test\nagents:\n  audit:\n    provider: openai\n    model: gpt-5\nsteps:\n  - id: analysis\n    parallel: true\n    prompt: ./prompt.md\n    substeps:\n      - id: security\n        agent: audit\n      - id: perf\n        agent: audit\n`,
    "utf8"
  );

  const workflow = await loadWorkflow(yamlPath);
  assert.equal(workflow.steps[0].parallel, true);
  assert.equal(workflow.steps[0].substeps?.length, 2);
  assert.ok(workflow.steps[0].substeps?.[0].prompt?.includes(dir));
});
