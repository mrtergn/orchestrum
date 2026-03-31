import fs from "node:fs/promises";
import path from "node:path";
import type { ReleaseReadiness } from "../contracts/service.js";
import { loadDocsSyncState } from "../docs/sync.js";
import { readJsonIfExists } from "../runner/fs.js";
import { loadGovernanceEvents } from "../runner/governance.js";

export async function computeReleaseReadiness(options: {
  workspacePath: string;
  runsDir: string;
  workspaceId?: string;
}): Promise<ReleaseReadiness> {
  const workspaceId = options.workspaceId;
  const latestRun = workspaceId ? await loadLatestRun(options.runsDir, workspaceId) : null;
  const blocking: string[] = [];
  let score = 100;
  let pendingApprovals = 0;
  let governanceAlerts = 0;
  let qualityGateOk = true;
  let docsFresh = false;
  let blockingFindings = 0;

  const validationStatus = latestRun?.meta?.validation?.status ?? "not_requested";
  const changeStatus = latestRun?.meta?.change?.status ?? "none";
  const verdict = latestRun?.meta?.verdict ?? null;
  const readinessRequirements = normalizeRequirements(latestRun?.meta?.profile?.repo_execution?.readiness_requirements);

  if (latestRun?.status && latestRun.status !== "completed") {
    score -= 25;
    blocking.push(`Latest run ${latestRun.runId} ended with status ${latestRun.status}.`);
  }
  if (verdict === "failed" || verdict === "blocked") {
    score -= 20;
    blocking.push(`Latest run verdict is ${verdict}.`);
  }
  if (changeStatus === "apply_failed") {
    score -= 20;
    blocking.push("Latest run contains a patch that failed to apply.");
  }
  if (validationStatus === "failed") {
    score -= 25;
    blocking.push("Latest validation run failed.");
  }
  if ((changeStatus === "generated" || changeStatus === "applied" || changeStatus === "validation_failed") && validationStatus !== "passed") {
    score -= 20;
    blocking.push(`Latest change state is ${changeStatus} but validation did not pass.`);
  }
  if (readinessRequirements.length > 0) {
    const results = Array.isArray(latestRun?.meta?.validation?.results) ? latestRun.meta.validation.results : [];
    const missingRequirements = readinessRequirements.filter((requirement) => !hasPassedRequirement(results, requirement));
    if (missingRequirements.length > 0) {
      score -= Math.min(20, missingRequirements.length * 5);
      blocking.push(`Required validations did not pass: ${missingRequirements.join(", ")}.`);
    }
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

    const deliverySession = await readJsonIfExists<{ findings?: Array<{ status?: string; severity?: string }> }>(
      path.join(latestRun.runDir, "delivery", "session.json")
    );
    const findings = Array.isArray(deliverySession?.findings) ? deliverySession.findings : [];
    blockingFindings = findings.filter((finding) => finding.status === "open" && finding.severity !== "low").length;
    if (blockingFindings > 0) {
      score -= Math.min(20, blockingFindings * 5);
      blocking.push(`${blockingFindings} open delivery finding(s) still block readiness.`);
    }
  }

  const docsState = await loadDocsSyncState(options.workspacePath);
  docsFresh = Boolean(docsState?.syncedAt) && !(docsState?.updatedFiles?.length === 0 && docsState?.changedFiles?.length);
  if (!docsFresh) {
    score -= 5;
  }

  return {
    workspaceId,
    latestRunId: latestRun?.runId,
    score: Math.max(0, score),
    blocking,
    updatedAt: new Date().toISOString(),
    signals: {
      pendingApprovals,
      governanceAlerts,
      docsFresh,
      qualityGateOk,
      validationStatus,
      changeStatus,
      verdict,
      readinessRequirements,
      blockingFindings
    }
  };
}

async function loadLatestRun(runsDir: string, workspaceId: string): Promise<{
  runId: string;
  runDir: string;
  status?: string;
  meta?: any;
} | null> {
  const workspaceDir = path.join(runsDir, workspaceId);
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  let latest: { runId: string; runDir: string; startTs: number; status?: string; meta?: any } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(workspaceDir, entry.name);
    const runMeta = await readJsonIfExists<{ runId?: string; start?: string; status?: string } & Record<string, unknown>>(path.join(runDir, "run.json"));
    if (!runMeta) continue;
    const startTs = runMeta.start ? Date.parse(runMeta.start) : 0;
    if (!latest || startTs >= latest.startTs) {
      latest = {
        runId: runMeta.runId ?? entry.name,
        runDir,
        startTs,
        status: runMeta.status,
        meta: runMeta
      };
    }
  }
  return latest ? { runId: latest.runId, runDir: latest.runDir, status: latest.status, meta: latest.meta } : null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRequirements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter(Boolean);
}

function hasPassedRequirement(
  results: Array<{ command?: string | null; ok?: boolean | null; summary?: string | null }>,
  requirement: string
): boolean {
  return results.some((result) => {
    if (!result?.ok) return false;
    const haystack = `${result.command ?? ""} ${result.summary ?? ""}`.toLowerCase();
    return haystack.includes(requirement);
  });
}
