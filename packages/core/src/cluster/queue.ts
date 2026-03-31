import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { nowIso } from "../runner/utils.js";
import type { LlmUsage } from "../runner/cost.js";
import { writeJson } from "../runner/fs.js";
import { ClusterTimeoutError } from "../errors.js";

export type ClusterTask = {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  agentId: string;
  stepId: string;
  runId: string;
  createdAt: string;
};

export type ClusterResult = {
  id: string;
  ok: boolean;
  text?: string;
  usage?: LlmUsage;
  error?: string;
  durationMs?: number;
};

export type ClusterPaths = {
  queueDir: string;
  resultsDir: string;
  logsDir: string;
};

export async function ensureClusterPaths(queueRoot: string): Promise<ClusterPaths> {
  const queueDir = path.join(queueRoot, "queue");
  const resultsDir = path.join(queueRoot, "results");
  const logsDir = path.join(queueRoot, "logs");
  await fs.mkdir(queueDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  return { queueDir, resultsDir, logsDir };
}

export async function enqueueTask(queueRoot: string, task: ClusterTask): Promise<string> {
  const { queueDir } = await ensureClusterPaths(queueRoot);
  const taskPath = path.join(queueDir, `${task.id}.json`);
  await writeJson(taskPath, task);
  return taskPath;
}

export async function waitForResult(queueRoot: string, taskId: string, timeoutMs = 600000, pollMs = 300): Promise<ClusterResult> {
  const { resultsDir } = await ensureClusterPaths(queueRoot);
  const resultPath = path.join(resultsDir, `${taskId}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fsSync.existsSync(resultPath)) {
      const raw = await fs.readFile(resultPath, "utf8");
      return JSON.parse(raw) as ClusterResult;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new ClusterTimeoutError(`Worker timeout for task ${taskId}.`, "cluster.timeout", {
    taskId,
    timeoutMs
  });
}

export function buildTask(options: {
  provider: string;
  model: string;
  prompt: string;
  agentId: string;
  stepId: string;
  runId: string;
}): ClusterTask {
  return {
    id: `${options.runId}-${options.stepId}-${Date.now()}`,
    provider: options.provider,
    model: options.model,
    prompt: options.prompt,
    agentId: options.agentId,
    stepId: options.stepId,
    runId: options.runId,
    createdAt: nowIso()
  };
}

export async function recordWorkerStat(queueRoot: string, stats: { active: number; queue: number }): Promise<void> {
  const memoryDir = path.join(queueRoot, "stats");
  await fs.mkdir(memoryDir, { recursive: true });
  const filePath = path.join(memoryDir, "worker_stats.json");
  let entries: Array<{ ts: string; active: number; queue: number }> = [];
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  entries.push({ ts: nowIso(), active: stats.active, queue: stats.queue });
  entries = entries.slice(-200);
  await writeJson(filePath, entries);
}
