import fs from "node:fs/promises";
import path from "node:path";
import { runWorkflowDetailed } from "../runner/run.js";
import { writeJson } from "../runner/fs.js";

export type EvaluationResult = {
  id: string;
  workflow: string;
  runs: number;
  runIds: string[];
  similarity: number;
  createdAt: string;
};

export async function evaluateWorkflow(options: {
  workflowPath: string;
  repoPath: string;
  runsDir: string;
  workspaceId?: string;
  runs: number;
  goal?: string;
  strategyMode?: string;
}): Promise<EvaluationResult> {
  const runIds: string[] = [];
  const diffs: string[] = [];

  for (let i = 0; i < options.runs; i += 1) {
    const result = await runWorkflowDetailed({
      workflowPath: options.workflowPath,
      repoPath: options.repoPath,
      runsDir: options.runsDir,
      goal: options.goal ?? "",
      workspaceId: options.workspaceId,
      strategyMode: options.strategyMode
    });
    runIds.push(result.runId);
    const diff = await findLatestDiff(result.runDir);
    diffs.push(diff ?? "");
  }

  const similarity = computeAverageSimilarity(diffs);
  const evaluation: EvaluationResult = {
    id: `eval-${Date.now()}`,
    workflow: options.workflowPath,
    runs: options.runs,
    runIds,
    similarity,
    createdAt: new Date().toISOString()
  };

  await appendEvaluation(options.repoPath, evaluation);
  return evaluation;
}

async function findLatestDiff(runDir: string): Promise<string | null> {
  const stepsDir = path.join(runDir, "steps");
  const entries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  let latest: { path: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const diffPath = path.join(stepsDir, entry.name, "git.diff");
    try {
      const stat = await fs.stat(diffPath);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { path: diffPath, mtime: stat.mtimeMs };
      }
    } catch {
      // ignore
    }
  }
  if (!latest) return null;
  return await fs.readFile(latest.path, "utf8");
}

function computeAverageSimilarity(diffs: string[]): number {
  if (diffs.length <= 1) return 1;
  let total = 0;
  let count = 0;
  for (let i = 0; i < diffs.length; i += 1) {
    for (let j = i + 1; j < diffs.length; j += 1) {
      total += similarityScore(diffs[i] ?? "", diffs[j] ?? "");
      count += 1;
    }
  }
  return count ? Number((total / count).toFixed(4)) : 1;
}

function similarityScore(a: string, b: string): number {
  const setA = new Set(a.split(/\r?\n/).filter(Boolean));
  const setB = new Set(b.split(/\r?\n/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize ? intersection.size / unionSize : 1;
}

async function appendEvaluation(repoPath: string, evaluation: EvaluationResult): Promise<void> {
  const memoryDir = path.join(repoPath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const filePath = path.join(memoryDir, "evaluations.json");
  let entries: EvaluationResult[] = [];
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  entries.push(evaluation);
  entries = entries.slice(-50);
  await writeJson(filePath, entries);
}
