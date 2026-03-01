import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { runWorkflow } from "../runner/run.js";
import { loadWorkflow } from "../runner/workflow.js";
import { loadStrategy } from "../evolution/strategy.js";
import { writeJson } from "../runner/fs.js";

export async function runExperiment(options: {
  workflowPath: string;
  repoPath: string;
  runsDir: string;
  workspaceId: string;
  primaryMode?: string;
}): Promise<void> {
  const strategyConfig = await loadStrategy(options.repoPath).catch(() => null);
  const workflow = await loadWorkflow(options.workflowPath);
  const auditStepId = workflow.loop?.audit_step_id ?? "audit";
  const modes = strategyConfig?.available_modes ?? ["balanced"];
  const ordered = options.primaryMode
    ? [options.primaryMode, ...modes.filter((m) => m !== options.primaryMode)]
    : modes;

  const experimentId = `exp-${Date.now()}`;
  const results: Array<{
    mode: string;
    runId: string | null;
    ok: boolean;
    totalCost?: number;
    totalTokens?: number;
    maxRisk?: number;
    loopCount?: number;
  }> = [];

  for (const mode of ordered) {
    const ok = await runWorkflow({
      workflowPath: options.workflowPath,
      repoPath: options.repoPath,
      runsDir: options.runsDir,
      goal: `Experiment mode: ${mode}`,
      workspaceId: options.workspaceId,
      strategyMode: mode
    });
    const latest = await findLatestRunMeta(options.runsDir, options.workspaceId, auditStepId);
    results.push({
      mode,
      runId: latest?.runId ?? null,
      ok,
      totalCost: latest?.totalCost,
      totalTokens: latest?.totalTokens,
      maxRisk: latest?.riskSummary?.maxRisk,
      loopCount: latest?.loopCount
    });
  }

  const experimentDir = path.join(options.runsDir, options.workspaceId, "experiments");
  await fs.mkdir(experimentDir, { recursive: true });
  await writeJson(path.join(experimentDir, `${experimentId}.json`), {
    id: experimentId,
    createdAt: new Date().toISOString(),
    results
  });
}

async function findLatestRunMeta(
  runsDir: string,
  workspaceId: string,
  auditStepId: string
): Promise<
  | {
      runId: string;
      totalCost?: number;
      totalTokens?: number;
      riskSummary?: { maxRisk?: number };
      loopCount?: number;
    }
  | null
> {
  const base = path.join(runsDir, workspaceId);
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  let latest: { runId: string; ts: number; meta: any } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runMetaPath = path.join(base, entry.name, "run.json");
    if (!fsSync.existsSync(runMetaPath)) continue;
    const raw = await fs.readFile(runMetaPath, "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const meta = JSON.parse(raw) as { start?: string };
      const ts = meta.start ? Date.parse(meta.start) : 0;
      if (!latest || ts > latest.ts) {
        latest = { runId: entry.name, ts, meta };
      }
    } catch {
      // ignore
    }
  }
  if (!latest) return null;
  const eventsPath = path.join(base, latest.runId, "events.ndjson");
  let loopCount = 0;
  if (fsSync.existsSync(eventsPath)) {
    const rawEvents = await fs.readFile(eventsPath, "utf8").catch(() => "");
    if (rawEvents) {
      for (const line of rawEvents.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as { t?: string; stepId?: string };
          if (evt.t === "step.started" && evt.stepId === auditStepId) {
            loopCount += 1;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return {
    runId: latest.runId,
    totalCost: latest.meta?.totalCost,
    totalTokens: latest.meta?.totalTokens,
    riskSummary: latest.meta?.riskSummary,
    loopCount
  };
}
