import fs from "node:fs/promises";
import path from "node:path";
import type { RunState } from "./types.js";
import { writeJson } from "./fs.js";

export async function recoverInterruptedRuns(runsDir: string): Promise<{ recovered: number }> {
  let recovered = 0;
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name);
    const workspaceRuns = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
    for (const runEntry of workspaceRuns) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(candidate, runEntry.name);
      if (await recoverRun(runDir)) recovered += 1;
    }
  }
  return { recovered };
}

async function recoverRun(runDir: string): Promise<boolean> {
  const runPath = path.join(runDir, "run.json");
  try {
    const raw = await fs.readFile(runPath, "utf8");
    const meta = JSON.parse(raw) as RunState & { end?: string | null };
    if (meta.status !== "running" || meta.end) return false;
    meta.status = "interrupted";
    meta.interruptedAt = new Date().toISOString();
    meta.end = meta.end ?? meta.interruptedAt;
    meta.recovery = {
      status: "interrupted",
      kind: "interrupted",
      summary: "Service startup found this run still marked as running, so it was converted to interrupted.",
      guidance: [
        "Inspect the last completed step and any preserved artifacts before resuming.",
        "Resume the run if the repository and machine state are still valid.",
        "Relaunch the work item instead of resuming if the repository changed significantly after the interruption."
      ],
      artifacts: [],
      suggestedActions: [
        {
          kind: "resume_run",
          label: "Resume interrupted run",
          detail: "Resume only after confirming the repository and environment still match the interrupted run state.",
          runId: meta.runId
        }
      ],
      updatedAt: meta.interruptedAt,
      blockingStepId: null,
      blockingStepTitle: null
    };
    await writeJson(runPath, meta);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
