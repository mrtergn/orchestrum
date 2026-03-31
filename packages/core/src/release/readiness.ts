import fs from "node:fs/promises";
import path from "node:path";
import type { ReleaseReadiness } from "../contracts/service.js";
import { loadDocsSyncState } from "../docs/sync.js";
import { loadGovernanceEvents } from "../runner/governance.js";
import { readJsonIfExists } from "../runner/fs.js";

export async function computeReleaseReadiness(options: {
  workspacePath: string;
  runsDir: string;
  workspaceId?: string;
}): Promise<ReleaseReadiness> {
  const workspaceId = options.workspaceId;
  const latestRun = workspaceId ? await loadLatestRun(options.runsDir, workspaceId) : null;
  const latestRunId = latestRun?.runId;
  const blocking: string[] = [];
  let score = 100;
  let pendingApprovals = 0;
  let governanceAlerts = 0;
  let qualityGateOk = true;

  if (latestRun?.status && latestRun.status !== "finished") {
    score -= 25;
    blocking.push(`Latest run ${latestRun.runId} ended with status ${latestRun.status}.`);
  }

  if (latestRun?.runDir) {
    const approvalsDir = path.join(latestRun.runDir, "approvals");
    const approvalFiles = await fs.readdir(approvalsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of approvalFiles) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(approvalsDir, entry.name), "utf8").catch(() => "");
      if (!raw) continue;
      try {
        const request = JSON.parse(raw) as { stepId?: string };
        const approvedPath = path.join(approvalsDir, `${request.stepId ?? ""}.approved`);
        if (!(await fileExists(approvedPath))) {
          pendingApprovals += 1;
        }
      } catch {
        pendingApprovals += 1;
      }
    }
    if (pendingApprovals > 0) {
      score -= Math.min(25, pendingApprovals * 10);
      blocking.push(`${pendingApprovals} pending approval request(s) remain unresolved.`);
    }

    const governanceEvents = await loadGovernanceEvents(latestRun.runDir);
    governanceAlerts = governanceEvents.filter((event) => event.severity === "error").length;
    if (governanceAlerts > 0) {
      score -= Math.min(30, governanceAlerts * 10);
      blocking.push(`${governanceAlerts} unresolved governance alert(s) remain in the latest run.`);
    }
    qualityGateOk = !governanceEvents.some((event) => event.category === "quality_gate" && event.severity === "error");
    if (!qualityGateOk) {
      score -= 15;
      blocking.push("Latest quality gate did not pass.");
    }
  }

  const docsState = await loadDocsSyncState(options.workspacePath);
  const docsFresh = Boolean(docsState?.syncedAt) && !(docsState?.updatedFiles?.length === 0 && docsState?.changedFiles?.length);
  if (!docsFresh) {
    score -= 15;
    blocking.push("Documentation sync is stale or has not been run.");
  }

  return {
    workspaceId,
    latestRunId,
    score: Math.max(0, score),
    blocking,
    updatedAt: new Date().toISOString(),
    signals: {
      pendingApprovals,
      governanceAlerts,
      docsFresh,
      qualityGateOk
    }
  };
}

async function loadLatestRun(runsDir: string, workspaceId: string): Promise<{
  runId: string;
  runDir: string;
  status?: string;
} | null> {
  const workspaceDir = path.join(runsDir, workspaceId);
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  let latest: { runId: string; runDir: string; startTs: number; status?: string } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(workspaceDir, entry.name);
    const runMeta = await readJsonIfExists<{ runId?: string; start?: string; status?: string }>(path.join(runDir, "run.json"));
    if (!runMeta) continue;
    const startTs = runMeta.start ? Date.parse(runMeta.start) : 0;
    if (!latest || startTs >= latest.startTs) {
      latest = {
        runId: runMeta.runId ?? entry.name,
        runDir,
        startTs,
        status: runMeta.status
      };
    }
  }
  return latest ? { runId: latest.runId, runDir: latest.runDir, status: latest.status } : null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
