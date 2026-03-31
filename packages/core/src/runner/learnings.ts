import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { LearningEntry } from "../contracts/service.js";
import type { RunState } from "./types.js";
import { readJsonIfExists, writeJson } from "./fs.js";

const LEARNINGS_LIMIT = 250;

export function getLearningsPath(workspacePath: string): string {
  return path.join(workspacePath, ".memory", "learnings.json");
}

export async function loadLearnings(workspacePath: string): Promise<LearningEntry[]> {
  const data = await readJsonIfExists<LearningEntry[]>(getLearningsPath(workspacePath));
  return Array.isArray(data) ? data : [];
}

export async function appendLearnings(workspacePath: string, entries: LearningEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const existing = await loadLearnings(workspacePath);
  const merged = [...existing, ...entries]
    .filter((entry) => Boolean(entry.insight?.trim()))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, LEARNINGS_LIMIT);
  await fs.mkdir(path.dirname(getLearningsPath(workspacePath)), { recursive: true });
  await writeJson(getLearningsPath(workspacePath), merged);
}

export async function loadRelevantLearnings(workspacePath: string, query: string, limit = 3): Promise<LearningEntry[]> {
  const learnings = await loadLearnings(workspacePath);
  const terms = tokenize(query);
  return [...learnings]
    .map((entry) => ({
      entry,
      score: scoreLearning(entry, terms)
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.entry.confidence !== b.entry.confidence) return b.entry.confidence - a.entry.confidence;
      return a.entry.timestamp < b.entry.timestamp ? 1 : -1;
    })
    .filter((item) => item.score > 0)
    .slice(0, limit)
    .map((item) => item.entry);
}

export function formatLearningsForContext(learnings: LearningEntry[]): string[] {
  return learnings.map((entry) => {
    const related = entry.relatedFiles.length > 0 ? ` Files: ${entry.relatedFiles.join(", ")}.` : "";
    return `[${entry.category}] ${entry.insight}${related}`;
  });
}

export async function buildRunLearnings(options: {
  workspacePath: string;
  runMeta: RunState;
  runDir: string;
}): Promise<LearningEntry[]> {
  const entries: LearningEntry[] = [];
  const stepsDir = path.join(options.runDir, "steps");
  const stepEntries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  const failedSteps: string[] = [];
  const relatedFiles = new Set<string>();

  for (const entry of stepEntries) {
    if (!entry.isDirectory()) continue;
    const stepDir = path.join(stepsDir, entry.name);
    const statusRaw = await fs.readFile(path.join(stepDir, "status.json"), "utf8").catch(() => "");
    if (statusRaw) {
      try {
        const status = JSON.parse(statusRaw) as { ok?: boolean };
        if (status.ok === false) failedSteps.push(entry.name);
      } catch {
        // ignore malformed
      }
    }
    const diffRaw = await fs.readFile(path.join(stepDir, "git.diff"), "utf8").catch(() => "");
    for (const file of extractFilesFromDiff(diffRaw)) {
      relatedFiles.add(file);
    }
  }

  entries.push(
    createLearning({
      category: options.runMeta.status === "finished" ? "success_pattern" : "run_outcome",
      insight:
        options.runMeta.status === "finished"
          ? `Run ${options.runMeta.runId} finished successfully with ${options.runMeta.completedSteps ?? 0} completed steps.`
          : `Run ${options.runMeta.runId} ended with status ${options.runMeta.status}.`,
      relatedFiles: Array.from(relatedFiles).slice(0, 10),
      sourceRunId: options.runMeta.runId,
      confidence: options.runMeta.status === "finished" ? 0.7 : 0.55
    })
  );

  if (failedSteps.length > 0) {
    entries.push(
      createLearning({
        category: "failure_pattern",
        insight: `Recent failure clusters around steps: ${failedSteps.join(", ")}.`,
        relatedFiles: Array.from(relatedFiles).slice(0, 10),
        sourceRunId: options.runMeta.runId,
        confidence: 0.78
      })
    );
  }

  const approvalFiles = await fs.readdir(path.join(options.runDir, "approvals"), { withFileTypes: true }).catch(() => []);
  const approvalCount = approvalFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  if (approvalCount > 0) {
    entries.push(
      createLearning({
        category: "approval",
        insight: `Run required ${approvalCount} governance approvals.`,
        relatedFiles: Array.from(relatedFiles).slice(0, 8),
        sourceRunId: options.runMeta.runId,
        confidence: 0.82
      })
    );
  }

  return entries;
}

export function createLearning(input: Omit<LearningEntry, "id" | "timestamp"> & { timestamp?: string }): LearningEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    category: input.category,
    insight: input.insight,
    relatedFiles: input.relatedFiles,
    sourceRunId: input.sourceRunId,
    confidence: input.confidence
  };
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/g)
    .filter((term) => term.length > 2);
}

function scoreLearning(entry: LearningEntry, terms: string[]): number {
  if (terms.length === 0) return entry.confidence;
  const haystack = `${entry.category} ${entry.insight} ${entry.relatedFiles.join(" ")}`.toLowerCase();
  let score = entry.confidence;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function extractFilesFromDiff(diffText: string): string[] {
  const files = new Set<string>();
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++ b/") || line.startsWith("--- a/")) {
      const cleaned = line.slice(6).trim();
      if (cleaned && cleaned !== "/dev/null") files.add(cleaned);
    }
  }
  return Array.from(files);
}
