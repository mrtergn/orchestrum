import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { Workflow } from "../runner/workflow.js";
import type { RunState } from "../runner/types.js";

export type RunAnalysis = {
  success: boolean;
  auditFailures: number;
  auditBlocks: number;
  devFailures: number;
  policyViolations: number;
  testFailures: number;
  securityAlerts: number;
  loopCount: number;
  totalTokens: number;
  totalCost: number;
  riskScores: number[];
  agentStats: Record<string, { tokens: number; cost: number }>;
  performanceScore: number;
};

export async function analyzeRun(options: {
  runDir: string;
  runMeta: RunState;
  workflow: Workflow;
}): Promise<RunAnalysis> {
  const { runDir, runMeta, workflow } = options;
  const stepsDir = path.join(runDir, "steps");
  const entries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  let auditFailures = 0;
  let auditBlocks = 0;
  let devFailures = 0;
  let testFailures = 0;
  const riskScores: number[] = [];

  const auditStepId = workflow.loop?.audit_step_id ?? "audit";
  const devAgents = Object.entries(workflow.agents)
    .filter(([id, agent]) => id === "dev" || agent.role === "dev")
    .map(([id]) => id);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(stepsDir, entry.name, "status.json");
    const commandsPath = path.join(stepsDir, entry.name, "commands.log");
    try {
      const raw = await fs.readFile(statusPath, "utf8");
      const status = JSON.parse(raw) as { ok?: boolean; agentId?: string | null; riskScore?: number | null };
      if (entry.name === auditStepId && status.ok === false) {
        auditFailures += 1;
      }
      if (devAgents.includes(status.agentId ?? "")) {
        if (status.ok === false) devFailures += 1;
      }
      if (typeof status.riskScore === "number") {
        riskScores.push(status.riskScore);
      }
      if (status.ok === false && fsSync.existsSync(commandsPath)) {
        testFailures += 1;
      }
    } catch {
      // ignore malformed status
    }
  }

  const auditOutputPath = path.join(stepsDir, auditStepId, "output.json");
  const auditRaw = await fs.readFile(auditOutputPath, "utf8").catch(() => "");
  if (auditRaw) {
    try {
      const parsed = JSON.parse(auditRaw) as { blocking?: boolean };
      if (parsed.blocking === true) {
        auditBlocks += 1;
      }
    } catch {
      // ignore
    }
  }

  const eventsPath = path.join(runDir, "events.ndjson");
  const eventLines = await fs.readFile(eventsPath, "utf8").catch(() => "");
  let policyViolations = 0;
  let securityAlerts = 0;
  let loopCount = 0;
  if (eventLines) {
    for (const line of eventLines.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as { t?: string; stepId?: string };
        if (evt.t === "policy.violation") policyViolations += 1;
        if (evt.t === "security.alert") securityAlerts += 1;
        if (evt.t === "step.started" && evt.stepId === auditStepId) loopCount += 1;
      } catch {
        // ignore
      }
    }
  }

  const success = runMeta.status === "finished";
  const totalTokens = runMeta.totalTokens ?? 0;
  const totalCost = runMeta.totalCost ?? 0;
  const agentStats = runMeta.costByAgent ?? {};

  let performanceScore = 1.0;
  if (!success) performanceScore -= 0.2;
  performanceScore -= policyViolations * 0.1;
  performanceScore -= testFailures * 0.1;
  performanceScore -= auditFailures * 0.05;
  performanceScore -= securityAlerts * 0.2;
  if (totalCost > 1) {
    performanceScore -= 0.1;
  }
  performanceScore = clamp(performanceScore, 0, 1);

  return {
    success,
    auditFailures,
    auditBlocks,
    devFailures,
    policyViolations,
    testFailures,
    securityAlerts,
    loopCount,
    totalTokens,
    totalCost,
    riskScores,
    agentStats,
    performanceScore
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
