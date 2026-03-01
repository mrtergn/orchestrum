import type { OrchestrumConfig } from "./config.js";

export type LlmUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type Pricing = {
  prompt_per_1k: number;
  completion_per_1k: number;
};

export function normalizeUsage(usage?: Partial<LlmUsage> | null): LlmUsage | null {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

export function resolvePricing(config: OrchestrumConfig | null | undefined, model: string): Pricing | null {
  if (!config?.pricing) return null;
  const direct = config.pricing[model];
  if (direct) return direct;
  const fallback = config.pricing["default"];
  return fallback ?? null;
}

export function estimateCostUsd(usage: LlmUsage | null, pricing: Pricing | null): number | null {
  if (!usage || !pricing) return null;
  const promptCost = (usage.prompt_tokens / 1000) * pricing.prompt_per_1k;
  const completionCost = (usage.completion_tokens / 1000) * pricing.completion_per_1k;
  return Number((promptCost + completionCost).toFixed(6));
}
