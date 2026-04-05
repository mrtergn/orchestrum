import { test, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { buildWorkItemPlanningDetail } from "../src/work/planning.js";
import type { WorkItemRecord } from "@orchestrum/core";

test("routes frontend+backend into parallel workstreams with integration and validation", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-ws-"));

  const now = new Date().toISOString();
  const workItem: WorkItemRecord = {
    id: "wi-multilane-1",
    workspaceId: "demo",
    brief: {
      workspaceId: "demo",
      sourceType: "feature",
      title: "Dashboard UI with API",
      request: [
        "Build a dashboard page (frontend UI) and expose a backend API endpoint to serve data.",
        "Ensure the page consumes the API and renders results."
      ].join(" "),
      sourceRef: null,
      acceptanceCriteria: [
        "UI renders latest metrics",
        "API returns JSON payload"
      ],
      constraints: []
    },
    status: "draft",
    recommendedTemplateId: "feature-dev",
    executionMode: null,
    linkedRunId: null,
    linkedRunStatus: null,
    linkedRunVerdict: null,
    linkedTaskIds: [],
    linkedTaskStatus: null,
    reviewStatus: "pending",
    reviewNote: null,
    reviewedAt: null,
    currentCycleId: null,
    cycles: [],
    remediationPlan: null,
    optimization: null,
    createdAt: now,
    updatedAt: now,
    lastStartedAt: null
  };

  const detail = await buildWorkItemPlanningDetail({ workspacePath, workItem });

  // Expect parallel implement workstreams for frontend and backend
  const implementStreams = detail.workstreams.filter((s) => s.type === "implement");
  const implementLaneIds = new Set(implementStreams.map((s) => s.laneId));
  expect(implementStreams.length).toBeGreaterThanOrEqual(2);
  expect(implementLaneIds.has("frontend")).toBe(true);
  expect(implementLaneIds.has("backend")).toBe(true);

  // Integration stream should exist and depend on both implement streams
  const integrate = detail.workstreams.find((s) => s.type === "integrate");
  expect(integrate).toBeTruthy();
  const upstreamImplementIds = implementStreams.map((s) => s.id);
  for (const upstream of upstreamImplementIds) {
    expect(integrate!.dependsOn).toContain(upstream);
  }
  expect(integrate!.laneId).toBe("developer");

  // Validation should be present and depend on integration slice
  const validate = detail.workstreams.find((s) => s.type === "validate");
  expect(validate).toBeTruthy();
  expect(validate!.dependsOn).toContain(integrate!.id);

  // Gates should include Validation (risk-based) for multi-lane integration
  const validationGate = detail.gates.find((g) => g.type === "validation");
  expect(validationGate).toBeTruthy();
  expect(validationGate!.workstreamIds).toContain(validate!.id);
});

