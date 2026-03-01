import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResumePlan } from "../src/runner/planning.js";

test("buildResumePlan skips completed steps", () => {
  const stepIds = ["spec", "implement", "audit"];
  const completed = new Set(["spec", "implement"]);
  const plan = buildResumePlan({ stepIds, startIndex: 2, completed });
  assert.deepEqual(Array.from(plan.toRun), ["audit"]);
  assert.deepEqual(Array.from(plan.skipped), ["spec", "implement"]);
});

test("buildResumePlan skips completed steps after start unless forced", () => {
  const stepIds = ["spec", "implement", "audit", "fix"];
  const completed = new Set(["spec", "implement", "audit"]);
  const forceRun = new Set(["audit"]);
  const plan = buildResumePlan({ stepIds, startIndex: 2, completed, forceRun });
  assert.deepEqual(Array.from(plan.toRun), ["audit", "fix"]);
  assert.deepEqual(Array.from(plan.skipped), ["spec", "implement"]);
});
