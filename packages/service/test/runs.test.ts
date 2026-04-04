import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerRunRoutes } from "../src/routes/runs.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

let fixture: Fixture | null = null;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
});

test("runs routes resync from disk when the in-memory index is stale", async () => {
  assert.ok(fixture);

  const listResult = await requestJson(fixture.baseUrl, "/runs?workspace=demo");
  assert.equal(listResult.response.status, 200);
  assert.equal(Array.isArray(listResult.body), true);
  assert.equal(listResult.body.length, 1);
  assert.equal(listResult.body[0]?.runId, "run-1");

  const detailResult = await requestJson(fixture.baseUrl, "/runs/run-1?workspace=demo");
  assert.equal(detailResult.response.status, 200);
  assert.equal(detailResult.body?.run?.runId, "run-1");
  assert.equal(detailResult.body?.run?.status, "completed");
  assert.equal(fixture.syncCalls.length >= 1, true);
});

test("runs overview shows task-graph work as the top-level row and keeps child runs secondary", async () => {
  assert.ok(fixture);

  const overviewResult = await requestJson(fixture.baseUrl, "/runs?view=overview&workspace=demo");
  assert.equal(overviewResult.response.status, 200);
  assert.equal(Array.isArray(overviewResult.body), true);
  assert.equal(overviewResult.body[0]?.itemType, "work_item");
  assert.equal(overviewResult.body[0]?.title, "Audit repo");
  assert.equal(overviewResult.body[0]?.childRunCount, 1);
  assert.equal(overviewResult.body[0]?.childTaskCount, 1);
  assert.equal(overviewResult.body[1]?.itemType, "run");
  assert.equal(overviewResult.body[1]?.parentWorkItemId, "work-item-1");
});

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-runs-route-"));
  const runsDir = path.join(rootDir, "runs");
  const runDir = path.join(runsDir, "demo", "run-1");
  const stepsDir = path.join(runDir, "steps", "step-1");
  const controlDir = path.join(rootDir, ".orchestrum", "control");
  await fs.mkdir(stepsDir, { recursive: true });
  await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify({
      runId: "run-1",
      kind: "qa",
      status: "completed",
      start: new Date().toISOString(),
      end: new Date().toISOString(),
      workspaceId: "demo",
      repoPath: rootDir,
      totalSteps: 1,
      completedSteps: 1
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(stepsDir, "status.json"),
    JSON.stringify({
      id: "step-1",
      title: "Browser smoke",
      status: "completed",
      ok: true,
      summary: "Smoke completed."
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(controlDir, "work-items.json"),
    JSON.stringify([
      {
        id: "work-item-1",
        workspaceId: "demo",
        brief: {
          workspaceId: "demo",
          sourceType: "audit",
          title: "Audit repo",
          request: "Review the repository and surface findings.",
          sourceRef: null,
          acceptanceCriteria: ["Surface concrete findings."],
          constraints: ["Do not edit files."]
        },
        status: "running",
        recommendedTemplateId: "audit-only",
        executionMode: "task_graph",
        linkedRunId: null,
        linkedRunStatus: null,
        linkedRunVerdict: null,
        linkedTaskIds: ["task-1"],
        linkedTaskStatus: "running",
        reviewStatus: "pending",
        reviewNote: null,
        reviewedAt: null,
        currentCycleId: "cycle-1",
        cycles: [],
        remediationPlan: null,
        optimization: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastStartedAt: new Date().toISOString()
      }
    ], null, 2),
    "utf8"
  );

  const syncCalls: Array<{ workspaceId?: string; runId?: string }> = [];
  const records = new Map<string, { runId: string; runDir: string; workspaceId: string; meta: any }>();
  const runIndex = {
    list(filter: { workspaceId?: string; status?: string; tag?: string; search?: string } = {}) {
      return Array.from(records.values())
        .filter((record) => !filter.workspaceId || record.workspaceId === filter.workspaceId)
        .map((record) => record.meta);
    },
    get(runId: string, workspaceId?: string) {
      if (workspaceId) return records.get(`${workspaceId}:${runId}`) ?? null;
      for (const record of records.values()) {
        if (record.runId === runId) return record;
      }
      return null;
    },
    update(runId: string, workspaceId: string, meta: any) {
      const existing = records.get(`${workspaceId}:${runId}`);
      if (existing) {
        existing.meta = meta;
      }
    },
    async sync(filter: { workspaceId?: string; runId?: string } = {}) {
      syncCalls.push(filter);
      const workspaceId = filter.workspaceId ?? "demo";
      const runId = filter.runId ?? "run-1";
      if (workspaceId !== "demo" || runId !== "run-1") return;
      const meta = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8"));
      records.set("demo:run-1", {
        runId: "run-1",
        runDir,
        workspaceId: "demo",
        meta
      });
    }
  };

  const app = express();
  app.use(express.json());
  registerRunRoutes(app, {
    runsDir,
    stateIndex: {
      rebuild: async () => ({ ok: true })
    } as any,
    runIndex,
    agentPlatform: {
      resumeMission: async () => ({ ok: true }),
      listTasks: () => [{
        id: "task-1",
        workspaceId: "demo",
        linkedWorkItemId: "work-item-1",
        linkedRunId: "run-1",
        status: "running"
      }],
      importMissionNode: async () => ({})
    },
    rootDir,
    listWorkspacePaths: async () => [],
    resolveWorkspacePath: async (workspaceId?: string) => workspaceId === "demo" ? rootDir : null
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    syncCalls,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  };
}

async function requestJson(baseUrl: string, pathname: string) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
