import path from "node:path";
import { ensureDir, writeText } from "./fs.js";
import { nowIso } from "./utils.js";

export async function cancelRun(runsDir: string, runId: string, workspaceId = "default"): Promise<void> {
  const runDir = path.join(runsDir, workspaceId, runId);
  await ensureDir(runDir);
  await writeText(path.join(runDir, "cancelled"), nowIso());
}
