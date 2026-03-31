import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadWorkflow } from "@orchestrum/core";

const ROOT_DIR = path.join(process.cwd(), "..", "..");
const DEFAULT_RUNS_DIR = path.join(ROOT_DIR, "runs");
const WORKSPACES_PATH = path.join(ROOT_DIR, "data", "workspaces.json");

export type Workspace = {
  id: string;
  path: string;
  name?: string;
};

export type RunMeta = {
  runId: string;
  status: string;
  start: string;
  end: string | null;
  repoPath: string;
  pinned?: boolean;
  tags?: string[];
  workflow?: string;
  goal?: string;
  workspaceId?: string;
  workspacePath?: string;
  resumedFrom?: string | null;
  resumeCount?: number;
  totalSteps?: number;
  completedSteps?: number;
  branch?: string | null;
  totalTokens?: number;
  totalCost?: number;
  costByAgent?: Record<string, { tokens: number; cost: number }>;
  dynamicAgents?: Array<{ id: string; role?: string }>;
  modelUsage?: Record<string, number>;
  reward?: number;
  rewardHistory?: Array<{ ts: string; reward: number }>;
  strategy?: {
    mode?: string;
    suggestedMode?: string;
    adjustments?: string[];
    performanceScore?: number;
  };
  agentScores?: Record<string, { score: number; avgScore?: number }>;
  policyViolations?: number;
  auditFailures?: number;
  testFailures?: number;
  securityAlerts?: number;
  riskSummary?: { avgRisk?: number; maxRisk?: number };
  promptEvolution?: { suggestions?: number; lastScore?: number };
};

export type StepStatus = {
  stepId: string;
  ok: boolean;
  start: string | null;
  end: string | null;
  error: string | null;
  cached?: boolean;
  commitSha?: string | null;
  agentId?: string | null;
  provider?: string | null;
  model?: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  costUsd?: number | null;
  riskScore?: number | null;
  behavior?: {
    reasoningSummary?: string | null;
    confidence?: number | null;
    decisionPath?: string[] | null;
  } | null;
};

export type WorkflowSummary = {
  name: string;
  agents: Record<string, { provider: string; model: string; role?: string }>;
  steps: Array<{
    id: string;
    agent?: string;
    phase?: string;
    parallel?: boolean;
    type?: string;
    substeps?: Array<{ id: string; agent?: string; phase?: string; type?: string }>;
  }>;
  loop?: {
    max_rounds?: number;
    max_loop_per_step?: number;
    audit_step_id?: string;
    fix_step_id?: string;
  };
  enable_auto_tests?: boolean;
  security?: { threshold?: number };
};

export function getRunsDir() {
  return process.env.ORCHESTRUM_RUNS_DIR ?? DEFAULT_RUNS_DIR;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  try {
    const raw = await fs.readFile(WORKSPACES_PATH, "utf8");
    const data = JSON.parse(raw) as { workspaces?: Workspace[] };
    return Array.isArray(data.workspaces) ? data.workspaces : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function resolveWorkspacePath(workspaceId?: string): Promise<string | null> {
  const workspaces = await listWorkspaces();
  if (workspaceId) {
    const match = workspaces.find((ws) => ws.id === workspaceId);
    if (match?.path) return match.path;
    const inferred = await inferWorkspacePath(workspaceId);
    return inferred;
  }
  if (workspaces.length === 1) {
    return workspaces[0]?.path ?? null;
  }
  return null;
}

async function inferWorkspacePath(workspaceId: string): Promise<string | null> {
  const runsDir = getRunsDir();
  const workspaceDir = path.join(runsDir, workspaceId);
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  let latest: { path: string; ts: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runPath = path.join(workspaceDir, entry.name, "run.json");
    try {
      const raw = await fs.readFile(runPath, "utf8");
      const meta = JSON.parse(raw) as { start?: string; repoPath?: string };
      const ts = meta.start ? Date.parse(meta.start) : 0;
      if (meta.repoPath && (!latest || ts > latest.ts)) {
        latest = { path: meta.repoPath, ts };
      }
    } catch {
      // ignore
    }
  }
  return latest?.path ?? null;
}

export function assertSafeId(id: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error("Invalid run id");
  }
}

export async function listRuns(workspaceId?: string): Promise<RunMeta[]> {
  const runsDir = getRunsDir();
  if (workspaceId) {
    const runs = await listRunsInDir(path.join(runsDir, workspaceId), workspaceId);
    return runs.sort((a, b) => (a.start < b.start ? 1 : -1));
  }

  const results: RunMeta[] = [];
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name);
    const nested = await listRunsInDir(candidate, entry.name);
    results.push(...nested);
  }

  return results.sort((a, b) => (a.start < b.start ? 1 : -1));
}

async function listRunsInDir(dir: string, workspaceId: string): Promise<RunMeta[]> {
  const runs: RunMeta[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = await readRunMeta(entry.name, workspaceId);
    if (run) runs.push(run);
  }
  return runs;
}

export async function readRunMeta(runId: string, workspaceId?: string): Promise<RunMeta | null> {
  assertSafeId(runId);
  const resolved = await resolveRunDir(runId, workspaceId);
  if (!resolved) return null;
  const runPath = path.join(resolved.runDir, "run.json");
  try {
    const raw = await fs.readFile(runPath, "utf8");
    const meta = JSON.parse(raw) as RunMeta;
    meta.workspaceId = meta.workspaceId ?? resolved.workspaceId;
    return meta;
  } catch {
    return null;
  }
}

export async function readWorkflowSummary(runId: string, workspaceId?: string): Promise<WorkflowSummary | null> {
  const run = await readRunMeta(runId, workspaceId);
  if (!run?.workflow) return null;
  try {
    const workflow = await loadWorkflow(run.workflow);
    const agents = { ...workflow.agents } as Record<string, { provider: string; model: string; role?: string }>;
    if (run.dynamicAgents) {
      for (const agent of run.dynamicAgents) {
        if (!agents[agent.id]) {
          agents[agent.id] = { provider: "openai", model: "", role: agent.role };
        }
      }
    }
    return {
      name: workflow.name,
      agents,
      loop: workflow.loop,
      enable_auto_tests: workflow.enable_auto_tests,
      security: workflow.security,
      steps: workflow.steps.map((step) => ({
        id: step.id,
        agent: step.agent,
        phase: step.phase,
        parallel: step.parallel,
        type: step.type,
        substeps: step.substeps?.map((sub) => ({
          id: sub.id,
          agent: sub.agent,
          phase: sub.phase,
          type: sub.type
        }))
      }))
    };
  } catch {
    return null;
  }
}

export async function readStepStatuses(runId: string, workspaceId?: string): Promise<StepStatus[]> {
  const resolved = await resolveRunDir(runId, workspaceId);
  if (!resolved) return [];
  const stepsDir = path.join(resolved.runDir, "steps");
  const entries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  const steps: StepStatus[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(stepsDir, entry.name, "status.json");
    try {
      const raw = await fs.readFile(statusPath, "utf8");
      const data = JSON.parse(raw) as StepStatus;
      steps.push(data);
    } catch {
      steps.push({ stepId: entry.name, ok: false, start: null, end: null, error: "Missing status" });
    }
  }
  return steps;
}

export async function readArtifact(runId: string, stepId: string, name: string, workspaceId?: string): Promise<string | null> {
  assertSafeId(runId);
  assertSafeId(stepId);
  if (!/^[a-zA-Z0-9._\\/-]+$/.test(name) || name.includes("..")) {
    throw new Error("Invalid artifact name");
  }
  const resolved = await resolveRunDir(runId, workspaceId);
  if (!resolved) return null;
  const baseDir = path.join(resolved.runDir, "steps", stepId);
  const artifactPath = path.resolve(baseDir, name);
  if (!artifactPath.startsWith(path.resolve(baseDir))) {
    throw new Error("Invalid artifact path");
  }
  try {
    return await fs.readFile(artifactPath, "utf8");
  } catch {
    return null;
  }
}

export async function listArtifacts(runId: string, stepId: string, workspaceId?: string): Promise<string[]> {
  assertSafeId(runId);
  assertSafeId(stepId);
  const resolved = await resolveRunDir(runId, workspaceId);
  if (!resolved) return [];
  const stepPath = path.join(resolved.runDir, "steps", stepId);
  const results: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  await walk(stepPath, "");
  return results.sort();
}

async function resolveRunDir(runId: string, workspaceId?: string): Promise<{ runDir: string; workspaceId?: string } | null> {
  const runsDir = getRunsDir();
  if (workspaceId) {
    const candidate = path.join(runsDir, workspaceId, runId);
    if (fsSync.existsSync(candidate)) return { runDir: candidate, workspaceId };
    return null;
  }

  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name, runId);
    if (fsSync.existsSync(candidate)) {
      return { runDir: candidate, workspaceId: entry.name };
    }
  }
  return null;
}
