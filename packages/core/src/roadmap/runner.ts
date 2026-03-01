import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { runWorkflowDetailed } from "../runner/run.js";
import { loadConfig } from "../runner/config.js";
import { EventWriter } from "../runner/events.js";
import { nowTs } from "../runner/utils.js";
import { writeJson } from "../runner/fs.js";

export type RoadmapEntry = {
  milestone: string;
  status: "pending" | "running" | "completed" | "failed";
  runId?: string | null;
  startedAt?: string;
  completedAt?: string;
};

export type RoadmapState = {
  roadmap: RoadmapEntry[];
  updatedAt: string;
};

export async function runRoadmap(options: {
  roadmapPath: string;
  repoPath: string;
  runsDir: string;
  workspaceId?: string;
}): Promise<RoadmapState> {
  const raw = await fs.readFile(options.roadmapPath, "utf8");
  const data = yaml.parse(raw) as { roadmap?: Array<{ milestone: string }> };
  const items = Array.isArray(data?.roadmap) ? data.roadmap : [];
  const roadmap: RoadmapEntry[] = items.map((item) => ({
    milestone: String(item.milestone ?? ""),
    status: "pending"
  }));

  const config = await loadConfig(options.repoPath).catch(() => null);
  if (!config?.defaultWorkflow) {
    throw new Error("orchestrum.config.json missing defaultWorkflow for roadmap runs.");
  }
  const workflowPath = path.resolve(options.repoPath, config.defaultWorkflow);

  const events = await createRoadmapEvents(options.repoPath);
  const total = roadmap.length;

  for (const [index, entry] of roadmap.entries()) {
    entry.status = "running";
    entry.startedAt = new Date().toISOString();
    await saveRoadmap(options.repoPath, roadmap);
    events.emit({
      t: "roadmap.progress",
      milestone: entry.milestone,
      status: entry.status,
      index,
      total,
      ts: nowTs()
    });

    try {
      const result = await runWorkflowDetailed({
        workflowPath,
        repoPath: options.repoPath,
        runsDir: options.runsDir,
        goal: entry.milestone,
        workspaceId: options.workspaceId
      });
      entry.runId = result.runId;
      entry.status = result.ok ? "completed" : "failed";
      entry.completedAt = new Date().toISOString();
    } catch {
      entry.status = "failed";
      entry.completedAt = new Date().toISOString();
    }
    await saveRoadmap(options.repoPath, roadmap);
    events.emit({
      t: "roadmap.progress",
      milestone: entry.milestone,
      status: entry.status,
      runId: entry.runId ?? null,
      index,
      total,
      ts: nowTs()
    });
  }

  return {
    roadmap,
    updatedAt: new Date().toISOString()
  };
}

export async function loadRoadmap(repoPath: string): Promise<RoadmapState> {
  const filePath = path.join(repoPath, ".memory", "roadmap.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as RoadmapState;
    return parsed?.roadmap ? parsed : { roadmap: [], updatedAt: new Date().toISOString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { roadmap: [], updatedAt: new Date().toISOString() };
    }
    throw err;
  }
}

async function saveRoadmap(repoPath: string, roadmap: RoadmapEntry[]): Promise<void> {
  const memoryDir = path.join(repoPath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const state: RoadmapState = { roadmap, updatedAt: new Date().toISOString() };
  await writeJson(path.join(memoryDir, "roadmap.json"), state);
}

async function createRoadmapEvents(repoPath: string): Promise<EventWriter> {
  const memoryDir = path.join(repoPath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const eventsPath = path.join(memoryDir, "events.ndjson");
  return new EventWriter(eventsPath);
}
