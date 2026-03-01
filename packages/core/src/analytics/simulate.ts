import type { Workflow } from "../runner/workflow.js";
import type { AnalyticsData } from "./store.js";
import { estimateCostUsd, resolvePricing } from "../runner/cost.js";
import type { OrchestrumConfig } from "../runner/config.js";

export type SimulationResult = {
  estimatedTokens: number;
  estimatedCost: number;
  estimatedLoops: number;
  estimatedRisk: number;
};

export function simulateRun(options: {
  workflow: Workflow;
  analytics: AnalyticsData | null;
  config: OrchestrumConfig | null;
  costLimit?: number;
}): SimulationResult {
  const steps = flattenSteps(options.workflow);
  let estimatedTokens = 0;
  let estimatedCost = 0;
  let estimatedRisk = 0.2;

  for (const step of steps) {
    const agent = step.agent ?? "unknown";
    const baselineTokens = options.analytics?.perAgent?.[agent]?.totalTokens
      ? options.analytics!.perAgent[agent].totalTokens / Math.max(1, options.analytics!.perAgent[agent].runs)
      : 1200;
    estimatedTokens += baselineTokens;
    const model = options.workflow.agents[agent]?.model ?? "";
    const pricing = resolvePricing(options.config, model);
    const usage = {
      prompt_tokens: Math.round(baselineTokens * 0.6),
      completion_tokens: Math.round(baselineTokens * 0.4),
      total_tokens: Math.round(baselineTokens)
    };
    estimatedCost += estimateCostUsd(usage, pricing) ?? 0;
  }

  const loopRounds = options.workflow.loop?.max_rounds ?? 1;
  const maxLoopPerStep = options.workflow.loop?.max_loop_per_step ?? loopRounds;
  const estimatedLoops = Math.min(loopRounds, maxLoopPerStep);

  if (options.analytics) {
    estimatedRisk = Math.min(1, (options.analytics.failureTypes.policy + options.analytics.failureTypes.security) / 10);
  }

  if (options.costLimit && estimatedCost > options.costLimit) {
    estimatedRisk = Math.min(1, estimatedRisk + 0.2);
  }

  return {
    estimatedTokens: Math.round(estimatedTokens),
    estimatedCost: Number(estimatedCost.toFixed(4)),
    estimatedLoops,
    estimatedRisk
  };
}

function flattenSteps(workflow: Workflow): Array<{ agent?: string }> {
  const items: Array<{ agent?: string }> = [];
  for (const step of workflow.steps) {
    if (step.parallel && step.substeps) {
      for (const sub of step.substeps) {
        items.push({ agent: sub.agent });
      }
      continue;
    }
    items.push({ agent: step.agent });
  }
  return items;
}
