import { test } from "vitest";
import assert from "node:assert/strict";
import { scanGovernedCommands, resolveGovernanceSettings } from "../src/runner/governance.js";

test("governance scan blocks dangerous command", () => {
  const settings = resolveGovernanceSettings(
    { governance: { enabled: true, dangerous_command_guard: true } },
    null
  );
  const findings = scanGovernedCommands(["rm -rf /tmp"], settings);
  assert.ok(findings.length > 0);
});
