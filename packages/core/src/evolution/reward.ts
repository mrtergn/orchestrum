import fs from "node:fs/promises";
import path from "node:path";
import type { RunAnalysis } from "../analytics/runAnalysis.js";
import type { RunState } from "../runner/types.js";
import type { Workflow } from "../runner/workflow.js";
import type { OrchestrumConfig } from "../runner/config.js";
import { writeJson } from "../runner/fs.js";

export type RewardConfig = {
  success_weight: number;
  cost_weight: number;
  loop_penalty: number;
  risk_penalty: number;
};

export type AdaptationState = {
  modelWeights: Record<string, number>;
  strategyWeights: Record<string, number>;
  promptWeights: Record<string, number>;
  lastReward?: number;
};

const DEFAULT_REWARD: RewardConfig = {
  success_weight: 1,
  cost_weight: 0.3,
  loop_penalty: 0.2,
  risk_penalty: 0.4
};

const DEFAULT_STATE: AdaptationState = {
  modelWeights: {},
  strategyWeights: {},
  promptWeights: {}
};

export async function loadAdaptationState(workspacePath: string): Promise<AdaptationState> {
  const filePath = path.join(workspacePath, ".memory", "adaptation.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AdaptationState;
    return {
      ...DEFAULT_STATE,
      ...parsed,
      modelWeights: parsed?.modelWeights ?? {},
      strategyWeights: parsed?.strategyWeights ?? {},
      promptWeights: parsed?.promptWeights ?? {}
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_STATE };
    }
    throw err;
  }
}

export async function saveAdaptationState(workspacePath: string, state: AdaptationState): Promise<void> {
  const memoryDir = path.join(workspacePath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await writeJson(path.join(memoryDir, "adaptation.json"), state);
}

export function computeReward(
  analysis: RunAnalysis,
  runMeta: RunState,
  config: OrchestrumConfig | null
): number {
  const rewardConfig = { ...DEFAULT_REWARD, ...(config?.reward ?? {}) };
  const success = analysis.success ? 1 : 0;
  const cost = analysis.totalCost ?? runMeta.totalCost ?? 0;
  const loops = analysis.loopCount ?? 0;
  const risk = runMeta.riskSummary?.maxRisk ?? 0;

  const reward =
    rewardConfig.success_weight * success -
    rewardConfig.cost_weight * cost -
    rewardConfig.loop_penalty * loops -
    rewardConfig.risk_penalty * risk;

  return Number(reward.toFixed(4));
}

export async function updateAdaptationState(options: {
  workspacePath: string;
  workflow: Workflow;
  runMeta: RunState;
  reward: number;
}): Promise<AdaptationState> {
  const state = await loadAdaptationState(options.workspacePath);
  const reward = options.reward;
  const modelUsage = options.runMeta.modelUsage ?? {};
  for (const [model, count] of Object.entries(modelUsage)) {
    const weight = state.modelWeights[model] ?? 0;
    state.modelWeights[model] = clamp(weight + reward * 0.05 * count, -2, 2);
  }

  const mode = options.runMeta.strategy?.mode;
  if (mode) {
    const weight = state.strategyWeights[mode] ?? 0;
    state.strategyWeights[mode] = clamp(weight + reward * 0.08, -2, 2);
  }

  for (const step of options.workflow.steps) {
    if (!step.prompt) continue;
    const weight = state.promptWeights[step.prompt] ?? 0;
    state.promptWeights[step.prompt] = clamp(weight + reward * 0.02, -1, 1);
  }

  state.lastReward = reward;
  await saveAdaptationState(options.workspacePath, state);
  return state;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
