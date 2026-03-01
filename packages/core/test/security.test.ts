import { test } from "node:test";
import assert from "node:assert/strict";
import { scanCommands, scanDiff, requiresApproval } from "../src/security/safety.js";

test("scanCommands flags destructive commands", () => {
  const findings = scanCommands(["rm -rf /", "echo ok"]);
  assert.ok(findings.length >= 1);
  assert.ok(findings.some((f) => f.level === "high"));
  assert.equal(requiresApproval(findings), true);
});

test("scanDiff flags secret exposure", () => {
  const diff = "+ OPENAI_API_KEY=sk-secret\n";
  const findings = scanDiff(diff);
  assert.ok(findings.length >= 1);
  assert.ok(findings.some((f) => f.level === "high"));
});
