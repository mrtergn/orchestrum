import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { RunState } from "./types.js";
import { writeJson } from "./fs.js";

export async function recoverInterruptedRuns(runsDir: string): Promise<{ recovered: number }> {
  let recovered = 0;
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name);
    const legacyRun = path.join(candidate, "run.json");
    if (fsSync.existsSync(legacyRun)) {
      if (await recoverRun(candidate)) recovered += 1;
      continue;
    }
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
    await writeJson(runPath, meta);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
