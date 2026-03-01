import type { StepDefinition, Workflow } from "../runner/workflow.js";
import type { PolicyConfig } from "../runner/policy.js";
import type { OrchestrumConfig } from "../runner/config.js";
import type { LlmUsage } from "../runner/cost.js";
import { estimateCostUsd, resolvePricing, normalizeUsage } from "../runner/cost.js";
import { extractDiffBlock, extractJsonBlock } from "../runner/utils.js";

export type ArbitrationMode = "score" | "vote" | "fastest";

export type ProviderSpec = {
  id: string;
  provider: string;
  model: string;
};

export type ArbitrationCandidate = {
  spec: ProviderSpec;
  outputText: string;
  usage: LlmUsage | null;
  costUsd: number | null;
  durationMs: number;
  valid: boolean;
  policyOk: boolean;
  patchOk: boolean;
  testScore: number;
  tokenScore: number;
  score: number;
  error?: string | null;
  outputJson?: unknown;
  diffText?: string | null;
};

export type ArbitrationDecision = {
  mode: ArbitrationMode;
  winner: ArbitrationCandidate;
  candidates: ArbitrationCandidate[];
};

export async function runArbitration(options: {
  candidates: ProviderSpec[];
  prompt: string;
  step: StepDefinition;
  workflow: Workflow;
  policy: PolicyConfig | null;
  config: OrchestrumConfig | null;
  mode: ArbitrationMode;
  execute: (spec: ProviderSpec) => Promise<{ text: string; usage?: LlmUsage | null; durationMs: number }>;
  checkPatch: (diff: string) => Promise<boolean>;
  modelBias?: Record<string, number>;
}): Promise<ArbitrationDecision> {
  const rawCandidates = await Promise.all(
    options.candidates.map(async (spec) => {
      try {
        const result = await options.execute(spec);
        return { spec, result } as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { spec, error: message } as const;
      }
    })
  );

  const candidates: ArbitrationCandidate[] = rawCandidates.map((entry) => {
    if ("error" in entry) {
      return {
        spec: entry.spec,
        outputText: "",
        usage: null,
        costUsd: null,
        durationMs: 0,
        valid: false,
        policyOk: false,
        patchOk: false,
        testScore: 0,
        tokenScore: 0,
        score: 0,
        error: entry.error
      };
    }
    const usage = normalizeUsage(entry.result.usage ?? null);
    const pricing = resolvePricing(options.config, entry.spec.model);
    const costUsd = estimateCostUsd(usage, pricing);
    return {
      spec: entry.spec,
      outputText: entry.result.text,
      usage,
      costUsd,
      durationMs: entry.result.durationMs,
      valid: true,
      policyOk: true,
      patchOk: true,
      testScore: 0,
      tokenScore: 0,
      score: 0
    };
  });

  const maxTokens = Math.max(0, ...candidates.map((c) => c.usage?.total_tokens ?? 0));

  if (candidates.length === 0) {
    throw new Error("No arbitration candidates available.");
  }

  for (const candidate of candidates) {
    if (candidate.error) {
      candidate.valid = false;
      continue;
    }
    const outputText = candidate.outputText;
    const needsJson =
      options.step.type === "red_team" || options.workflow.loop?.audit_step_id === options.step.id;
    const needsDiff = Boolean(options.step.apply_patch || options.step.type === "test_generation");

    let diffText: string | null = null;
    if (needsDiff) {
      diffText = extractDiffBlock(outputText);
      candidate.diffText = diffText;
      candidate.valid = Boolean(diffText);
      if (diffText) {
        candidate.patchOk = await options.checkPatch(diffText);
        candidate.policyOk = checkPolicyAgainstDiff(diffText, options.policy);
      } else {
        candidate.patchOk = false;
        candidate.policyOk = false;
      }
    }

    if (needsJson) {
      const parsed = extractJsonBlock(outputText);
      candidate.outputJson = parsed ?? undefined;
      if (!parsed || typeof parsed !== "object") {
        candidate.valid = false;
      }
    }

    candidate.testScore = scoreTestSignal(outputText);
    if (maxTokens > 0) {
      const tokens = candidate.usage?.total_tokens ?? maxTokens;
      candidate.tokenScore = 1 - Math.min(1, tokens / maxTokens);
    } else {
      candidate.tokenScore = 0.5;
    }

    const bias = options.modelBias?.[candidate.spec.model] ?? 0;
    candidate.score = computeScore(candidate, bias);
  }

  const mode = options.mode;
  const winner = selectWinner(candidates, mode);

  return { mode, winner, candidates };
}

function selectWinner(candidates: ArbitrationCandidate[], mode: ArbitrationMode): ArbitrationCandidate {
  const viable = candidates.filter((c) => !c.error);
  if (viable.length === 0) {
    return candidates[0]!;
  }

  if (mode === "fastest") {
    return [...viable].sort((a, b) => a.durationMs - b.durationMs)[0]!;
  }

  if (mode === "vote") {
    const valids = viable.filter((c) => c.valid);
    if (valids.length > 0) {
      return valids.sort((a, b) => b.score - a.score)[0]!;
    }
  }

  return [...viable].sort((a, b) => b.score - a.score)[0]!;
}

function computeScore(candidate: ArbitrationCandidate, bias: number): number {
  const validity = candidate.valid ? 1 : 0;
  const policy = candidate.policyOk ? 1 : 0;
  const patch = candidate.patchOk ? 1 : 0;
  const score =
    validity * 2 + policy * 1 + patch * 1 + candidate.testScore * 0.7 + candidate.tokenScore * 0.5 + bias;
  return Number(score.toFixed(4));
}

function scoreTestSignal(output: string): number {
  if (!output) return 0.2;
  if (/\btest(s|ing)?\b/i.test(output)) return 0.9;
  if (/\blint|typecheck|ci\b/i.test(output)) return 0.7;
  return 0.4;
}

function checkPolicyAgainstDiff(diffText: string, policy: PolicyConfig | null): boolean {
  if (!policy) return true;
  const files = extractDiffFiles(diffText);
  if (policy.max_files_changed && files.length > policy.max_files_changed) return false;
  if (policy.forbidden_paths && policy.forbidden_paths.length > 0) {
    const forbidden = policy.forbidden_paths.map((p) => normalizePath(p));
    const hit = files.find((file) => forbidden.some((f) => normalizePath(file).startsWith(f)));
    if (hit) return false;
  }
  return true;
}

function extractDiffFiles(diffText: string): string[] {
  const files = new Set<string>();
  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const parts = line.split(/\s+/);
      const raw = parts[1];
      if (!raw || raw === "/dev/null") continue;
      const cleaned = raw.replace(/^a\//, "").replace(/^b\//, "");
      files.add(cleaned);
    }
  }
  return Array.from(files);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\\\/g, "/").replace(/^\./, "");
}
