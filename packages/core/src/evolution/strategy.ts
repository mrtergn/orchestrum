import fs from "node:fs/promises";
import path from "node:path";
import type { RunAnalysis } from "../analytics/runAnalysis.js";
import { writeJson } from "../runner/fs.js";
import { getWorkspaceControlDir } from "../runner/control.js";

export type StrategyConfig = {
  mode: string;
  available_modes: string[];
};

export type StrategyProfile = {
  mode: string;
  loopMaxRoundsDelta: number;
  parallelismDelta: number;
  costToleranceMultiplier: number;
  policyStrictness: "low" | "balanced" | "high";
  autoTests: "on" | "off" | "inherit";
};

export type StrategyState = {
  auditStrictness?: "normal" | "high" | "low";
  notes?: string[];
};

const DEFAULT_STRATEGY: StrategyConfig = {
  mode: "balanced",
  available_modes: ["aggressive", "balanced", "conservative"]
};

export async function loadStrategy(repoPath: string): Promise<StrategyConfig> {
  const primaryPath = path.join(repoPath, "orchestrum.strategy.json");
  try {
    const raw = await fs.readFile(primaryPath, "utf8");
    const parsed = JSON.parse(raw) as StrategyConfig;
    if (!parsed.mode) return DEFAULT_STRATEGY;
    return {
      mode: parsed.mode ?? DEFAULT_STRATEGY.mode,
      available_modes: parsed.available_modes ?? DEFAULT_STRATEGY.available_modes
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_STRATEGY;
    }
    throw err;
  }
}

export function resolveStrategyProfile(mode: string): StrategyProfile {
  switch (mode) {
    case "aggressive":
      return {
        mode,
        loopMaxRoundsDelta: 1,
        parallelismDelta: 1,
        costToleranceMultiplier: 1.5,
        policyStrictness: "low",
        autoTests: "off"
      };
    case "conservative":
      return {
        mode,
        loopMaxRoundsDelta: 0,
        parallelismDelta: -1,
        costToleranceMultiplier: 0.75,
        policyStrictness: "high",
        autoTests: "on"
      };
    case "balanced":
    default:
      return {
        mode,
        loopMaxRoundsDelta: 0,
        parallelismDelta: 0,
        costToleranceMultiplier: 1,
        policyStrictness: "balanced",
        autoTests: "inherit"
      };
  }
}

export async function loadStrategyState(workspacePath: string): Promise<StrategyState> {
  const filePath = path.join(getWorkspaceControlDir(workspacePath), "strategy_state.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as StrategyState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export async function saveStrategyState(workspacePath: string, state: StrategyState): Promise<void> {
  const controlDir = getWorkspaceControlDir(workspacePath);
  await fs.mkdir(controlDir, { recursive: true });
  await writeJson(path.join(controlDir, "strategy_state.json"), state);
}

export function suggestStrategyMode(analysis: RunAnalysis, availableModes: string[], currentMode: string): string {
  if (analysis.securityAlerts > 0 || analysis.policyViolations > 1 || !analysis.success) {
    if (availableModes.includes("conservative")) return "conservative";
  }
  if (analysis.success && analysis.performanceScore > 0.8 && analysis.totalCost < 0.5) {
    if (availableModes.includes("aggressive")) return "aggressive";
  }
  return currentMode;
}

export async function updateStrategyState(
  workspacePath: string,
  analysis: RunAnalysis,
  currentState: StrategyState
): Promise<StrategyState> {
  const next = { ...currentState };
  const notes: string[] = [];
  if (analysis.auditBlocks > 1 && analysis.success) {
    next.auditStrictness = "low";
    notes.push("Relaxed audit strictness due to over-blocking.");
  } else if (analysis.devFailures > 0 || analysis.auditFailures > 1 || analysis.policyViolations > 0) {
    next.auditStrictness = "high";
    notes.push("Increased audit strictness due to failures.");
  } else {
    next.auditStrictness = "normal";
  }
  if (notes.length > 0) next.notes = notes;
  await saveStrategyState(workspacePath, next);
  return next;
}
