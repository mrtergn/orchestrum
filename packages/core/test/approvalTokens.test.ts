import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approveToken, writeApprovalRequest } from "../src/runner/approvals.js";

test("writeApprovalRequest persists iat/expiresAt defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-approval-"));
  const runDir = path.join(root, "runs", "demo", "run-1");
  await fs.mkdir(runDir, { recursive: true });

  await writeApprovalRequest(runDir, {
    token: "token-defaults",
    runId: "run-1",
    stepId: "implement",
    kind: "command",
    reason: "review",
    findings: [],
    ts: new Date().toISOString()
  });

  const savedRaw = await fs.readFile(path.join(runDir, "approvals", "token-defaults.json"), "utf8");
  const saved = JSON.parse(savedRaw) as { iat?: string; expiresAt?: string };
  assert.ok(saved.iat);
  assert.ok(saved.expiresAt);
});

test("approveToken rejects expired approvals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-approval-"));
  const runsDir = path.join(root, "runs");
  const runDir = path.join(runsDir, "demo", "run-1");
  await fs.mkdir(runDir, { recursive: true });

  await writeApprovalRequest(runDir, {
    token: "token-expired",
    runId: "run-1",
    stepId: "implement",
    kind: "command",
    reason: "review",
    findings: [],
    ts: new Date().toISOString(),
    iat: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-02T00:00:00.000Z"
  });

  const approved = await approveToken(runsDir, "token-expired");
  assert.equal(approved, null);
});
