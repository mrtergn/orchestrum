import fs from "node:fs/promises";
import path from "node:path";
import type { RunState } from "./types.js";
import { writeJson, writeText } from "./fs.js";

export type RunSummary = {
  runId: string;
  ts: string;
  status: string;
  text: string;
};

const SUMMARY_LIMIT = 20;

export async function loadRecentSummaries(workspacePath: string, limit = 3): Promise<string[]> {
  const summaries = await loadSummaries(workspacePath);
  return summaries.slice(-limit).map((s) => s.text);
}

export async function appendSummary(workspacePath: string, summary: RunSummary): Promise<void> {
  const summaries = await loadSummaries(workspacePath);
  summaries.push(summary);
  const trimmed = summaries.slice(-SUMMARY_LIMIT);
  const memoryDir = path.join(workspacePath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await ensureEmbeddingsFile(memoryDir);
  await writeJson(path.join(memoryDir, "summaries.json"), trimmed);
}

export function buildRunSummary(runMeta: RunState, steps: Array<{ stepId: string; ok: boolean }>): RunSummary {
  const failed = steps.filter((s) => !s.ok).map((s) => s.stepId);
  const summaryLines = [
    `Run ${runMeta.runId} finished with status ${runMeta.status}.`,
    failed.length > 0 ? `Failed steps: ${failed.join(", ")}` : "All steps succeeded.",
    runMeta.totalCost ? `Total cost: $${runMeta.totalCost.toFixed(4)}` : "Total cost: n/a"
  ];
  return {
    runId: runMeta.runId,
    ts: new Date().toISOString(),
    status: runMeta.status,
    text: summaryLines.join(" ")
  };
}

async function loadSummaries(workspacePath: string): Promise<RunSummary[]> {
  const memoryPath = path.join(workspacePath, ".memory", "summaries.json");
  try {
    const raw = await fs.readFile(memoryPath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function ensureEmbeddingsFile(memoryDir: string): Promise<void> {
  const embeddingsPath = path.join(memoryDir, "embeddings.json");
  try {
    const stat = await fs.stat(embeddingsPath);
    if (!stat.isFile()) {
      await writeText(embeddingsPath, "[]");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await writeText(embeddingsPath, "[]");
      return;
    }
    throw err;
  }
}
