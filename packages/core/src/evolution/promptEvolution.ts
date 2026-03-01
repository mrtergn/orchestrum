import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Workflow } from "../runner/workflow.js";
import type { RunState } from "../runner/types.js";
import type { RunAnalysis } from "../analytics/runAnalysis.js";
import { writeJson, writeText } from "../runner/fs.js";

export type PromptHistoryFile = {
  prompts: Record<string, PromptRecord>;
};

export type PromptRecord = {
  currentVersionId?: string;
  versions: PromptVersion[];
  suggestions: PromptSuggestion[];
};

export type PromptVersion = {
  id: string;
  createdAt: string;
  hash: string;
  content: string;
  performanceScore: number;
  runId: string;
};

export type PromptSuggestion = {
  id: string;
  createdAt: string;
  score: number;
  suggestions: string[];
  proposedPrompt?: string;
  status: "pending" | "approved" | "rejected";
  runId: string;
};

const DEFAULT_HISTORY: PromptHistoryFile = { prompts: {} };

export async function loadPromptHistory(workspacePath: string): Promise<PromptHistoryFile> {
  const filePath = path.join(workspacePath, ".memory", "prompt_history.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PromptHistoryFile;
    return parsed?.prompts ? parsed : DEFAULT_HISTORY;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_HISTORY };
    }
    throw err;
  }
}

export async function savePromptHistory(workspacePath: string, history: PromptHistoryFile): Promise<void> {
  const memoryDir = path.join(workspacePath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await writeJson(path.join(memoryDir, "prompt_history.json"), history);
}

export async function updatePromptHistory(options: {
  workflow: Workflow;
  workspacePath: string;
  runMeta: RunState;
  analysis: RunAnalysis;
}): Promise<{ suggestions: number; lastScore: number }> {
  const history = await loadPromptHistory(options.workspacePath);
  const promptPaths = collectPromptPaths(options.workflow);
  let suggestionCount = 0;
  let lastScore = options.analysis.performanceScore;

  for (const promptPath of promptPaths) {
    const content = await fs.readFile(promptPath, "utf8").catch(() => "");
    if (!content) continue;
    const hash = hashText(content);
    const record = history.prompts[promptPath] ?? { versions: [], suggestions: [] };
    const existing = record.versions.find((v) => v.hash === hash);
    if (!existing) {
      const version: PromptVersion = {
        id: `v${record.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        hash,
        content,
        performanceScore: options.analysis.performanceScore,
        runId: options.runMeta.runId
      };
      record.versions.push(version);
      record.currentVersionId = version.id;
    }

    const suggestion = buildSuggestion(options.analysis, content);
    if (suggestion) {
      record.suggestions.push({
        id: `s${record.suggestions.length + 1}`,
        createdAt: new Date().toISOString(),
        score: suggestion.score,
        suggestions: suggestion.suggestions,
        proposedPrompt: suggestion.proposedPrompt,
        status: "pending",
        runId: options.runMeta.runId
      });
      suggestionCount += 1;
      lastScore = suggestion.score;
    }

    history.prompts[promptPath] = record;
  }

  await savePromptHistory(options.workspacePath, history);
  return { suggestions: suggestionCount, lastScore };
}

export async function approvePromptSuggestion(options: {
  workspacePath: string;
  promptPath: string;
  suggestionId: string;
}): Promise<void> {
  const history = await loadPromptHistory(options.workspacePath);
  const record = history.prompts[options.promptPath];
  if (!record) return;
  const suggestion = record.suggestions.find((s) => s.id === options.suggestionId);
  if (!suggestion || suggestion.status !== "pending") return;
  suggestion.status = "approved";
  if (suggestion.proposedPrompt) {
    await writeText(options.promptPath, suggestion.proposedPrompt);
    const hash = hashText(suggestion.proposedPrompt);
    const version: PromptVersion = {
      id: `v${record.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      hash,
      content: suggestion.proposedPrompt,
      performanceScore: suggestion.score,
      runId: suggestion.runId
    };
    record.versions.push(version);
    record.currentVersionId = version.id;
  }
  await savePromptHistory(options.workspacePath, history);
}

export async function rejectPromptSuggestion(options: {
  workspacePath: string;
  promptPath: string;
  suggestionId: string;
}): Promise<void> {
  const history = await loadPromptHistory(options.workspacePath);
  const record = history.prompts[options.promptPath];
  if (!record) return;
  const suggestion = record.suggestions.find((s) => s.id === options.suggestionId);
  if (!suggestion) return;
  suggestion.status = "rejected";
  await savePromptHistory(options.workspacePath, history);
}

export async function rollbackPromptVersion(options: {
  workspacePath: string;
  promptPath: string;
  versionId: string;
}): Promise<void> {
  const history = await loadPromptHistory(options.workspacePath);
  const record = history.prompts[options.promptPath];
  if (!record) return;
  const version = record.versions.find((v) => v.id === options.versionId);
  if (!version) return;
  await writeText(options.promptPath, version.content);
  record.currentVersionId = version.id;
  await savePromptHistory(options.workspacePath, history);
}

function collectPromptPaths(workflow: Workflow): string[] {
  const paths = new Set<string>();
  for (const step of workflow.steps) {
    if (step.prompt) paths.add(step.prompt);
    if (step.substeps) {
      for (const sub of step.substeps) {
        if (sub.prompt) paths.add(sub.prompt);
      }
    }
  }
  return Array.from(paths);
}

function buildSuggestion(analysis: RunAnalysis, content: string): { score: number; suggestions: string[]; proposedPrompt?: string } | null {
  const suggestions: string[] = [];
  if (!analysis.success) {
    suggestions.push("Add clearer acceptance criteria and explicit constraints.");
  }
  if (analysis.auditFailures > 0) {
    suggestions.push("Reinforce audit expectations and JSON schema requirements.");
  }
  if (analysis.auditBlocks > 1 && analysis.success) {
    suggestions.push("Tune audit severity thresholds to avoid over-blocking.");
  }
  if (analysis.testFailures > 0) {
    suggestions.push("Add explicit testing instructions and error handling guidance.");
  }
  if (analysis.policyViolations > 0) {
    suggestions.push("Emphasize policy boundaries and safe change limits.");
  }
  if (analysis.totalCost > 1) {
    suggestions.push("Encourage concise outputs and token-efficient responses.");
  }
  if (suggestions.length === 0) return null;

  const score = clamp(analysis.performanceScore - 0.1, 0, 1);
  const proposedPrompt = `${content.trim()}\n\n# Improvement Notes\n${suggestions.map((s) => `- ${s}`).join("\n")}\n`;
  return { score, suggestions, proposedPrompt };
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
