import { test } from "vitest";
import assert from "node:assert/strict";
import { scanCommands, requiresApproval } from "../src/security/safety.js";

test("requiresApproval triggers on high-risk commands", () => {
  const findings = scanCommands(["rm -rf /"]);
  assert.ok(findings.length > 0);
  assert.equal(requiresApproval(findings), true);
});
