import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeJson, writeText } from "../runner/fs.js";
import { MAX_PROMPT_VERSIONS } from "../constants.js";
import { getWorkspaceControlDir } from "../runner/control.js";

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
  const filePath = path.join(getWorkspaceControlDir(workspacePath), "prompt_history.json");
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
  const controlDir = getWorkspaceControlDir(workspacePath);
  await fs.mkdir(controlDir, { recursive: true });
  await writeJson(path.join(controlDir, "prompt_history.json"), history);
}

export async function registerPromptSuggestions(options: {
  workspacePath: string;
  suggestions: Array<{
    promptPath: string;
    createdAt?: string;
    score: number;
    suggestions: string[];
    proposedPrompt?: string;
    runId: string;
  }>;
}): Promise<Array<{ promptPath: string; suggestionId: string }>> {
  const history = await loadPromptHistory(options.workspacePath);
  const registered: Array<{ promptPath: string; suggestionId: string }> = [];

  for (const entry of options.suggestions) {
    const promptPath = entry.promptPath.trim();
    if (!promptPath) continue;
    const record = history.prompts[promptPath] ?? { versions: [], suggestions: [] };
    history.prompts[promptPath] = record;

    if (record.versions.length === 0) {
      const currentContent = await fs.readFile(promptPath, "utf8").catch(() => "");
      if (currentContent.trim()) {
        const version: PromptVersion = {
          id: "v1",
          createdAt: entry.createdAt ?? new Date().toISOString(),
          hash: hashText(currentContent),
          content: currentContent,
          performanceScore: 0,
          runId: entry.runId
        };
        record.versions.push(version);
        record.currentVersionId = version.id;
      }
    }

    const existing = record.suggestions.find((suggestion) =>
      suggestion.runId === entry.runId &&
      suggestion.proposedPrompt === entry.proposedPrompt &&
      suggestion.suggestions.join("\n") === entry.suggestions.join("\n")
    );
    if (existing) {
      registered.push({ promptPath, suggestionId: existing.id });
      continue;
    }

    const suggestion: PromptSuggestion = {
      id: crypto.randomUUID(),
      createdAt: entry.createdAt ?? new Date().toISOString(),
      score: entry.score,
      suggestions: [...entry.suggestions],
      proposedPrompt: entry.proposedPrompt,
      status: "pending",
      runId: entry.runId
    };
    record.suggestions.unshift(suggestion);
    record.suggestions = record.suggestions.slice(0, MAX_PROMPT_VERSIONS);
    registered.push({ promptPath, suggestionId: suggestion.id });
  }

  await savePromptHistory(options.workspacePath, history);
  return registered;
}

export async function approvePromptSuggestion(options: {
  workspacePath: string;
  promptPath: string;
  suggestionId: string;
}): Promise<void> {
  const history = await loadPromptHistory(options.workspacePath);
  const record = history.prompts[options.promptPath];
  if (!record) return;
  const suggestion = record.suggestions.find((item) => item.id === options.suggestionId);
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
    record.versions = record.versions.slice(-MAX_PROMPT_VERSIONS);
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
  const suggestion = record.suggestions.find((item) => item.id === options.suggestionId);
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
  const version = record.versions.find((item) => item.id === options.versionId);
  if (!version) return;
  await writeText(options.promptPath, version.content);
  record.currentVersionId = version.id;
  await savePromptHistory(options.workspacePath, history);
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
