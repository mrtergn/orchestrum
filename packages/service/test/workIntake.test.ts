import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { ensureWorkspaceManifest, type StateIndex, type WorkItemPlanningDetail } from "@orchestrum/core";
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

  const remediatedDetail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(remediatedDetail.response.status, 200);
  assert.equal(remediatedDetail.body.optimization?.cycles?.length, 1);
  assert.equal(remediatedDetail.body.optimization?.cycles?.[0]?.strategyRecommendation?.status, "pending");
});

test("task graph work items require the browser scenario gate before review", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "pbi",
      title: "ABC · backlog item",
      request: "Implement the backlog item and prove it in the browser.",
      sourceRef: "sprint5.md :: ABC"
    }
  });
  assert.equal(created.response.status, 201);
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const firstStart = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(firstStart.response.status, 200);
  assert.equal(firstStart.body.workItem?.executionMode, "task_graph");
  fixture.updateQueuedTaskStatuses(workItemId, (task) => task.qaMode === "scenario" ? "queued" : "succeeded");

  const blockedDetail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(blockedDetail.response.status, 200);
  assert.equal(blockedDetail.body.teamRuntime?.lanes?.length > 0, true);
  assert.equal(blockedDetail.body.workstreamRuntime?.length > 0, true);
  assert.equal(blockedDetail.body.gateRuntime?.length > 0, true);
  assert.equal(blockedDetail.body.review?.gate, "not_ready");
  assert.equal(
    blockedDetail.body.review?.signals?.some((signal: { label: string; status: string }) => signal.label === "Browser Scenario" && signal.status === "pending"),
    true
  );

  fixture.updateQueuedTaskStatuses(workItemId, () => "succeeded");
  const readyDetail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(readyDetail.response.status, 200);
  assert.equal(readyDetail.body.review?.gate, "ready");
  assert.equal(
    readyDetail.body.review?.signals?.some((signal: { label: string; status: string }) => signal.label === "Browser Scenario" && signal.status === "passed"),
    true
  );
});

test("optimization opportunities can be converted into draft work items", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Harden runtime evidence",
      request: "Capture stronger review follow-ups and keep the audit trail local."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const start = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  const runId = String(start.body.workItem?.linkedRunId ?? "");
  fixture.setWorkspaceRuns("demo", [{
    workspaceId: "demo",
    runId,
    status: "completed",
    verdict: "ready_for_review"
  }]);

  const sendBack = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/review`, {
    method: "POST",
    body: {
      workspaceId: "demo",
      decision: "send_back",
      note: "Create a reliability follow-up."
    }
  });
  assert.equal(sendBack.response.status, 200);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  const optimizationCycle = detail.body.optimization?.cycles?.[0];
  assert.ok(optimizationCycle);
  const opportunityId = optimizationCycle.opportunities?.[0]?.id;
  assert.ok(opportunityId);

  const convert = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/optimization`, {
    method: "POST",
    body: {
      workspaceId: "demo",
      kind: "opportunity",
      action: "convert",
      cycleId: optimizationCycle.id,
      itemId: opportunityId
    }
  });
  assert.equal(convert.response.status, 200);
  assert.equal(convert.body.createdWorkItem?.status, "draft");
  assert.equal(convert.body.createdWorkItem?.brief.sourceRef?.startsWith("opportunity:"), true);
});

test("delivery findings block operator readiness until they are cleared", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Ship a gated delivery",
      request: "Run the feature and block review when delivery findings stay open."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const start = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  const runId = String(start.body.workItem?.linkedRunId ?? "");
  fixture.setWorkspaceRuns("demo", [{
    workspaceId: "demo",
    runId,
    status: "completed",
    verdict: "ready_for_review"
  }]);
  fixture.setDeliverySessions("demo", [{
    workspaceId: "demo",
    runId,
    openFindings: 2,
    remediationsOpen: 1,
    unresolvedManualPackets: 0
  }]);

  const blocked = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(blocked.response.status, 200);
  assert.equal(blocked.body.review?.gate, "not_ready");
  assert.equal(
    blocked.body.review?.signals?.some((signal: { label: string; status: string }) => signal.label === "Delivery findings" && signal.status === "blocked"),
    true
  );
  assert.equal(
    blocked.body.gateRuntime?.some((gate: { type: string; status: string }) => gate.type === "audit" && gate.status === "blocked"),
    true
  );

  fixture.setDeliverySessions("demo", []);
  const ready = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(ready.response.status, 200);
  assert.equal(ready.body.review?.gate, "ready");
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
  const deliverySessionsByWorkspace = new Map<string, Array<{
    workspaceId: string;
    runId: string;
    openFindings: number;
    remediationsOpen: number;
    unresolvedManualPackets: number;
  }>>();
  const queuedTasks: Array<Record<string, unknown>> = [];
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
    listTasks(options?: { workspaceId?: string; workItemId?: string }) {
      return queuedTasks.filter((task) => {
        if (options?.workspaceId && task.workspaceId !== options.workspaceId) return false;
        if (options?.workItemId && task.linkedWorkItemId !== options.workItemId) return false;
        return true;
      });
    },
    async queueWorkItemExecution(options: {
      workspaceId: string;
      workItem: { id: string; brief: { title: string } };
      detail: WorkItemPlanningDetail;
      cycleId: string;
      cycleSequence: number;
      cycleKind: "initial" | "remediation";
    }) {
      const workstreams = options.detail.workstreams.map((workstream) => ({
        ...workstream,
        cycleId: options.cycleId,
        ownerAgentId: `${workstream.laneId}-agent`,
        ownerAgentName: `${workstream.laneLabel} Specialist`,
        ownerRole: workstream.laneId
      }));
      const workstreamById = new Map(workstreams.map((workstream) => [workstream.id, workstream]));
      const plannedTasks = options.detail.tasks.map((plannerTask) => {
        const workstream = plannerTask.workstreamId ? workstreamById.get(plannerTask.workstreamId) ?? null : null;
        return {
          ...plannerTask,
          cycleId: options.cycleId,
          gateRefs: plannerTask.gateRefs ?? workstream?.gateRefs ?? [],
          ownerAgentId: workstream?.ownerAgentId ?? `${plannerTask.laneId}-agent`,
          ownerAgentName: workstream?.ownerAgentName ?? `${plannerTask.laneLabel} Specialist`,
          ownerRole: workstream?.ownerRole ?? plannerTask.laneId
        };
      });
      const plannerTaskToTaskId = new Map<string, string>();
      for (const plannerTask of plannedTasks) {
        plannerTaskToTaskId.set(plannerTask.id, `task-${plannerTask.id}`);
      }
      const createdTasks = plannedTasks.map((plannerTask) => ({
        id: plannerTaskToTaskId.get(plannerTask.id)!,
        workspaceId: options.workspaceId,
        linkedWorkItemId: options.workItem.id,
        linkedWorkItemTitle: options.workItem.brief.title,
        title: plannerTask.title,
        type:
          plannerTask.kind === "planning"
            ? "spec"
            : plannerTask.kind === "validation"
              ? "validate"
              : plannerTask.kind === "qa"
                ? "qa"
                : plannerTask.kind === "review"
                  ? "audit"
                  : "implement",
        status: "queued",
        assignedToAgentId: `${plannerTask.laneId}-agent`,
        ownerAgentId: plannerTask.ownerAgentId,
        ownerAgentName: plannerTask.ownerAgentName,
        ownerRole: plannerTask.ownerRole,
        plannerTaskId: plannerTask.id,
        cycleId: options.cycleId,
        workstreamId: plannerTask.workstreamId ?? null,
        workstreamType: plannerTask.workstreamType ?? null,
        gateRefs: plannerTask.gateRefs ?? [],
        qaMode: plannerTask.qaMode ?? null,
        laneId: plannerTask.laneId,
        laneLabel: plannerTask.laneLabel,
        dependsOnTaskIds: plannerTask.dependsOn.map((dependency) => plannerTaskToTaskId.get(dependency)).filter(Boolean),
        waitingOnTaskIds: [],
        blockedByTaskIds: [],
        resultSummary: undefined
      }));
      for (let index = queuedTasks.length - 1; index >= 0; index -= 1) {
        if (queuedTasks[index]?.linkedWorkItemId === options.workItem.id) {
          queuedTasks.splice(index, 1);
        }
      }
      queuedTasks.push(...createdTasks);
      return {
        taskIds: createdTasks.map((task) => String(task.id)),
        detail: {
          ...options.detail,
          tasks: plannedTasks,
          workstreams
        }
      };
    }
  };
  const stateIndex: Pick<StateIndex, "rebuild" | "queryRuns" | "queryDeliverySessions"> = {
    async rebuild() {
      return { ok: true, rebuilt: true, path: path.join(repoPath, ".orchestrum", "control", "state-index.sqlite") };
    },
    async queryRuns(workspaceId?: string) {
      if (workspaceId) return runsByWorkspace.get(workspaceId) ?? [];
      return Array.from(runsByWorkspace.values()).flat();
    },
    async queryDeliverySessions(workspaceId?: string) {
      if (workspaceId) return deliverySessionsByWorkspace.get(workspaceId) ?? [];
      return Array.from(deliverySessionsByWorkspace.values()).flat();
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
    },
    setDeliverySessions(workspaceId: string, sessions: Array<{
      workspaceId: string;
      runId: string;
      openFindings: number;
      remediationsOpen: number;
      unresolvedManualPackets: number;
    }>) {
      deliverySessionsByWorkspace.set(workspaceId, sessions);
    },
    updateQueuedTaskStatuses(workItemId: string, resolveStatus: (task: Record<string, unknown>) => string) {
      for (const task of queuedTasks) {
        if (task.linkedWorkItemId !== workItemId) continue;
        const status = resolveStatus(task);
        task.status = status;
        task.resultSummary =
          status === "succeeded"
            ? `${String(task.title ?? "Task")} succeeded.`
            : status === "queued"
              ? `${String(task.title ?? "Task")} is still queued.`
              : `${String(task.title ?? "Task")} ${status}.`;
      }
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
