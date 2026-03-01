import path from "node:path";
import { loadWorkflow } from "../runner/workflow.js";
import { loadAnalytics } from "../analytics/store.js";
import { simulateRun } from "../analytics/simulate.js";
import { loadConfig } from "../runner/config.js";
import { loadStrategy, resolveStrategyProfile, applyStrategy, loadStrategyState } from "../evolution/strategy.js";

export async function simulateWorkflow(options: {
  workflowPath: string;
  repoPath: string;
  workspaceId?: string;
  strategyMode?: string;
  costLimit?: number;
}): Promise<void> {
  const workflow = await loadWorkflow(options.workflowPath);
  const config = await loadConfig(options.repoPath).catch(() => null);
  const strategyConfig = await loadStrategy(options.repoPath).catch(() => null);
  const strategyProfile = resolveStrategyProfile(options.strategyMode ?? strategyConfig?.mode ?? "balanced");
  const strategyState = await loadStrategyState(options.repoPath).catch(() => ({}));
  const applied = applyStrategy({ workflow, policy: null, profile: strategyProfile, state: strategyState });
  const workspacePath = options.repoPath;
  const analytics = await loadAnalytics(workspacePath).catch(() => null);
  const result = simulateRun({
    workflow: applied.workflow,
    analytics,
    config,
    costLimit: options.costLimit
  });

  const payload = {
    workflow: path.basename(options.workflowPath),
    strategy: strategyProfile.mode,
    estimatedTokens: result.estimatedTokens,
    estimatedCost: result.estimatedCost,
    estimatedLoops: result.estimatedLoops,
    estimatedRisk: result.estimatedRisk
  };
  console.log(JSON.stringify(payload, null, 2));
}
