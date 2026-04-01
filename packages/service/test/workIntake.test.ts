import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { ensureWorkspaceManifest, type StateIndex } from "@orchestrum/core";
import { registerWorkIntakeRoutes } from "../src/routes/workIntake.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

let fixture: Fixture | null = null;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  if (fixture) {
    await new Promise<void>((resolve, reject) => {
      fixture.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  fixture = null;
});

test("work intake supports create, detail, start, send back, and relaunch", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Ship a small feature",
      request: "Update the exported value and keep review evidence local."
    }
  });
  assert.equal(created.response.status, 201);
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.ok(Array.isArray(detail.body.detail?.tasks));

  const firstStart = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(firstStart.response.status, 200);
  assert.equal(firstStart.body.workItem?.executionMode, "mission");
  assert.equal(firstStart.body.workItem?.status, "running");
  assert.equal(firstStart.body.workItem?.cycles?.length, 1);
  const firstRunId = String(firstStart.body.workItem?.linkedRunId ?? "");
  assert.ok(firstRunId);

  fixture.setWorkspaceRuns("demo", [{
    workspaceId: "demo",
    runId: firstRunId,
    status: "completed",
    verdict: "ready_for_review"
  }]);

  const sentBack = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/review`, {
    method: "POST",
    body: {
      workspaceId: "demo",
      decision: "send_back",
      note: "Tighten the result before approval."
    }
  });
  assert.equal(sentBack.response.status, 200);
  assert.equal(sentBack.body.workItem?.reviewStatus, "changes_requested");
  assert.equal(sentBack.body.workItem?.status, "blocked");

  const secondStart = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(secondStart.response.status, 200);
  assert.equal(secondStart.body.workItem?.reviewStatus, "pending");
  assert.equal(secondStart.body.workItem?.status, "running");
  assert.equal(secondStart.body.workItem?.cycles?.length, 2);
  assert.equal(secondStart.body.workItem?.cycles?.[1]?.trigger, "review_send_back");
});

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-work-intake-"));
  const repoPath = path.join(rootDir, "repo");
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2), "utf8");
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");
  await ensureWorkspaceManifest(repoPath, { id: "demo", name: "Demo" });

  const runsByWorkspace = new Map<string, Array<{ workspaceId: string; runId: string; status: string; verdict: string | null }>>();
  const agentPlatform = {
    async startMission(options: {
      runsDir: string;
      workspaceId: string;
      repoPath: string;
      templateId: string;
      goal: string;
      runId: string;
    }) {
      const runId = options.runId;
      const existing = runsByWorkspace.get(options.workspaceId) ?? [];
      runsByWorkspace.set(options.workspaceId, [
        ...existing.filter((entry) => entry.runId !== runId),
        { workspaceId: options.workspaceId, runId, status: "running", verdict: "running" }
      ]);
      return { ok: true, runId };
    },
    listTasks() {
      return [];
    },
    async queueWorkItemExecution() {
      return { taskIds: ["task-1"] };
    }
  };
  const stateIndex: Pick<StateIndex, "rebuild" | "queryRuns"> = {
    async rebuild() {
      return { ok: true, rebuilt: true, path: path.join(repoPath, ".orchestrum", "control", "state-index.sqlite") };
    },
    async queryRuns(workspaceId?: string) {
      if (workspaceId) return runsByWorkspace.get(workspaceId) ?? [];
      return Array.from(runsByWorkspace.values()).flat();
    }
  };

  const app = express();
  app.use(express.json());
  registerWorkIntakeRoutes(app, {
    rootDir,
    runsDir,
    stateIndex: stateIndex as StateIndex,
    resolveWorkspacePath: async (workspaceId?: string) => workspaceId === "demo" ? repoPath : null,
    listWorkspacePaths: async () => [repoPath],
    agentPlatform
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
    rootDir,
    repoPath,
    runsDir,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    setWorkspaceRuns(workspaceId: string, runs: Array<{ workspaceId: string; runId: string; status: string; verdict: string | null }>) {
      runsByWorkspace.set(workspaceId, runs);
    }
  };
}

async function requestJson(baseUrl: string, pathname: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
