import fs from "node:fs/promises";
import path from "node:path";
import type { RunState } from "../runner/types.js";
import type { RunAnalysis } from "./runAnalysis.js";
import { writeJson } from "../runner/fs.js";

export type AnalyticsData = {
  runs: number;
  successes: number;
  failures: number;
  totalCost: number;
  costPerFeature: number;
  perAgent: Record<
    string,
    {
      runs: number;
      successes: number;
      failures: number;
      totalTokens: number;
      totalCost: number;
      avgScore: number;
    }
  >;
  loopCounts: { total: number; avg: number };
  failureTypes: { policy: number; audit: number; test: number; security: number };
  trends: {
    cost: Array<{ ts: string; cost: number }>;
    successRate: Array<{ ts: string; rate: number }>;
    loops: Array<{ ts: string; avg: number }>;
    reward: Array<{ ts: string; reward: number }>;
  };
  testStability: { total: number; failed: number; index: number };
  modelUsage: Record<string, number>;
};

const DEFAULT_ANALYTICS: AnalyticsData = {
  runs: 0,
  successes: 0,
  failures: 0,
  totalCost: 0,
  costPerFeature: 0,
  perAgent: {},
  loopCounts: { total: 0, avg: 0 },
  failureTypes: { policy: 0, audit: 0, test: 0, security: 0 },
  trends: { cost: [], successRate: [], loops: [], reward: [] },
  testStability: { total: 0, failed: 0, index: 1 },
  modelUsage: {}
};

export async function loadAnalytics(workspacePath: string): Promise<AnalyticsData> {
  const filePath = path.join(workspacePath, ".memory", "analytics.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AnalyticsData;
    return {
      ...DEFAULT_ANALYTICS,
      ...parsed,
      trends: { ...DEFAULT_ANALYTICS.trends, ...(parsed.trends ?? {}) },
      modelUsage: parsed.modelUsage ?? {}
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_ANALYTICS };
    }
    throw err;
  }
}

export async function updateAnalytics(
  workspacePath: string,
  analysis: RunAnalysis,
  runMeta: RunState
): Promise<{ analytics: AnalyticsData; agentScores: Record<string, { score: number; avgScore?: number }> }> {
  const analytics = await loadAnalytics(workspacePath);
  analytics.runs += 1;
  if (analysis.success) analytics.successes += 1;
  else analytics.failures += 1;
  analytics.totalCost += analysis.totalCost ?? 0;
  analytics.costPerFeature = analytics.runs ? analytics.totalCost / analytics.runs : 0;

  analytics.failureTypes.policy += analysis.policyViolations;
  analytics.failureTypes.audit += analysis.auditFailures;
  analytics.failureTypes.test += analysis.testFailures;
  analytics.failureTypes.security += analysis.securityAlerts;

  analytics.loopCounts.total += analysis.loopCount;
  analytics.loopCounts.avg = analytics.runs ? analytics.loopCounts.total / analytics.runs : 0;

  analytics.testStability.total += 1;
  analytics.testStability.failed += analysis.testFailures > 0 ? 1 : 0;
  const stabilityBase = analytics.testStability.total || 1;
  analytics.testStability.index = clamp(1 - analytics.testStability.failed / stabilityBase, 0, 1);

  const timestamp = new Date().toISOString();
  analytics.trends.cost.push({ ts: timestamp, cost: analysis.totalCost });
  analytics.trends.successRate.push({
    ts: timestamp,
    rate: analytics.runs ? analytics.successes / analytics.runs : 0
  });
  analytics.trends.loops.push({ ts: timestamp, avg: analytics.loopCounts.avg });
  analytics.trends.reward.push({ ts: timestamp, reward: runMeta.reward ?? 0 });
  analytics.trends.cost = analytics.trends.cost.slice(-50);
  analytics.trends.successRate = analytics.trends.successRate.slice(-50);
  analytics.trends.loops = analytics.trends.loops.slice(-50);
  analytics.trends.reward = analytics.trends.reward.slice(-50);

  for (const [model, count] of Object.entries(runMeta.modelUsage ?? {})) {
    analytics.modelUsage[model] = (analytics.modelUsage[model] ?? 0) + count;
  }

  const agentScores: Record<string, { score: number; avgScore?: number }> = {};
  for (const [agentId, stats] of Object.entries(analysis.agentStats)) {
    const entry = analytics.perAgent[agentId] ?? {
      runs: 0,
      successes: 0,
      failures: 0,
      totalTokens: 0,
      totalCost: 0,
      avgScore: 1
    };
    entry.runs += 1;
    if (analysis.success) entry.successes += 1;
    else entry.failures += 1;
    entry.totalTokens += stats.tokens ?? 0;
    entry.totalCost += stats.cost ?? 0;
    const successRate = entry.runs ? entry.successes / entry.runs : 0;
    const costPenalty = entry.totalCost > 0 ? Math.min(0.3, entry.totalCost / (entry.runs * 2)) : 0;
    entry.avgScore = clamp(successRate - costPenalty, 0, 1);
    analytics.perAgent[agentId] = entry;
    agentScores[agentId] = { score: entry.avgScore, avgScore: entry.avgScore };
  }

  await writeAnalytics(workspacePath, analytics);
  return { analytics, agentScores };
}

async function writeAnalytics(workspacePath: string, analytics: AnalyticsData): Promise<void> {
  const memoryDir = path.join(workspacePath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await writeJson(path.join(memoryDir, "analytics.json"), analytics);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
