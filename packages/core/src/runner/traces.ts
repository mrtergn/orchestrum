import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkItemTraceRecord } from "../contracts/service.js";
import { getWorkItemTracesRoot, getWorkspaceTracesRoot } from "./control.js";
import { appendLine, ensureDir, readTextIfExists, writeJson } from "./fs.js";

export type WorkItemTraceWriteInput = Omit<WorkItemTraceRecord, "id" | "ts"> & {
  id?: string;
  ts?: string;
};

export async function appendWorkItemTrace(
  repoPath: string,
  input: WorkItemTraceWriteInput
): Promise<WorkItemTraceRecord> {
  const workItemId = safeSegment(input.workItemId, "work-item");
  const cycleId = safeSegment(input.cycleId ?? "uncategorized", "uncategorized");
  const workstreamId = safeSegment(input.workstreamId ?? "unassigned", "unassigned");
  const workItemRoot = getWorkItemTracesRoot(repoPath, workItemId);
  const workstreamDir = path.join(workItemRoot, cycleId, workstreamId);
  await ensureDir(workstreamDir);

  const record: WorkItemTraceRecord = {
    ...input,
    id: input.id?.trim() || crypto.randomUUID(),
    ts: input.ts?.trim() || new Date().toISOString(),
    cycleId: input.cycleId ?? null,
    workstreamId: input.workstreamId ?? null,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    nodeId: input.nodeId ?? null,
    ownerAgentId: input.ownerAgentId ?? null,
    ownerAgentName: input.ownerAgentName ?? null,
    ownerRole: input.ownerRole ?? null,
    assignmentToAgentId: input.assignmentToAgentId ?? null,
    assignmentToAgentName: input.assignmentToAgentName ?? null,
    providerVendor: input.providerVendor ?? null,
    providerTransport: input.providerTransport ?? null,
    providerModel: input.providerModel ?? null,
    providerEffort: input.providerEffort ?? null,
    promptCountDelta: input.promptCountDelta ?? 0,
    exchangeCountDelta: input.exchangeCountDelta ?? 0,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    estimatedCostUsd: typeof input.estimatedCostUsd === "number" ? input.estimatedCostUsd : null,
    selectionReason: input.selectionReason ?? null,
    omissionReason: input.omissionReason ?? null,
    expectedOutput: input.expectedOutput ?? null,
    gateRefs: [...(input.gateRefs ?? [])],
    handoffToWorkstreamId: input.handoffToWorkstreamId ?? null,
    workstreamTitle: input.workstreamTitle ?? null,
    laneLabel: input.laneLabel ?? null,
    assignmentPrompt: input.assignmentPrompt ?? null,
    promptSummary: input.promptSummary ?? null,
    promptRaw: input.promptRaw ?? null,
    responseSummary: input.responseSummary ?? null,
    responseRaw: input.responseRaw ?? null,
    outputSummary: input.outputSummary ?? null,
    artifacts: [...(input.artifacts ?? [])],
    payload: input.payload ?? {}
  };

  const fileName = `${safeTimestamp(record.ts)}-${record.traceType}-${record.id}.json`;
  await writeJson(path.join(workstreamDir, fileName), record);
  await appendLine(path.join(workItemRoot, "index.ndjson"), JSON.stringify(record));
  return record;
}

export async function loadWorkItemTraces(repoPath: string, workItemId: string): Promise<WorkItemTraceRecord[]> {
  const root = getWorkItemTracesRoot(repoPath, safeSegment(workItemId, "work-item"));
  const raw = await readTextIfExists(path.join(root, "index.ndjson"));
  if (!raw?.trim()) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as WorkItemTraceRecord];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.ts.localeCompare(right.ts));
}

export async function loadWorkspaceTraces(repoPath: string): Promise<WorkItemTraceRecord[]> {
  const tracesRoot = getWorkspaceTracesRoot(repoPath);
  const entries = await fs.readdir(tracesRoot, { withFileTypes: true }).catch(() => []);
  const traces: WorkItemTraceRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    traces.push(...await loadWorkItemTraces(repoPath, entry.name));
  }
  return traces.sort((left, right) => left.ts.localeCompare(right.ts));
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}
