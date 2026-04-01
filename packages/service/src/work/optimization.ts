import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadMissionRun,
  loadStrategyState,
  registerPromptSuggestions,
  type WorkItemOptimizationCycle,
  type WorkItemOptimizationOpportunity,
  type WorkItemOptimizationPromptSuggestion,
  type WorkItemOptimizationSummary,
  type WorkItemOptimizationStrategyRecommendation,
  type WorkItemPlanningDetail,
  type WorkItemRecord,
  type WorkItemReviewSummary,
  type WorkWorkspaceOptimizationSummary
} from "@orchestrum/core";

type OptimizationTaskSignal = {
  id: string;
  status: string;
  type?: string;
  title?: string;
  linkedRunId?: string;
  resultSummary?: string;
};

export async function generateWorkItemOptimizationCycle(options: {
  workspacePath: string;
  runsDir: string;
  workItem: WorkItemRecord;
  detail: WorkItemPlanningDetail;
  review: WorkItemReviewSummary;
  relatedTasks: OptimizationTaskSignal[];
  sourceStatus: "approved" | "changes_requested" | "failed";
}): Promise<WorkItemOptimizationCycle | null> {
  const cycle = (options.workItem.cycles ?? []).find((entry) => entry.id === options.workItem.currentCycleId) ?? null;
  if (!cycle) return null;

  const promptPaths = await collectCyclePromptPaths({
    runsDir: options.runsDir,
    workspaceId: options.workItem.workspaceId,
    runIds: [
      options.workItem.linkedRunId ?? "",
      ...options.relatedTasks.map((task) => task.linkedRunId ?? "")
    ].filter(Boolean)
  });

  const promptSuggestions = await buildPromptSuggestions({
    workspacePath: options.workspacePath,
    review: options.review,
    detail: options.detail,
    sourceStatus: options.sourceStatus,
    promptPaths,
    runId: options.workItem.linkedRunId ?? cycle.linkedRunId ?? cycle.id
  });

  const strategyRecommendation = await buildStrategyRecommendation({
    workspacePath: options.workspacePath,
    review: options.review,
    sourceStatus: options.sourceStatus
  });

  const opportunities = buildFollowUpOpportunities({
    workItem: options.workItem,
    review: options.review,
    sourceStatus: options.sourceStatus
  });

  return {
    id: crypto.randomUUID(),
    cycleId: cycle.id,
    sequence: cycle.sequence,
    sourceStatus: options.sourceStatus,
    createdAt: new Date().toISOString(),
    promptSuggestions,
    strategyRecommendation,
    opportunities
  };
}

export function upsertWorkItemOptimizationSummary(
  summary: WorkItemOptimizationSummary | null | undefined,
  cycle: WorkItemOptimizationCycle
): WorkItemOptimizationSummary {
  const cycles = (summary?.cycles ?? []).filter((entry) => entry.cycleId !== cycle.cycleId);
  cycles.unshift(cycle);
  return {
    cycles: cycles.slice(0, 20)
  };
}

export function buildWorkspaceOptimizationSummary(
  workItems: WorkItemRecord[]
): WorkWorkspaceOptimizationSummary {
  const pendingPromptSuggestions = workItems.reduce((total, workItem) => total + countPendingPromptSuggestions(workItem), 0);
  const pendingStrategies = workItems.reduce((total, workItem) => total + countPendingStrategies(workItem), 0);
  const pendingOpportunities = workItems.reduce((total, workItem) => total + countPendingOpportunities(workItem), 0);
  const recentCycles = workItems
    .flatMap((workItem) =>
      (workItem.optimization?.cycles ?? []).map((cycle) => ({
        workItemId: workItem.id,
        title: workItem.brief.title,
        cycleId: cycle.cycleId,
        sequence: cycle.sequence,
        sourceStatus: cycle.sourceStatus,
        createdAt: cycle.createdAt
      }))
    )
    .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
    .slice(0, 8);

  return {
    pendingPromptSuggestions,
    pendingStrategies,
    pendingOpportunities,
    recentCycles
  };
}

function countPendingPromptSuggestions(workItem: WorkItemRecord): number {
  return (workItem.optimization?.cycles ?? []).reduce(
    (total, cycle) => total + cycle.promptSuggestions.filter((entry) => entry.status === "pending").length,
    0
  );
}

function countPendingStrategies(workItem: WorkItemRecord): number {
  return (workItem.optimization?.cycles ?? []).reduce((total, cycle) => {
    return total + (cycle.strategyRecommendation?.status === "pending" ? 1 : 0);
  }, 0);
}

function countPendingOpportunities(workItem: WorkItemRecord): number {
  return (workItem.optimization?.cycles ?? []).reduce(
    (total, cycle) => total + cycle.opportunities.filter((entry) => entry.status === "pending").length,
    0
  );
}

async function collectCyclePromptPaths(options: {
  runsDir: string;
  workspaceId: string;
  runIds: string[];
}): Promise<string[]> {
  const promptPaths = new Set<string>();
  for (const runId of options.runIds) {
    const run = await loadMissionRun(path.join(options.runsDir, options.workspaceId, runId)).catch(() => null);
    if (!run || run.kind !== "mission") continue;
    for (const node of run.graph.nodes) {
      if (node.promptPath?.trim()) {
        promptPaths.add(node.promptPath.trim());
      }
    }
  }
  return Array.from(promptPaths);
}

async function buildPromptSuggestions(options: {
  workspacePath: string;
  review: WorkItemReviewSummary;
  detail: WorkItemPlanningDetail;
  sourceStatus: "approved" | "changes_requested" | "failed";
  promptPaths: string[];
  runId: string;
}): Promise<WorkItemOptimizationPromptSuggestion[]> {
  if (options.promptPaths.length === 0) return [];

  const registered = await registerPromptSuggestions({
    workspacePath: options.workspacePath,
    suggestions: await Promise.all(options.promptPaths.map(async (promptPath) => {
      const rationale = buildPromptSuggestionRationale({
        sourceStatus: options.sourceStatus,
        review: options.review,
        qaCoverage: options.detail.qaCoverage
      });
      const content = await fs.readFile(promptPath, "utf8").catch(() => "");
      return {
        promptPath,
        score: options.sourceStatus === "approved" ? 0.82 : 0.61,
        suggestions: rationale,
        proposedPrompt: appendPromptNote(content, rationale),
        runId: options.runId
      };
    }))
  });

  return registered.map((entry) => ({
    id: crypto.randomUUID(),
    promptPath: entry.promptPath,
    label: path.basename(entry.promptPath),
    status: "pending",
    createdAt: new Date().toISOString(),
    score: options.sourceStatus === "approved" ? 0.82 : 0.61,
    rationale: buildPromptSuggestionRationale({
      sourceStatus: options.sourceStatus,
      review: options.review,
      qaCoverage: options.detail.qaCoverage
    }),
    suggestionId: entry.suggestionId
  }));
}

async function buildStrategyRecommendation(options: {
  workspacePath: string;
  review: WorkItemReviewSummary;
  sourceStatus: "approved" | "changes_requested" | "failed";
}): Promise<WorkItemOptimizationStrategyRecommendation | null> {
  const state = await loadStrategyState(options.workspacePath).catch(() => null);
  const mode =
    options.sourceStatus === "approved" && options.review.openRisks.length === 0
      ? "balanced"
      : options.review.signals.some((signal) => signal.status === "failed" || signal.status === "blocked")
        ? "conservative"
        : "balanced";
  const rationale = [
    options.sourceStatus === "approved"
      ? "The previous cycle closed with reviewable evidence."
      : "The previous cycle exposed gaps that need tighter next-cycle control."
  ];
  if (options.review.openRisks.length > 0) {
    rationale.push(options.review.openRisks[0]!);
  }
  if (state?.recommendedMode && state.recommendedMode !== mode) {
    rationale.push(`Previous workspace strategy was ${state.recommendedMode}.`);
  }
  return {
    id: crypto.randomUUID(),
    mode,
    status: "pending",
    createdAt: new Date().toISOString(),
    rationale
  };
}

function buildFollowUpOpportunities(options: {
  workItem: WorkItemRecord;
  review: WorkItemReviewSummary;
  sourceStatus: "approved" | "changes_requested" | "failed";
}): WorkItemOptimizationOpportunity[] {
  const opportunities: WorkItemOptimizationOpportunity[] = [];
  if (options.review.openRisks.length > 0) {
    opportunities.push({
      id: crypto.randomUUID(),
      title: `Follow up on ${options.workItem.brief.title}`,
      description: options.review.openRisks[0]!,
      status: "pending",
      createdAt: new Date().toISOString(),
      rationale: ["Generated from explicit review risk carried out of the previous cycle."],
      riskScore: 0.45
    });
  }
  if (options.sourceStatus !== "approved") {
    opportunities.push({
      id: crypto.randomUUID(),
      title: "Add stronger regression coverage",
      description: "Create a follow-up work item that tightens validation or browser scenario coverage for the changed surface.",
      status: "pending",
      createdAt: new Date().toISOString(),
      rationale: ["The cycle ended without a clean approval path, so follow-up reliability work is justified."],
      riskScore: 0.38
    });
  }
  return opportunities.slice(0, 3);
}

function buildPromptSuggestionRationale(options: {
  sourceStatus: "approved" | "changes_requested" | "failed";
  review: WorkItemReviewSummary;
  qaCoverage: WorkItemPlanningDetail["qaCoverage"];
}): string[] {
  const rationale = [
    options.sourceStatus === "approved"
      ? "Preserve the explicit scope framing that led to an approved cycle."
      : "Bias the prompt toward tighter scope control and clearer evidence capture next time."
  ];
  if (options.qaCoverage === "scenario") {
    rationale.push("Keep scenario-level browser assertions explicit whenever UI coverage is required.");
  }
  const firstRisk = options.review.openRisks[0];
  if (firstRisk) {
    rationale.push(firstRisk);
  }
  return rationale.slice(0, 3);
}

function appendPromptNote(content: string, rationale: string[]): string {
  const trimmed = content.trimEnd();
  const noteBody = rationale.map((entry) => `- ${entry}`).join("\n");
  if (trimmed.includes("## Runtime Optimization Notes")) {
    return `${trimmed}\n${noteBody}\n`;
  }
  return `${trimmed}\n\n## Runtime Optimization Notes\n${noteBody}\n`;
}
