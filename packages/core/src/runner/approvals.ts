import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, writeJson, readJsonIfExists, writeText } from "./fs.js";
import { APPROVAL_TTL_HOURS } from "../constants.js";

export type WorkspaceApproval = {
  stepId: string;
  kind: "diff" | "command" | "governance";
  createdAt: string;
};

export type ApprovalRequest = {
  token: string;
  runId: string;
  stepId: string;
  kind: "diff" | "command" | "governance";
  reason: string;
  findings: unknown;
  ts: string;
  iat?: string;
  expiresAt?: string;
};

export function createApprovalToken(): string {
  return crypto.randomBytes(10).toString("hex");
}

export async function loadWorkspaceApprovals(repoPath: string): Promise<WorkspaceApproval[]> {
  const primaryPath = path.join(repoPath, ".orchestrum", "approvals.json");
  const data = await readJsonIfExists<WorkspaceApproval[]>(primaryPath);
  return Array.isArray(data) ? data : [];
}

export async function addWorkspaceApproval(repoPath: string, approval: WorkspaceApproval): Promise<void> {
  const approvals = await loadWorkspaceApprovals(repoPath);
  approvals.push(approval);
  const filePath = path.join(repoPath, ".orchestrum", "approvals.json");
  await ensureDir(path.dirname(filePath));
  await writeJson(filePath, approvals.slice(-200));
}

export async function isWorkspaceApproved(repoPath: string, stepId: string, kind: WorkspaceApproval["kind"]): Promise<boolean> {
  const approvals = await loadWorkspaceApprovals(repoPath);
  return approvals.some((entry) => entry.stepId === stepId && entry.kind === kind);
}

export async function writeApprovalRequest(runDir: string, request: ApprovalRequest): Promise<void> {
  const approvalsDir = path.join(runDir, "approvals");
  await ensureDir(approvalsDir);
  const iat = request.iat ?? request.ts ?? new Date().toISOString();
  const expiresAt = request.expiresAt ?? new Date(new Date(iat).getTime() + APPROVAL_TTL_HOURS * 60 * 60 * 1000).toISOString();
  await writeJson(path.join(approvalsDir, `${request.token}.json`), {
    ...request,
    iat,
    expiresAt
  } satisfies ApprovalRequest);
}

export async function approveStep(runDir: string, stepId: string): Promise<void> {
  const approvalsDir = path.join(runDir, "approvals");
  await ensureDir(approvalsDir);
  await writeText(path.join(approvalsDir, `${stepId}.approved`), new Date().toISOString());
}

export async function approveToken(runsDir: string, token: string): Promise<{ runId: string; stepId: string } | null> {
  const match = await findApprovalRequest(runsDir, token);
  if (!match) return null;
  if (isApprovalExpired(match.request)) return null;
  await approveStep(match.runDir, match.request.stepId);
  return { runId: match.request.runId, stepId: match.request.stepId };
}

export async function findApprovalRequest(
  runsDir: string,
  token: string
): Promise<{ runDir: string; request: ApprovalRequest } | null> {
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name);
    const workspaceEntries = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
    for (const runEntry of workspaceEntries) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(candidate, runEntry.name);
      const filePath = path.join(runDir, "approvals", `${token}.json`);
      if (!fsSync.existsSync(filePath)) continue;
      const request = await readJsonIfExists<ApprovalRequest>(filePath);
      if (request) return { runDir, request };
    }
  }
  return null;
}

export function isApprovalExpired(request: Pick<ApprovalRequest, "expiresAt">, now = Date.now()): boolean {
  if (!request.expiresAt) return false;
  const expiry = Date.parse(request.expiresAt);
  if (Number.isNaN(expiry)) return true;
  return now > expiry;
}
