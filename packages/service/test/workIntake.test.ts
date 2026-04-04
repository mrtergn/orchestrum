import { afterEach, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { appendWorkItemTrace, ensureWorkspaceManifest, getWorkspaceAgentsPath, type StateIndex, type WorkItemPlanningDetail } from "@orchestrum/core";
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
  assert.equal(firstStart.body.workItem?.executionMode, "task_graph");
  assert.equal(firstStart.body.workItem?.status, "running");
  assert.equal(firstStart.body.workItem?.cycles?.length, 1);
  fixture.updateQueuedTaskStatuses(workItemId, () => "succeeded");

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
  const scenarioTask = fixture.getQueuedTasks(workItemId).find((task) => task.qaMode === "scenario");
  assert.ok(scenarioTask?.linkedRunId);
  await fixture.writeScenarioRunEvidence("demo", String(scenarioTask?.linkedRunId), [
    { stepId: "scenario-01-goto", action: "goto", ok: true, summary: "Navigated to the dashboard." },
    { stepId: "scenario-02-assertVisible", action: "assertVisible", ok: true, summary: "Verified the critical dashboard card is visible." },
    { stepId: "scenario-03-assertText", action: "assertText", ok: true, summary: "Verified the dashboard confirmation text." }
  ]);
  const readyDetail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(readyDetail.response.status, 200);
  assert.equal(readyDetail.body.review?.gate, "ready");
  assert.equal(
    readyDetail.body.review?.signals?.some((signal: { label: string; status: string }) => signal.label === "Browser Scenario" && signal.status === "passed"),
    true
  );
  const scenarioGate = readyDetail.body.gateRuntime?.find((gate: { type: string }) => gate.type === "qa_scenario");
  assert.equal(scenarioGate?.evidenceRunId, String(scenarioTask?.linkedRunId));
  assert.equal(scenarioGate?.assertionTotals?.passed, 2);
  assert.equal(String(scenarioGate?.satisfiedBy ?? "").includes("passed 2/2 assertion step"), true);
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
  assert.equal(start.response.status, 200);
  fixture.updateQueuedTaskStatuses(workItemId, () => "succeeded");

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
      sourceType: "pbi",
      title: "Ship a gated delivery",
      request: "Run the feature and block review when delivery findings stay open.",
      sourceRef: "sprint5.md :: gated-delivery"
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const start = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(start.response.status, 200);
  fixture.updateQueuedTaskStatuses(workItemId, () => "succeeded");
  const deliveryRunId = String(fixture.getQueuedTasks(workItemId)[0]?.linkedRunId ?? "");
  assert.ok(deliveryRunId);
  fixture.setDeliverySessions("demo", [{
    workspaceId: "demo",
    runId: deliveryRunId,
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

test("live send back cancels the paused child run and stages remediation", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Send back a paused child run",
      request: "Pause a child run for review, then send it back from the live session path."
    }
  });
  assert.equal(created.response.status, 201);
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const started = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(started.response.status, 200);

  const liveTask = fixture.getQueuedTasks(workItemId)[0];
  assert.ok(liveTask?.id);
  assert.ok(liveTask?.linkedRunId);

  fixture.updateQueuedTaskStatuses(workItemId, (task) => task.id === liveTask?.id ? "paused" : "succeeded");
  fixture.setWorkspaceRuns("demo", [{
    workspaceId: "demo",
    runId: String(liveTask?.linkedRunId ?? ""),
    status: "paused",
    verdict: "needs_human_review",
    recovery: {
      status: "attention_required",
      kind: "approval_pause",
      summary: "Awaiting operator review.",
      guidance: ["Review the generated diff before deciding whether it can proceed."],
      blockingStepId: "implement",
      blockingStepTitle: "Implement",
      artifacts: [],
      suggestedActions: []
    }
  }]);

  const sentBack = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/review`, {
    method: "POST",
    body: {
      workspaceId: "demo",
      decision: "send_back",
      note: "Rework the implementation lane.",
      targetRunId: liveTask?.linkedRunId,
      targetTaskId: liveTask?.id
    }
  });
  assert.equal(sentBack.response.status, 200);
  assert.equal(sentBack.body.workItem?.reviewStatus, "changes_requested");
  assert.equal(sentBack.body.workItem?.status, "blocked");
  assert.equal(sentBack.body.review?.gate, "changes_requested");

  const updatedLiveTask = fixture.getQueuedTasks(workItemId).find((task) => task.id === liveTask?.id);
  assert.equal(updatedLiveTask?.status, "cancelled");
  assert.match(String(updatedLiveTask?.resultSummary ?? ""), /Operator requested changes/i);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.recovery ?? null, null);
  assert.equal(detail.body.review?.gate, "changes_requested");
  assert.equal(detail.body.teamRuntime?.nextHandoff !== "Operator review", true);
});

test("small backend features synthesize a minimal team and omit UI lanes", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Add backend endpoint",
      request: "Add a backend endpoint and update service response serialization. This is server-only work."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  const teamSelection = Array.isArray(detail.body.teamSelection) ? detail.body.teamSelection : [];
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => ["backend", "developer"].includes(entry.laneId) && entry.decision === "selected"), true);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "qa" && entry.decision === "selected"), false);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "frontend" && entry.decision === "selected"), false);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "tester" && entry.decision === "selected"), false);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "audit" && entry.decision === "selected"), true);
  assert.equal(
    Array.isArray(detail.body.detail?.selectionRationale) &&
      detail.body.detail.selectionRationale.some((reason: string) => reason.includes("backend/API/data-focused")),
    true
  );
  assert.equal(
    Array.isArray(detail.body.detail?.gates) &&
      detail.body.detail.gates.some((gate: { type: string }) => gate.type === "validation"),
    false
  );
});

test("audit work items stay review-focused instead of opening implementation lanes", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "audit",
      title: "Audit repository",
      request: "Review the current repo state and return findings only."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.workItem?.brief?.sourceType, "audit");

  const teamSelection = Array.isArray(detail.body.teamSelection) ? detail.body.teamSelection : [];
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "pm" && entry.decision === "selected"), true);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "audit" && entry.decision === "selected"), true);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => ["frontend", "backend", "developer", "tester", "qa"].includes(entry.laneId) && entry.decision === "selected"), false);
  assert.equal(
    Array.isArray(detail.body.detail?.tasks) &&
      detail.body.detail.tasks.every((task: { laneId: string }) => ["pm", "audit"].includes(task.laneId)),
    true
  );
  assert.equal(
    Array.isArray(detail.body.detail?.workstreams) &&
      detail.body.detail.workstreams.every((workstream: { type: string }) => ["plan", "audit"].includes(workstream.type)),
    true
  );
});

test("audit work items can request browser evidence without opening implementation lanes", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "audit",
      title: "Audit browser regression",
      request: "Review the current repo state, return findings only, and run a browser scenario gate for the checkout journey."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);

  const selectedLanes = Array.isArray(detail.body.teamSelection)
    ? detail.body.teamSelection
        .filter((entry: { decision: string }) => entry.decision === "selected")
        .map((entry: { laneId: string }) => entry.laneId)
    : [];

  assert.deepEqual(selectedLanes.sort(), ["audit", "pm", "qa"]);
  assert.equal(
    Array.isArray(detail.body.detail?.workstreams) &&
      detail.body.detail.workstreams.some((workstream: { type: string }) => workstream.type === "qa_scenario"),
    true
  );
  assert.equal(
    Array.isArray(detail.body.detail?.workstreams) &&
      detail.body.detail.workstreams.some((workstream: { type: string }) => workstream.type === "implement"),
    false
  );
});

test("ui-heavy features synthesize frontend and browser QA lanes", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Update dashboard filter flow",
      request: "Update the dashboard page and modal flow for the critical user journey. Add a browser scenario gate for the filter experience."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  const teamSelection = Array.isArray(detail.body.teamSelection) ? detail.body.teamSelection : [];
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "frontend" && entry.decision === "selected"), true);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "qa" && entry.decision === "selected"), true);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "backend" && entry.decision === "selected"), false);
  assert.equal(detail.body.detail?.qaCoverage, "scenario");
});

test("cross-stack features synthesize frontend, backend, and integration lanes", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Save dashboard preferences",
      request: "Add a dashboard settings page and a backend API endpoint to save user preferences across sessions."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  const teamSelection = Array.isArray(detail.body.teamSelection) ? detail.body.teamSelection : [];
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "frontend" && entry.decision === "selected"), true);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "backend" && entry.decision === "selected"), true);
  assert.equal(teamSelection.some((entry: { laneId: string; decision: string }) => entry.laneId === "developer" && entry.decision === "selected"), true);
  assert.equal(
    Array.isArray(detail.body.detail?.workstreams) &&
      detail.body.detail.workstreams.some((workstream: { type: string }) => workstream.type === "integrate"),
    true
  );
  assert.equal(
    Array.isArray(detail.body.detail?.gates) &&
      detail.body.detail.gates.some((gate: { type: string }) => gate.type === "validation"),
    true
  );
});

test("explicit validation commands become a first-class validation contract", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Add backend validation contract",
      request: "Add the backend endpoint and run `npm test` plus `npm run lint` before review."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.detail?.validationContract?.required, true);
  assert.equal(detail.body.detail?.validationContract?.source, "explicit");
  assert.deepEqual(detail.body.detail?.validationContract?.commands, ["npm test", "npm run lint"]);
});

test("high-risk cross-stack cycles surface audit risk in the gate payload", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Auth migration across dashboard and API",
      request: "Add a dashboard auth settings page, a backend API endpoint, and a schema migration for token rotation."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const start = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(start.response.status, 200);
  fixture.updateQueuedTaskStatuses(workItemId, () => "succeeded");

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.detail?.auditRisk?.level, "high");
  const auditGate = detail.body.gateRuntime?.find((gate: { type: string }) => gate.type === "audit");
  assert.equal(auditGate?.riskLevel, "high");
  assert.equal(Array.isArray(auditGate?.riskReasons), true);
  assert.equal((auditGate?.riskReasons?.length ?? 0) > 0, true);
});

test("work item detail and traces expose selection, assignment, and runtime cost truth", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "pbi",
      title: "Backend work item with runtime traces",
      request: "Implement the backend backlog item and keep the runtime trace inspectable."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const started = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.workItem?.executionMode, "task_graph");

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(Array.isArray(detail.body.teamSelection), true);
  assert.equal(typeof detail.body.traceSummary?.promptCount, "number");
  assert.equal(detail.body.traceSummary?.promptCount > 0, true);
  assert.equal(
    detail.body.workstreamRuntime?.some((entry: { promptCount?: number }) => (entry.promptCount ?? 0) > 0),
    true
  );

  const traces = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/traces?workspace=demo`);
  assert.equal(traces.response.status, 200);
  assert.equal(traces.body.traceSummary?.promptCount > 0, true);
  assert.equal(
    traces.body.workstreamTrace?.some((group: { traces?: Array<{ traceType?: string }> }) =>
      Array.isArray(group.traces) && group.traces.some((trace) => trace.traceType === "assignment" || trace.traceType === "selection")
    ),
    true
  );

  const runtime = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/team-runtime?workspace=demo`);
  assert.equal(runtime.response.status, 200);
  assert.equal(Array.isArray(runtime.body.teamSelection), true);
  assert.equal(runtime.body.traceSummary?.promptCount > 0, true);
});

test("paused approval child runs stay live and surface parent recovery truth", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Review paused child runs",
      request: "Add a dashboard settings page and backend API endpoint so the cycle opens parallel frontend and backend workstreams."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const started = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(started.response.status, 200);

  const queuedTasks = fixture.getQueuedTasks(workItemId);
  const pausedTasks = queuedTasks.filter((task) => ["frontend", "backend"].includes(String(task.laneId ?? "")));
  assert.equal(pausedTasks.length >= 2, true);

  fixture.updateQueuedTaskStatuses(workItemId, (task) => {
    const laneId = String(task.laneId ?? "");
    if (laneId === "pm") return "succeeded";
    if (laneId === "frontend" || laneId === "backend") return "paused";
    return "blocked";
  });

  const pausedTaskIds = pausedTasks.map((task) => String(task.id));
  for (const task of fixture.getQueuedTasks(workItemId)) {
    const laneId = String(task.laneId ?? "");
    if (!["developer", "tester", "qa", "audit"].includes(laneId)) continue;
    task.blockedByTaskIds = [...pausedTaskIds];
    task.resultSummary = `Blocked by upstream tasks: ${pausedTaskIds.join(", ")}`;
  }

  fixture.setWorkspaceRuns("demo", pausedTasks.map((task) => ({
    workspaceId: "demo",
    runId: String(task.linkedRunId ?? `run-${String(task.id)}`),
    status: "paused",
    verdict: "blocked",
    recovery: {
      status: "attention_required",
      kind: "approval_pause",
      summary: "Potential secret exposure detected in diff. Destructive migration keywords found in diff.",
      guidance: [
        "Review the generated diff before resuming the child run.",
        "Approve and resume the run only after the paused patch is acceptable."
      ],
      artifacts: [
        { label: "Suggested diff", path: "git.diff", mimeType: "text/x-diff" }
      ],
      suggestedActions: [
        {
          kind: "resume_run",
          label: "Resume paused run",
          detail: "Resume the child run after approval.",
          runId: String(task.linkedRunId ?? `run-${String(task.id)}`)
        }
      ],
      updatedAt: new Date().toISOString(),
      blockingStepId: "review-diff",
      blockingStepTitle: "Review generated diff"
    }
  })));

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.workItem?.status, "running");
  assert.equal(detail.body.workItem?.linkedTaskStatus, "paused");
  assert.equal(detail.body.recovery?.source, "task_graph");
  assert.equal(detail.body.recovery?.kind, "approval_pause");
  assert.equal(detail.body.recovery?.taskIds?.length, pausedTasks.length);
  assert.match(detail.body.recovery?.headline ?? "", /waiting for operator review/i);
  assert.equal(
    detail.body.recovery?.suggestedActions?.some((action: { kind: string }) => action.kind === "resume_run"),
    true
  );
  assert.equal(detail.body.teamRuntime?.headline, `${pausedTasks.length} lanes are waiting for operator review.`);
  assert.match(detail.body.teamRuntime?.currentStage ?? "", /paused awaiting operator review/i);
  assert.equal(
    detail.body.teamRuntime?.lanes?.filter((lane: { status: string }) => lane.status === "blocked")?.length,
    4
  );
  assert.equal(
    detail.body.teamRuntime?.lanes?.filter((lane: { status: string }) => lane.status === "paused")?.length,
    pausedTasks.length
  );
});

test("work item detail exposes blocked recovery guidance from linked task runs", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Recover blocked backend patch",
      request: "Add a backend change and make recovery guidance visible when patch apply is blocked."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const started = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(started.response.status, 200);

  const blockedTask = fixture.getQueuedTasks(workItemId).find((task) => task.type === "implement") ?? fixture.getQueuedTasks(workItemId)[0];
  assert.ok(blockedTask);
  fixture.updateQueuedTaskStatuses(workItemId, (task) => String(task.id) === String(blockedTask?.id) ? "blocked" : "succeeded");
  fixture.setWorkspaceRuns("demo", [{
    workspaceId: "demo",
    runId: String(blockedTask?.linkedRunId ?? "run-blocked"),
    status: "blocked",
    verdict: "blocked",
    recovery: {
      status: "attention_required",
      kind: "dirty_tree",
      summary: "Patch apply blocked because local repo state overlaps the generated diff.",
      guidance: [
        "Inspect git status for overlapping files.",
        "Commit, stash, or clean the conflicting files before retrying."
      ],
      artifacts: [
        { label: "Conflict summary", path: "conflict-summary.md", mimeType: "text/markdown" }
      ],
      suggestedActions: [
        { kind: "resume_run", label: "Resume blocked run", detail: "Retry patch apply after cleanup.", runId: String(blockedTask?.linkedRunId ?? "run-blocked") }
      ],
      updatedAt: new Date().toISOString(),
      blockingStepId: "patch",
      blockingStepTitle: "Apply generated patch"
    }
  }]);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.recovery?.source, "task_graph");
  assert.equal(detail.body.recovery?.kind, "dirty_tree");
  assert.equal(detail.body.recovery?.suggestedActions?.some((action: { kind: string }) => action.kind === "retry_task"), true);
  assert.equal(detail.body.recovery?.artifacts?.some((artifact: { path: string }) => artifact.path === "conflict-summary.md"), true);
});

test("work item detail explains blocking audit findings instead of generic task failure", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Review audit findings",
      request: "Run the cycle and surface blocking audit findings clearly in the work item detail."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const started = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(started.response.status, 200);

  const auditTask = fixture.getQueuedTasks(workItemId).find((task) => task.type === "audit") ?? fixture.getQueuedTasks(workItemId).at(-1);
  assert.ok(auditTask);
  fixture.updateQueuedTaskStatuses(workItemId, (task) => String(task.id) === String(auditTask?.id) ? "blocked" : "succeeded");
  if (auditTask) {
    auditTask.resultSummary = "Audit recorded 2 blocking findings.";
  }
  fixture.setWorkspaceRuns("demo", [{
    workspaceId: "demo",
    runId: String(auditTask?.linkedRunId ?? "run-audit-findings"),
    status: "blocked",
    verdict: "blocked",
    recovery: {
      status: "attention_required",
      kind: "audit_findings",
      summary: "Audit recorded 2 blocking findings.",
      guidance: [
        "Review the preserved audit findings before retrying the task.",
        "Fix the repository issues, then rerun the audit."
      ],
      artifacts: [
        { label: "Audit findings JSON", path: "output.json", mimeType: "application/json" },
        { label: "Suggested fix diff", path: "suggested_fix.diff", mimeType: "text/x-diff" }
      ],
      suggestedActions: [
        { kind: "inspect_artifact", label: "Review audit findings", detail: "Inspect the preserved audit output.", artifactPath: "output.json" }
      ],
      updatedAt: new Date().toISOString(),
      blockingStepId: "audit",
      blockingStepTitle: "Audit review"
    }
  }]);

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.recovery?.kind, "audit_findings");
  assert.match(detail.body.recovery?.headline ?? "", /blocking findings/i);
  assert.equal(detail.body.recovery?.artifacts?.some((artifact: { path: string }) => artifact.path === "output.json"), true);
  assert.equal(
    detail.body.recovery?.suggestedActions?.some((action: { label: string }) => /rerun audit task after fixes/i.test(action.label)),
    true
  );
});

test("work item detail loads failed task recovery directly from run artifacts when the state index is stale", async () => {
  assert.ok(fixture);

  const created = await requestJson(fixture.baseUrl, "/api/work-items", {
    method: "POST",
    body: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Recover timed out audit",
      request: "Surface the linked audit timeout summary even when indexed run metadata is stale."
    }
  });
  const workItemId = String(created.body.workItem?.id ?? "");
  assert.ok(workItemId);

  const started = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/start`, {
    method: "POST",
    body: { workspaceId: "demo" }
  });
  assert.equal(started.response.status, 200);

  const auditTask = fixture.getQueuedTasks(workItemId).find((task) => task.type === "audit") ?? fixture.getQueuedTasks(workItemId).at(-1);
  assert.ok(auditTask);
  fixture.updateQueuedTaskStatuses(workItemId, (task) => String(task.id) === String(auditTask?.id) ? "failed" : "succeeded");
  if (auditTask) {
    auditTask.resultSummary = "Mission failed.";
  }

  const linkedRunId = String(auditTask?.linkedRunId ?? "run-audit-timeout");
  const runDir = path.join(fixture.runsDir, "demo", linkedRunId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify({
      runId: linkedRunId,
      kind: "mission",
      status: "failed",
      verdict: "failed",
      error: "Mission failed.",
      recovery: {
        status: "attention_required",
        kind: "unknown",
        summary: "Codex cli (gpt-5) timed out after 90000ms.",
        guidance: [
          "Inspect the failed step artifacts and logs to determine the actual failure mode.",
          "Fix the underlying repository or environment issue before retrying execution."
        ],
        artifacts: [],
        suggestedActions: [],
        updatedAt: new Date().toISOString(),
        blockingStepId: "audit",
        blockingStepTitle: "Audit work"
      }
    }, null, 2),
    "utf8"
  );

  const detail = await requestJson(fixture.baseUrl, `/api/work-items/${workItemId}/detail?workspace=demo`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.recovery?.source, "task_graph");
  assert.equal(detail.body.recovery?.kind, "unknown");
  assert.equal(detail.body.recovery?.blockingStepTitle, "Audit work");
  assert.match(detail.body.recovery?.summary ?? "", /timed out after 90000ms/i);
});

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-work-intake-"));
  const repoPath = path.join(rootDir, "repo");
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2), "utf8");
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");
  await ensureWorkspaceManifest(repoPath, { id: "demo", name: "Demo" });
  await fs.writeFile(
    getWorkspaceAgentsPath(repoPath),
    JSON.stringify([
      { id: "pm-agent", name: "PM Agent", role: "pm", profile: { specialization: "pm", seniority: "lead", maxParallelWork: 1 }, status: { state: "idle" } },
      { id: "frontend-agent", name: "Frontend Agent", role: "dev", profile: { specialization: "frontend", seniority: "senior", maxParallelWork: 2 }, status: { state: "idle" } },
      { id: "backend-agent", name: "Backend Agent", role: "dev", profile: { specialization: "backend", seniority: "senior", maxParallelWork: 2 }, status: { state: "idle" } },
      { id: "fullstack-agent", name: "Fullstack Agent", role: "dev", profile: { specialization: "fullstack", seniority: "senior", maxParallelWork: 2 }, status: { state: "idle" } },
      { id: "tester-agent", name: "Tester Agent", role: "dev", profile: { specialization: "tester", seniority: "mid", maxParallelWork: 2 }, status: { state: "idle" } },
      { id: "qa-agent", name: "QA Agent", role: "dev", profile: { specialization: "qa", seniority: "mid", maxParallelWork: 1 }, status: { state: "idle" } },
      { id: "audit-agent", name: "Audit Agent", role: "audit", profile: { specialization: "audit", seniority: "senior", maxParallelWork: 1 }, status: { state: "idle" } }
    ], null, 2),
    "utf8"
  );

  const runsByWorkspace = new Map<string, Array<{ workspaceId: string; runId: string; status: string; verdict: string | null; recovery?: Record<string, unknown> | null; error?: string | null }>>();
  const deliverySessionsByWorkspace = new Map<string, Array<{
    workspaceId: string;
    runId: string;
    openFindings: number;
    remediationsOpen: number;
    unresolvedManualPackets: number;
  }>>();
  const queuedTasks: Array<Record<string, unknown>> = [];
  const agentPlatform = {
    async ensureWorkspaceLaunchAgents() {
      return [];
    },
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
    async sendBackPausedTaskRun(options: {
      workspaceId: string;
      workItemId?: string;
      taskId?: string;
      runId?: string;
      note?: string | null;
    }) {
      const task = queuedTasks.find((entry) => {
        if (entry.workspaceId !== options.workspaceId) return false;
        if (options.workItemId && entry.linkedWorkItemId !== options.workItemId) return false;
        if (options.taskId && entry.id !== options.taskId) return false;
        if (options.runId && entry.linkedRunId !== options.runId) return false;
        if (!options.taskId && !options.runId) return false;
        return true;
      });
      if (!task) {
        throw new Error("Selected live task could not be found.");
      }
      if (task.status !== "paused") {
        throw new Error("Selected live task is no longer paused.");
      }
      const runId = String(task.linkedRunId ?? options.runId ?? "");
      if (!runId) {
        throw new Error("Selected live task does not have a linked run.");
      }
      task.status = "cancelled";
      task.resultSummary = options.note?.trim()
        ? `Operator requested changes: ${options.note.trim()}`
        : "Operator requested changes.";
      const runs = runsByWorkspace.get(options.workspaceId) ?? [];
      runsByWorkspace.set(options.workspaceId, runs.map((entry) =>
        entry.runId === runId
          ? {
              ...entry,
              status: "cancelled",
              verdict: "blocked",
              recovery: null,
              error: String(task.resultSummary ?? "Operator requested changes.")
            }
          : entry
      ));
      return {
        ok: true,
        taskId: String(task.id),
        runId,
        taskStatus: String(task.status),
        runStatus: "cancelled"
      };
    },
    async queueWorkItemExecution(options: {
      workspaceId: string;
      workItem: { id: string; brief: { title: string } };
      detail: WorkItemPlanningDetail;
      cycleId: string;
      cycleSequence: number;
      cycleKind: "initial" | "remediation";
    }) {
      const selectionByLane = new Map(options.detail.teamSelection.map((selection) => [selection.laneId, selection]));
      const assignmentByLane = new Map(options.detail.teamAssignments.map((assignment) => [assignment.laneId, assignment]));
      const workstreams = options.detail.workstreams.map((workstream) => ({
        ...workstream,
        cycleId: options.cycleId,
        ownerAgentId: selectionByLane.get(workstream.laneId)?.chosenAgentId ?? assignmentByLane.get(workstream.laneId)?.matches?.[0]?.id ?? `${workstream.laneId}-agent`,
        ownerAgentName: selectionByLane.get(workstream.laneId)?.chosenAgentName ?? assignmentByLane.get(workstream.laneId)?.matches?.[0]?.name ?? `${workstream.laneLabel} Specialist`,
        ownerRole: selectionByLane.get(workstream.laneId)?.chosenRole ?? assignmentByLane.get(workstream.laneId)?.preferredRole ?? workstream.laneId
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
        assignedToAgentId: plannerTask.ownerAgentId ?? `${plannerTask.laneId}-agent`,
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
        linkedRunId: `run-${plannerTask.id}`,
        resultSummary: undefined
      }));
      for (let index = queuedTasks.length - 1; index >= 0; index -= 1) {
        if (queuedTasks[index]?.linkedWorkItemId === options.workItem.id) {
          queuedTasks.splice(index, 1);
        }
      }
      queuedTasks.push(...createdTasks);
      for (const task of createdTasks) {
        await appendWorkItemTrace(repoPath, {
          workspaceId: options.workspaceId,
          workItemId: options.workItem.id,
          cycleId: options.cycleId,
          workstreamId: typeof task.workstreamId === "string" ? task.workstreamId : null,
          taskId: String(task.id),
          traceType: "assignment",
          ownerAgentId: typeof task.ownerAgentId === "string" ? task.ownerAgentId : null,
          ownerAgentName: typeof task.ownerAgentName === "string" ? task.ownerAgentName : null,
          ownerRole: typeof task.ownerRole === "string" ? task.ownerRole : null,
          assignmentToAgentId: String(task.assignedToAgentId),
          assignmentToAgentName: typeof task.ownerAgentName === "string" ? task.ownerAgentName : null,
          laneLabel: typeof task.laneLabel === "string" ? task.laneLabel : null,
          workstreamTitle: workstreamById.get(String(task.workstreamId ?? ""))?.title ?? null,
          promptCountDelta: 1,
          summary: `${String(task.ownerAgentName ?? task.assignedToAgentId)} assigned ${String(task.title)}.`,
          assignmentPrompt: `Task title: ${String(task.title)}\n\n${String(task.resultSummary ?? "Queued task")}`
        });
      }
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
    setWorkspaceRuns(workspaceId: string, runs: Array<{ workspaceId: string; runId: string; status: string; verdict: string | null; recovery?: Record<string, unknown> | null; error?: string | null }>) {
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
    },
    getQueuedTasks(workItemId: string) {
      return queuedTasks.filter((task) => task.linkedWorkItemId === workItemId);
    },
    async writeScenarioRunEvidence(
      workspaceId: string,
      runId: string,
      steps: Array<{ stepId: string; action: string; ok: boolean; summary: string }>
    ) {
      const runDir = path.join(runsDir, workspaceId, runId);
      for (const step of steps) {
        const stepDir = path.join(runDir, "steps", step.stepId);
        await fs.mkdir(stepDir, { recursive: true });
        await fs.writeFile(
          path.join(stepDir, "summary.json"),
          JSON.stringify({
            action: step.action,
            ok: step.ok,
            durationMs: 120,
            summary: step.summary
          }, null, 2),
          "utf8"
        );
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
