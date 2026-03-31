import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDefaultTeamPreset,
  importDeliveryPacketResponse,
  runDeliverySessionDetailed
} from "../src/delivery/index.js";
import { StateIndex } from "../src/state/index.js";

test("state index rebuilds from workspace and run files", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-state-root-"));
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(rootDir, "data"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "data", "workspaces.json"),
    JSON.stringify({ workspaces: [{ id: "demo", path: path.join(rootDir, "repo"), name: "Demo" }] }, null, 2),
    "utf8"
  );
  await fs.mkdir(path.join(rootDir, "repo", ".memory"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "repo", ".memory", "learnings.json"), "[]", "utf8");
  await fs.mkdir(path.join(runsDir, "demo", "run-1"), { recursive: true });
  await fs.writeFile(
    path.join(runsDir, "demo", "run-1", "run.json"),
    JSON.stringify({
      runId: "run-1",
      kind: "mission",
      status: "finished",
      start: new Date().toISOString(),
      end: new Date().toISOString(),
      repoPath: path.join(rootDir, "repo"),
      missionTemplateId: "delivery-sprint",
      readiness: { score: 80, blocking: [] }
    }, null, 2),
    "utf8"
  );

  const index = new StateIndex({
    rootDir,
    runsDir,
    dbPath: path.join(rootDir, "state-index.sqlite")
  });
  const health = await index.rebuild();
  assert.equal(health.ok, true);

  const runs = await index.queryRuns("demo");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runId, "run-1");
  assert.equal(runs[0]!.readinessScore, 80);
});

test("state index SQL statements avoid template interpolation", async () => {
  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "state", "index.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  assert.equal(/WHERE\\s+workspace_id\\s*=\\s*\\$\\{/.test(source), false);
  assert.equal(/INSERT[\\s\\S]{0,200}\\$\\{/.test(source), false);
});

test("state index exposes latest delivery import analysis in summary", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-state-delivery-"));
  const runsDir = path.join(rootDir, "runs");
  const repoPath = path.join(rootDir, "repo");
  await fs.mkdir(path.join(rootDir, "data"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "data", "workspaces.json"),
    JSON.stringify({ workspaces: [{ id: "demo", path: repoPath, name: "Demo" }] }, null, 2),
    "utf8"
  );
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2), "utf8");
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");
  await fs.mkdir(path.join(repoPath, ".memory"), { recursive: true });
  await fs.writeFile(path.join(repoPath, ".memory", "learnings.json"), "[]", "utf8");

  const session = await runDeliverySessionDetailed({
    repoPath,
    runsDir,
    workspaceId: "demo",
    goal: "Index delivery imports",
    selectedPaths: ["src/index.ts"],
    preset: createDefaultTeamPreset()
  });
  const plannerPacket = session.session.packets.find((packet) => packet.roleId === "planner");
  assert.ok(plannerPacket);

  await importDeliveryPacketResponse({
    runsDir,
    runId: session.runId,
    workspaceId: "demo",
    packetId: plannerPacket!.id,
    targetTool: "chatgpt",
    text: ["Status: completed", "Summary: Drafted the implementation plan."].join("\n"),
    source: "paste"
  });

  const index = new StateIndex({
    rootDir,
    runsDir,
    dbPath: path.join(rootDir, "state-index.sqlite")
  });
  await index.rebuild();

  const summary = await index.getDeliverySummary("demo");
  assert.equal(summary.importConfidenceCounts.high, 1);
  assert.equal(summary.latestImport?.runId, session.runId);
  assert.equal(summary.latestImport?.matchStatus, "matched");
  assert.equal(summary.latestImport?.confidence, "high");
  assert.ok((summary.latestImport?.matchReasons ?? []).some((reason) => reason.includes("Requested packet")));
});
