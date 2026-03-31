import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceFeature, getLicenseStatus, isFeatureAllowed } from "../src/licensing/index.js";

test("open-source licensing allows every feature", async () => {
  const status = await getLicenseStatus();
  assert.equal(status.valid, true);
  assert.equal(isFeatureAllowed(status.tier, "plugins"), true);
  assert.equal(isFeatureAllowed(status.tier, "analytics"), true);
  assert.doesNotThrow(() => enforceFeature(status.tier, "roadmap"));
});
