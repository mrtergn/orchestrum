import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { buildRepoContext, buildRepoIndex, RepoIndex } from "./context.js";
import { runCommands } from "./commands.js";
import { EventWriter } from "./events.js";
import { ensureDir, readTextIfExists, writeJson, writeText } from "./fs.js";
import { applyPatch, ensureGitRepo, getHeadSha, gitDiff, checkoutBranch, commitAll, gitChangedFiles, checkPatchApplies } from "./git.js";
import { loadWorkflow, Workflow, StepDefinition } from "./workflow.js";
import { computeInputHash } from "./cache.js";
import { Semaphore } from "./semaphore.js";
import { buildParentIndex, buildResumePlan, buildStepBlocks, flattenBlocks, resolveStartIndex } from "./planning.js";
import { registerBuiltInAgents, getAgentFactory } from "../agents/index.js";
import { loadConfig, resolveConcurrency } from "./config.js";
import type { OrchestrumConfig } from "./config.js";
import { createRunId, extractDiffBlock, extractJsonBlock, formatError, nowIso, nowTs } from "./utils.js";
import { estimateCostUsd, resolvePricing, normalizeUsage, LlmUsage } from "./cost.js";
import { loadPolicy, checkPatchPolicy, checkCostPolicy } from "./policy.js";
import { runSandboxedLLM, isDockerAvailable, SandboxConfig } from "./sandbox.js";
import { loadRecentSummaries, appendSummary, buildRunSummary } from "./memory.js";
import { loadPlugins, runPluginHook, OrchestrumPlugin } from "./plugins.js";
import type { RunState } from "./types.js";
import { analyzeRun } from "../analytics/runAnalysis.js";
import { updateAnalytics } from "../analytics/store.js";
import { updateKnowledgeGraph } from "../analytics/knowledge.js";
import { updatePromptHistory } from "../evolution/promptEvolution.js";
import { generateOpportunities } from "../evolution/backlog.js";
import {
  applyStrategy,
  loadStrategy,
  loadStrategyState,
  resolveStrategyProfile,
  suggestStrategyMode,
  updateStrategyState
} from "../evolution/strategy.js";
import { computeReward, loadAdaptationState, updateAdaptationState } from "../evolution/reward.js";
import { computeRiskScore, extractVulnerabilityScore } from "../security/risk.js";
import { scanCommands, scanDiff, requiresApproval, summarizeFindings } from "../security/safety.js";
import { runArbitration, ProviderSpec } from "../arbitration/engine.js";
import { buildTask, enqueueTask, waitForResult } from "../cluster/queue.js";
import { CURRENT_SCHEMA_VERSION } from "../migrations/index.js";
import { createApprovalToken, writeApprovalRequest, isWorkspaceApproved } from "./approvals.js";
import { Logger } from "./logger.js";
import { getLicenseStatus, isFeatureAllowed } from "../licensing/index.js";
import { loadWorkspaceProfile } from "../profiles/index.js";
import { emitTelemetry } from "../telemetry/index.js";

export type RunOptions = {
  workflowPath: string;
  repoPath: string;
  runsDir: string;
  goal: string;
  branch?: string;
  workspaceId?: string;
  sandbox?: "docker";
  strategyMode?: string;
  runId?: string;
  configOverrides?: RunConfigOverrides;
};

export type ResumeOptions = {
  runId: string;
  runsDir: string;
  fromStepId: string;
  workspaceId?: string;
};

export type ReplayOptions = {
  runId: string;
  runsDir: string;
  workspaceId?: string;
};

export type RunConfigOverrides = {
  concurrency?: number;
  sandboxEnabled?: boolean;
  modelOverrides?: Record<string, string>;
};

type StepResult = {
  ok: boolean;
  outputText: string;
  outputJson?: unknown;
  blocking?: boolean;
  commandsLogPath?: string;
  cached?: boolean;
  commitSha?: string | null;
  gitDiffPath?: string | null;
  usage?: LlmUsage | null;
  costUsd?: number | null;
  agentId?: string | null;
  stepType?: string | null;
  riskScore?: number | null;
  behavior?: {
    reasoningSummary?: string | null;
    confidence?: number | null;
    decisionPath?: string[] | null;
  } | null;
  provider?: string | null;
  model?: string | null;
};

class CancelledError extends Error {
  constructor() {
    super("Run cancelled");
  }
}

export async function runWorkflow(options: RunOptions): Promise<boolean> {
  const workflow = await loadWorkflow(options.workflowPath);
  const result = await executeWorkflow({
    workflow,
    repoPath: options.repoPath,
    runsDir: options.runsDir,
    goal: options.goal,
    branch: options.branch,
    workspaceId: options.workspaceId,
    sandbox: options.sandbox,
    strategyMode: options.strategyMode,
    runId: options.runId,
    configOverrides: options.configOverrides
  });
  return result.ok;
}

export async function resumeWorkflow(options: ResumeOptions): Promise<boolean> {
  const resolved = await resolveRunDir(options.runsDir, options.runId, options.workspaceId);
  const runDir = resolved.runDir;
  const runMetaPath = path.join(runDir, "run.json");
  const raw = await fs.readFile(runMetaPath, "utf8");
  const meta = JSON.parse(raw) as RunState & { repoPath: string; workflow: string; goal?: string; userGoal?: string };
  const workflow = await loadWorkflow(meta.workflow);
  const fallbackGoal = meta.userGoal ?? meta.goal ?? (await loadGoalFromRun(runDir, workflow)) ?? "";

  const result = await executeWorkflow({
    workflow,
    repoPath: meta.repoPath,
    runsDir: options.runsDir,
    goal: fallbackGoal,
    resume: {
      runId: options.runId,
      fromStepId: options.fromStepId
    },
    branch: meta.branch ?? undefined,
    workspaceId: resolved.workspaceId ?? meta.workspaceId,
    runDir: resolved.runDir
  });
  return result.ok;
}

export async function runWorkflowDetailed(options: RunOptions): Promise<{ ok: boolean; runId: string; runDir: string }> {
  const workflow = await loadWorkflow(options.workflowPath);
  return executeWorkflow({
    workflow,
    repoPath: options.repoPath,
    runsDir: options.runsDir,
    goal: options.goal,
    branch: options.branch,
    workspaceId: options.workspaceId,
    sandbox: options.sandbox,
    strategyMode: options.strategyMode,
    runId: options.runId,
    configOverrides: options.configOverrides
  });
}

export async function cancelRun(runsDir: string, runId: string, workspaceId?: string): Promise<void> {
  const resolved = await resolveRunDir(runsDir, runId, workspaceId);
  const runDir = resolved.runDir;
  await ensureDir(runDir);
  const tokenPath = path.join(runDir, "cancelled");
  await writeText(tokenPath, nowIso());
}

export async function replayRun(options: ReplayOptions): Promise<void> {
  const resolved = await resolveRunDir(options.runsDir, options.runId, options.workspaceId);
  const runDir = resolved.runDir;
  const runMetaPath = path.join(runDir, "run.json");
  const raw = await fs.readFile(runMetaPath, "utf8");
  const meta = JSON.parse(raw) as RunState & { repoPath: string; workflow: string };
  const workflow = await loadWorkflow(meta.workflow);

  const eventsPath = path.join(runDir, "events.ndjson");
  if (!fsSync.existsSync(eventsPath)) {
    await fs.writeFile(eventsPath, "", { flag: "a" });
  }
  const events = new EventWriter(eventsPath);
  const logger = new Logger(path.join(runDir, "logs", "runner.ndjson"), options.runId);
  const blocks = buildStepBlocks(workflow);
  const flatSteps = flattenBlocks(blocks);
  const totalSteps = estimateTotalSteps(workflow);
  let completedSteps = 0;

  events.emit({ t: "run.replayed", runId: options.runId, ts: nowTs() });

  for (const step of flatSteps) {
    const statusPath = path.join(runDir, "steps", step.stepId, "status.json");
    const rawStatus = await readTextIfExists(statusPath);
    if (!rawStatus) continue;
    let ok = true;
    try {
      const parsed = JSON.parse(rawStatus) as { ok?: boolean };
      ok = parsed.ok !== false;
    } catch {
      ok = true;
    }
    events.emit({ t: "step.started", stepId: step.stepId, ts: nowTs() });
    events.emit({ t: ok ? "step.finished" : "step.failed", stepId: step.stepId, ok, ts: nowTs() });
    completedSteps += 1;
    emitProgress(events, options.runId, completedSteps, totalSteps);
  }

  events.emit({ t: "run.finished", runId: options.runId, ok: meta.status !== "failed", ts: nowTs() });
  meta.replayedAt = nowIso();
  await writeJson(runMetaPath, meta);
}

async function executeWorkflow(options: {
  workflow: Workflow;
  repoPath: string;
  runsDir: string;
  goal: string;
  branch?: string;
  workspaceId?: string;
  sandbox?: "docker";
  strategyMode?: string;
  runId?: string;
  configOverrides?: RunConfigOverrides;
  runDir?: string;
  resume?: { runId: string; fromStepId: string };
}): Promise<{ ok: boolean; runId: string; runDir: string }> {
  registerBuiltInAgents();

  const config = await loadConfig(options.repoPath, toConfigOverrides(options.configOverrides)).catch((err) => {
    throw new Error(formatError(err));
  });
  const licenseStatus = await getLicenseStatus().catch(() => ({
    key: null,
    tier: "Free" as const,
    valid: false,
    expired: false,
    expiresAt: null
  }));
  const licenseTier = licenseStatus.valid ? licenseStatus.tier : "Free";
  const arbitrationAllowed = isFeatureAllowed(licenseTier, "arbitration");
  const clusterAllowed = isFeatureAllowed(licenseTier, "cluster");
  const analyticsAllowed = isFeatureAllowed(licenseTier, "analytics");
  const strategyEvolutionAllowed = isFeatureAllowed(licenseTier, "strategy_evolution");
  const advancedSandboxAllowed = isFeatureAllowed(licenseTier, "advanced_sandbox");
  const pluginsAllowed = isFeatureAllowed(licenseTier, "plugins");
  if (config?.cluster?.enabled && !clusterAllowed) {
    config.cluster = { ...config.cluster, enabled: false };
  }
  let workflow = applyConfig(options.workflow, config);
  const restrictedFeatures: string[] = [];
  if (!arbitrationAllowed && hasArbitrationConfigured(workflow)) {
    restrictedFeatures.push("arbitration");
    workflow = { ...workflow, arbitration: undefined };
  }
  if (!analyticsAllowed) restrictedFeatures.push("analytics");
  if (!strategyEvolutionAllowed) restrictedFeatures.push("strategy_evolution");
  if (!clusterAllowed && config?.cluster?.enabled) restrictedFeatures.push("cluster");
  if (!pluginsAllowed && config?.plugins && config.plugins.length > 0) restrictedFeatures.push("plugins");
  if (
    !advancedSandboxAllowed &&
    (config?.sandbox?.network || config?.sandbox?.cpu_limit || config?.sandbox?.memory_limit_mb)
  ) {
    restrictedFeatures.push("advanced_sandbox");
  }
  let policy = await loadPolicy(options.repoPath).catch((err) => {
    throw new Error(formatError(err));
  });
  policy = mergePolicy(policy, config?.policy ?? null);
  const strategyConfig = await loadStrategy(options.repoPath).catch(() => null);
  const profile = await loadWorkspaceProfile(options.repoPath).catch(() => null);
  const adaptationState = strategyEvolutionAllowed ? await loadAdaptationState(options.repoPath).catch(() => null) : null;
  const adaptiveStrategy = strategyEvolutionAllowed ? pickBestStrategy(adaptationState?.strategyWeights) : null;
  const strategyProfile = resolveStrategyProfile(
    options.strategyMode ?? config?.strategy?.mode ?? strategyConfig?.mode ?? adaptiveStrategy ?? "balanced"
  );
  const modelBias = strategyEvolutionAllowed ? adaptationState?.modelWeights ?? {} : {};
  const strategyState = strategyEvolutionAllowed ? await loadStrategyState(options.repoPath).catch(() => ({})) : {};
  const strategyApplied = applyStrategy({
    workflow,
    policy,
    profile: strategyProfile,
    state: strategyState
  });
  workflow = strategyApplied.workflow;
  policy = strategyApplied.policy;
  const plugins = pluginsAllowed ? await loadPlugins(options.repoPath, config, licenseTier).catch(() => [] as OrchestrumPlugin[]) : [];
  const memorySummaries = await loadRecentSummaries(options.repoPath, 3).catch(() => []);
  let sandboxConfig = resolveSandboxConfig(options.sandbox, config, advancedSandboxAllowed);
  let sandboxWarning: string | null = null;
  if (sandboxConfig?.enabled) {
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      sandboxWarning = "Docker not available. Falling back to local execution.";
      sandboxConfig = { ...sandboxConfig, enabled: false };
    }
  }

  const openAiAgents = Object.values(workflow.agents).filter((a) => a.provider === "openai" && !a.providers);
  if (openAiAgents.length > 0 && !process.env.OPENAI_API_KEY && !config?.local_llm) {
    throw new Error("OPENAI_API_KEY is missing and no local LLM fallback configured.");
  }

  await ensureGitRepo(options.repoPath);
  if (options.branch) {
    await checkoutBranch(options.repoPath, options.branch);
  }

  let headSha = await getHeadSha(options.repoPath);
  const runId = options.resume?.runId ?? options.runId ?? createRunId();
  const workspaceId = options.workspaceId ?? "default";
  const workspaceDir = path.join(options.runsDir, workspaceId);
  const runDir = options.runDir ?? path.join(workspaceDir, runId);
  const stepsDir = path.join(runDir, "steps");
  await ensureDir(stepsDir);
  const logger = new Logger(path.join(runDir, "logs", "runner.ndjson"), runId);

  const runMetaPath = path.join(runDir, "run.json");
  const eventsPath = path.join(runDir, "events.ndjson");
  if (!fsSync.existsSync(eventsPath)) {
    await fs.writeFile(eventsPath, "", { flag: "a" });
  }

  const events = new EventWriter(eventsPath);

  let totalSteps = estimateTotalSteps(workflow);
  let completedSteps = 0;

  let runMeta: RunState & { repoPath: string; workflow: string; branch?: string | null } = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    runId,
    repoPath: options.repoPath,
    workflow: workflow.__path,
    goal: options.goal,
    userGoal: options.goal,
    workspaceId,
    workspacePath: options.repoPath,
    start: nowIso(),
    end: null,
    status: "running",
    headSha,
    branch: options.branch ?? null,
    pinned: false,
    tags: [],
    totalSteps,
    completedSteps,
    totalTokens: 0,
    totalCost: 0,
    costByAgent: {},
    modelUsage: {},
    rewardHistory: [],
    dynamicAgents: [],
    strategy: {
      mode: strategyProfile.mode,
      adjustments: strategyApplied.adjustments
    },
    license: {
      tier: licenseTier,
      valid: licenseStatus.valid,
      expiresAt: licenseStatus.expiresAt ?? null
    },
    profile: profile ?? null
  };

  const emitRunTelemetry = async () => {
    if (!config?.telemetry?.enabled) return;
    const endTs = runMeta.end ? Date.parse(runMeta.end) : Date.now();
    const startTs = Date.parse(runMeta.start);
    const durationMs = Number.isNaN(startTs) ? 0 : Math.max(0, endTs - startTs);
    await emitTelemetry(
      {
        t: "run.summary",
        ts: nowIso(),
        tier: licenseTier,
        duration_ms: durationMs,
        total_tokens: runMeta.totalTokens ?? 0,
        total_cost: runMeta.totalCost ?? 0
      },
      config.telemetry
    );
  };

  if (options.resume) {
    const existing = await readTextIfExists(runMetaPath);
    if (existing) {
      const prev = JSON.parse(existing) as RunState & { resumeCount?: number; resumedFrom?: string | null };
      runMeta = {
        ...runMeta,
        schemaVersion: prev.schemaVersion ?? runMeta.schemaVersion,
        start: prev.start ?? runMeta.start,
        goal: prev.goal ?? runMeta.goal,
        userGoal: prev.userGoal ?? prev.goal ?? runMeta.userGoal,
        workspaceId: prev.workspaceId ?? runMeta.workspaceId,
        workspacePath: prev.workspacePath ?? runMeta.workspacePath,
        totalTokens: prev.totalTokens ?? runMeta.totalTokens,
        totalCost: prev.totalCost ?? runMeta.totalCost,
        costByAgent: prev.costByAgent ?? runMeta.costByAgent,
        modelUsage: prev.modelUsage ?? runMeta.modelUsage,
        rewardHistory: prev.rewardHistory ?? runMeta.rewardHistory,
        pinned: prev.pinned ?? runMeta.pinned,
        tags: prev.tags ?? runMeta.tags,
        dynamicAgents: prev.dynamicAgents ?? runMeta.dynamicAgents,
        strategy: prev.strategy ?? runMeta.strategy,
        license: prev.license ?? runMeta.license,
        profile: prev.profile ?? runMeta.profile,
        resumedFrom: options.resume.fromStepId,
        resumeCount: (prev.resumeCount ?? 0) + 1
      };
    } else {
      runMeta.resumedFrom = options.resume.fromStepId;
      runMeta.resumeCount = 1;
    }
  }

  await writeJson(runMetaPath, runMeta);

  events.emit({ t: "workspace.changed", workspaceId: workspaceId, ts: nowTs() });
  events.emit({ t: options.resume ? "run.resumed" : "run.started", runId, ts: nowTs(), totalSteps, workspaceId });
  await logger.info(options.resume ? "run.resumed" : "run.started", {
    runId,
    workspaceId,
    totalSteps
  });
  if (restrictedFeatures.length > 0) {
    events.emit({
      t: "license.restricted",
      runId,
      tier: licenseTier,
      features: restrictedFeatures,
      ts: nowTs()
    });
  }
  if (sandboxWarning) {
    events.emit({ t: "step.log", stepId: "sandbox", line: sandboxWarning, ts: nowTs() });
  }

  await runPluginHook(plugins, "onRunStart", runMeta);

  const metrics = {
    totalTokens: runMeta.totalTokens ?? 0,
    totalCost: runMeta.totalCost ?? 0,
    costByAgent: runMeta.costByAgent ?? {}
  };

  const recordMetrics = async (stepId: string, result: StepResult) => {
    if (result.cached) return;
    if (result.model) {
      const usageCount = runMeta.modelUsage ?? {};
      usageCount[result.model] = (usageCount[result.model] ?? 0) + 1;
      runMeta.modelUsage = usageCount;
      await writeJson(runMetaPath, runMeta);
    }
    if (!result.usage && result.costUsd == null) return;
    const tokens = result.usage?.total_tokens ?? 0;
    const cost = result.costUsd ?? 0;
    metrics.totalTokens += tokens;
    metrics.totalCost += cost;
    if (result.agentId) {
      const entry = metrics.costByAgent[result.agentId] ?? { tokens: 0, cost: 0 };
      entry.tokens += tokens;
      entry.cost += cost;
      metrics.costByAgent[result.agentId] = entry;
    }
    runMeta.totalTokens = metrics.totalTokens;
    runMeta.totalCost = metrics.totalCost;
    runMeta.costByAgent = metrics.costByAgent;
    await writeJson(runMetaPath, runMeta);
    events.emit({
      t: "cost.update",
      runId,
      stepId,
      agentId: result.agentId,
      totalTokens: metrics.totalTokens,
      totalCost: metrics.totalCost,
      ts: nowTs()
    });
    const costViolation = checkCostPolicy(metrics.totalCost, policy);
    if (costViolation) {
      events.emit({ t: "policy.violation", runId, reason: costViolation, ts: nowTs() });
      throw new Error(costViolation);
    }
  };

  const maxAgents = workflow.concurrency?.max_agents ?? resolveConcurrency(config) ?? 2;
  const agentSemaphore = new Semaphore(maxAgents);
  const parallelLimiter = new Semaphore(maxAgents);

  const repoIndex = await buildRepoIndex(options.repoPath);

  const blocks = buildStepBlocks(workflow);
  const flatSteps = flattenBlocks(blocks);
  const parentIndex = buildParentIndex(blocks);
  const parentToSubsteps = new Map<string, string[]>();
  for (const block of blocks) {
    if (block.kind === "parallel") {
      parentToSubsteps.set(
        block.parentId,
        block.steps.map((s) => s.stepId)
      );
    }
  }

  let lastGitDiffPath: string | null = null;
  let lastCommandsLogPath: string | null = null;
  let specText: string | undefined;
  let runOk = true;
  const riskScores: number[] = [];

  const completedStepIds = options.resume
    ? await loadCompletedSteps(runDir)
    : new Set<string>();

  let planStartIndex = 0;
  let toRun = new Set<string>(flatSteps.map((s) => s.stepId));
  const bypassCacheSteps = new Set<string>();
  const forceRunSteps = new Set<string>();
  if (options.resume) {
    planStartIndex = resolveStartIndex(flatSteps.map((s) => s.stepId), parentIndex, options.resume.fromStepId);
    forceRunSteps.add(options.resume.fromStepId);
    const substeps = parentToSubsteps.get(options.resume.fromStepId);
    if (substeps) {
      for (const sub of substeps) {
        forceRunSteps.add(sub);
      }
    }
    const plan = buildResumePlan({
      stepIds: flatSteps.map((s) => s.stepId),
      startIndex: planStartIndex,
      completed: completedStepIds,
      forceRun: forceRunSteps
    });
    toRun = plan.toRun;
    completedSteps = plan.skipped.size;
    bypassCacheSteps.add(options.resume.fromStepId);
    if (substeps) {
      for (const sub of substeps) {
        bypassCacheSteps.add(sub);
      }
    }
    const pmStepIds = flatSteps.filter((step) => step.definition.agent === "pm").map((step) => step.stepId);
    const specPath = pmStepIds.length > 0
      ? await findLatestArtifact(runDir, pmStepIds, completedStepIds, "output.md")
      : null;
    if (specPath) {
      specText = (await readTextIfExists(specPath)) ?? undefined;
    }
    lastGitDiffPath = await findLatestArtifact(runDir, flatSteps.map((s) => s.stepId), completedStepIds, "git.diff");
    lastCommandsLogPath = await findLatestArtifact(runDir, flatSteps.map((s) => s.stepId), completedStepIds, "commands.log");
  }

  runMeta.completedSteps = completedSteps;
  await writeJson(runMetaPath, runMeta);

  emitProgress(events, runId, completedSteps, totalSteps);

  try {
    const loopConfig = workflow.loop ?? {
      max_rounds: 1,
      max_loop_per_step: 1,
      audit_step_id: "audit",
      fix_step_id: "fix"
    };
    const auditStep = workflow.steps.find((s) => s.id === loopConfig.audit_step_id);
    const fixStep = workflow.steps.find((s) => s.id === loopConfig.fix_step_id);
    const maxRounds = loopConfig.max_rounds ?? 1;
    let adaptiveMaxLoop = Math.min(maxRounds, loopConfig.max_loop_per_step ?? maxRounds);

    const applyRiskAdjustment = (score?: number | null) => {
      if (typeof score !== "number") return;
      if (score >= 0.7) {
        adaptiveMaxLoop = Math.min(adaptiveMaxLoop + 1, maxRounds + 2);
        const adjustments = runMeta.strategy?.adjustments ?? [];
        if (!adjustments.includes("audit strictness elevated")) {
          adjustments.push("audit strictness elevated");
          runMeta.strategy = { ...runMeta.strategy, adjustments };
        }
      }
    };

    let loopHandled = false;

    for (const block of blocks) {
      if (loopHandled && block.kind === "single" && block.step.stepId === loopConfig.audit_step_id) {
        continue;
      }
      if (loopHandled && block.kind === "single" && block.step.stepId === loopConfig.fix_step_id) {
        continue;
      }

      if (block.kind === "single" && auditStep && block.step.stepId === loopConfig.audit_step_id) {
        if (!toRun.has(block.step.stepId)) {
          continue;
        }
        const loopResult = await runAuditLoop({
          auditStep,
          fixStep,
          maxRounds: adaptiveMaxLoop,
          workflow,
          repoPath: options.repoPath,
          runDir,
          runId,
          events,
          agentSemaphore,
          repoIndex,
          goal: options.goal,
          specText,
          lastGitDiffPath,
          lastCommandsLogPath,
          headSha,
          branch: options.branch,
          onProgress: () => {
            completedSteps += 1;
            emitProgress(events, runId, completedSteps, totalSteps);
          },
          onStepResult: async (stepId, result) => {
            await recordMetrics(stepId, result);
            if (typeof result.riskScore === "number") {
              riskScores.push(result.riskScore);
              applyRiskAdjustment(result.riskScore);
            }
          },
          bypassCacheSteps,
          sandboxConfig,
          policy,
          config,
          plugins,
          memorySummaries,
          modelBias,
          allowArbitration: arbitrationAllowed
        });

        lastGitDiffPath = loopResult.lastGitDiffPath;
        lastCommandsLogPath = loopResult.lastCommandsLogPath;
        if (loopResult.specText) {
          specText = loopResult.specText;
        }
        if (loopResult.headSha) {
          headSha = loopResult.headSha;
        }
        if (!loopResult.ok) {
          runOk = false;
          if (!loopResult.continueOnError) {
            throw new Error(loopResult.error ?? "Audit loop failed");
          }
        }
        loopHandled = true;
        continue;
      }

      if (block.kind === "parallel") {
        const parentId = block.parentId;
        const shouldRunParent = toRun.has(parentId) || block.steps.some((s) => toRun.has(s.stepId));
        if (!shouldRunParent) {
          continue;
        }
        await ensureDir(path.join(runDir, "steps", parentId));
        const parentStatus = {
          stepId: parentId,
          start: nowIso(),
          end: null as string | null,
          ok: true,
          error: null as string | null
        };
        events.emit({ t: "step.started", stepId: parentId, ts: nowTs() });

        const tasks = block.steps.map((sub) =>
          parallelLimiter.use(async () => {
            if (!toRun.has(sub.stepId)) {
              return { ok: true, skipped: true } as const;
            }
            return runStep({
              step: sub.definition,
              stepId: sub.stepId,
              runId,
              workflow,
              repoPath: options.repoPath,
              runDir,
              events,
              agentSemaphore,
              repoIndex,
              goal: options.goal,
              specText,
              lastGitDiffPath,
              lastCommandsLogPath,
              headSha,
              branch: options.branch,
              auditStepId: loopConfig.audit_step_id,
              bypassCache: bypassCacheSteps.has(sub.stepId),
              sandboxConfig,
              policy,
              config,
              plugins,
              memorySummaries,
              securityThreshold: workflow.security?.threshold,
              modelBias,
              allowArbitration: arbitrationAllowed
            });
          })
        );

        const results = await Promise.all(tasks);
        for (let i = 0; i < results.length; i += 1) {
          const result = results[i];
          const stepId = block.steps[i]?.stepId;
          if (result && "commandsLogPath" in result && result.commandsLogPath) {
            lastCommandsLogPath = result.commandsLogPath;
          }
          if (result && "gitDiffPath" in result && result.gitDiffPath) {
            lastGitDiffPath = result.gitDiffPath;
          }
          if (result && "ok" in result && !(result as { skipped?: boolean }).skipped) {
            completedSteps += 1;
            emitProgress(events, runId, completedSteps, totalSteps);
            if (stepId) {
              await recordMetrics(stepId, result as StepResult);
            }
            if (typeof (result as StepResult).riskScore === "number") {
              const score = (result as StepResult).riskScore as number;
              riskScores.push(score);
              applyRiskAdjustment(score);
            }
          }
        }
        if (results.some((r) => r && "commitSha" in r && r.commitSha)) {
          headSha = await getHeadSha(options.repoPath);
        }

        const anyFailed = results.some((r) => r && "ok" in r && !r.ok);
        const fatalFailed = results.some((r, idx) => {
          if (!r || !("ok" in r) || r.ok) return false;
          const def = block.steps[idx]?.definition;
          return !def?.continue_on_error;
        });
        if (anyFailed) {
          parentStatus.ok = false;
          parentStatus.error = "One or more substeps failed";
          events.emit({ t: "step.failed", stepId: parentId, error: parentStatus.error, ts: nowTs() });
        }
        parentStatus.end = nowIso();
        await writeJson(path.join(runDir, "steps", parentId, "status.json"), parentStatus);
        events.emit({ t: "step.finished", stepId: parentId, ok: parentStatus.ok, ts: nowTs() });

        if (fatalFailed) {
          runOk = false;
          throw new Error("Parallel step failed");
        }
        continue;
      }

      if (block.kind === "single") {
        const stepId = block.step.stepId;
        if (block.step.definition.type === "test_generation" && !workflow.enable_auto_tests) {
          continue;
        }
        if (!toRun.has(stepId)) {
          continue;
        }
        const result = await runStep({
          step: block.step.definition,
          stepId,
          runId,
          workflow,
          repoPath: options.repoPath,
          runDir,
          events,
          agentSemaphore,
          repoIndex,
          goal: options.goal,
          specText,
          lastGitDiffPath,
          lastCommandsLogPath,
          headSha,
          branch: options.branch,
          auditStepId: loopConfig.audit_step_id,
          bypassCache: bypassCacheSteps.has(stepId),
          sandboxConfig,
          policy,
          config,
          plugins,
          memorySummaries,
          securityThreshold: workflow.security?.threshold,
          modelBias,
          allowArbitration: arbitrationAllowed
        });

        if (typeof result.riskScore === "number") {
          riskScores.push(result.riskScore);
          applyRiskAdjustment(result.riskScore);
        }

        if (!result.ok) {
          runOk = false;
          if (!block.step.definition.continue_on_error) {
            throw new Error(result.outputText || "Step failed");
          }
        }

        await recordMetrics(stepId, result);

        if (block.step.definition.agent === "pm") {
          specText = result.outputText;
        }

        if (result.gitDiffPath) {
          lastGitDiffPath = result.gitDiffPath;
        }

        if (result.commandsLogPath) {
          lastCommandsLogPath = result.commandsLogPath;
        }

        if (result.commitSha) {
          headSha = result.commitSha;
        }

        const extractedAgents = extractDynamicAgents(result.outputJson, result.outputText);
        const spawnedAgents = await registerDynamicAgents({
          agents: extractedAgents,
          workflow,
          runMeta,
          runMetaPath,
          events,
          sourceStepId: stepId,
          sourceAgent: block.step.definition.agent ?? null
        });

        if (spawnedAgents.length > 0) {
          totalSteps += spawnedAgents.length;
          runMeta.totalSteps = totalSteps;
          await writeJson(runMetaPath, runMeta);
        }

        completedSteps += 1;
        emitProgress(events, runId, completedSteps, totalSteps);

        if (spawnedAgents.length > 0) {
          const dynamicResults = await runDynamicAgentSteps({
            agents: spawnedAgents,
            workflow,
            repoPath: options.repoPath,
            runDir,
            runId,
            events,
            agentSemaphore,
            parallelLimiter,
            repoIndex,
            goal: options.goal,
            specText,
            lastGitDiffPath,
            lastCommandsLogPath,
            headSha,
            branch: options.branch,
            auditStepId: loopConfig.audit_step_id,
            sandboxConfig,
            policy,
            config,
            plugins,
            memorySummaries,
            modelBias,
            allowArbitration: arbitrationAllowed
          });

          for (const dynamic of dynamicResults) {
            if (dynamic.result.gitDiffPath) {
              lastGitDiffPath = dynamic.result.gitDiffPath;
            }
            if (dynamic.result.commandsLogPath) {
              lastCommandsLogPath = dynamic.result.commandsLogPath;
            }
            if (dynamic.result.commitSha) {
              headSha = dynamic.result.commitSha;
            }
            completedSteps += 1;
            emitProgress(events, runId, completedSteps, totalSteps);
            await recordMetrics(dynamic.stepId, dynamic.result);
            if (typeof dynamic.result.riskScore === "number") {
              riskScores.push(dynamic.result.riskScore);
              applyRiskAdjustment(dynamic.result.riskScore);
            }
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      runMeta.status = "cancelled";
      runMeta.end = nowIso();
      runMeta.completedSteps = completedSteps;
      await applyPostRunEvolution({
        runMeta,
        runDir,
        workflow,
        repoPath: options.repoPath,
        strategyConfig,
        strategyProfileMode: strategyProfile.mode,
        strategyState,
        events,
        memorySummaries,
        config,
        analyticsAllowed,
        strategyEvolutionAllowed
      });
      await writeJson(path.join(runDir, "run.json"), runMeta);
      events.emit({ t: "run.cancelled", runId, ts: nowTs() });
      await logger.warn("run.cancelled", { runId });
      await runPluginHook(plugins, "onRunFinish", runMeta);
      await appendRunSummary(runMeta, runDir);
      await emitRunTelemetry();
      return { ok: false, runId, runDir };
    }

    runOk = false;
    runMeta.status = "failed";
    runMeta.end = nowIso();
    runMeta.completedSteps = completedSteps;
    await applyPostRunEvolution({
      runMeta,
      runDir,
      workflow,
      repoPath: options.repoPath,
      strategyConfig,
      strategyProfileMode: strategyProfile.mode,
      strategyState,
      events,
      memorySummaries,
      config,
      analyticsAllowed,
      strategyEvolutionAllowed
    });
    await writeJson(path.join(runDir, "run.json"), runMeta);
    events.emit({ t: "run.finished", runId, ok: false, ts: nowTs() });
    await logger.error("run.failed", { runId });
    await runPluginHook(plugins, "onRunFinish", runMeta);
    await appendRunSummary(runMeta, runDir);
    await emitRunTelemetry();
    throw err;
  }

  runMeta.status = runOk ? "finished" : "failed";
  runMeta.end = nowIso();
  runMeta.completedSteps = completedSteps;
  await applyPostRunEvolution({
    runMeta,
    runDir,
    workflow,
    repoPath: options.repoPath,
    strategyConfig,
    strategyProfileMode: strategyProfile.mode,
    strategyState,
    events,
    memorySummaries,
    config,
    analyticsAllowed,
    strategyEvolutionAllowed
  });
  await writeJson(path.join(runDir, "run.json"), runMeta);
  events.emit({ t: "run.finished", runId, ok: runOk, ts: nowTs() });
  await logger.info("run.finished", { runId, ok: runOk });
  await runPluginHook(plugins, "onRunFinish", runMeta);
  await appendRunSummary(runMeta, runDir);
  await emitRunTelemetry();

  return { ok: runOk, runId, runDir };
}

async function runAuditLoop(options: {
  auditStep: StepDefinition;
  fixStep?: StepDefinition;
  maxRounds: number;
  workflow: Workflow;
  repoPath: string;
  runDir: string;
  runId: string;
  events: EventWriter;
  agentSemaphore: Semaphore;
  repoIndex: RepoIndex;
  goal: string;
  specText?: string;
  lastGitDiffPath: string | null;
  lastCommandsLogPath: string | null;
  headSha: string;
  branch?: string;
  onProgress: () => void;
  onStepResult: (stepId: string, result: StepResult) => Promise<void> | void;
  bypassCacheSteps?: Set<string>;
  sandboxConfig?: SandboxConfig | null;
  policy: Awaited<ReturnType<typeof loadPolicy>> | null;
  config: Awaited<ReturnType<typeof loadConfig>> | null;
  plugins: OrchestrumPlugin[];
  memorySummaries: string[];
  modelBias?: Record<string, number>;
  allowArbitration: boolean;
}): Promise<{ ok: boolean; lastGitDiffPath: string | null; lastCommandsLogPath: string | null; headSha?: string; specText?: string; continueOnError?: boolean; error?: string }>
{
  let round = 0;
  let ok = true;
  let lastGitDiffPath = options.lastGitDiffPath;
  let lastCommandsLogPath = options.lastCommandsLogPath;
  let specText = options.specText;
  let headSha = options.headSha;

  while (round < options.maxRounds) {
    round += 1;
      const auditResult = await runStep({
        step: options.auditStep,
        stepId: options.auditStep.id,
        runId: options.runId,
        workflow: options.workflow,
      repoPath: options.repoPath,
      runDir: options.runDir,
      events: options.events,
      agentSemaphore: options.agentSemaphore,
      repoIndex: options.repoIndex,
      goal: options.goal,
      specText,
      lastGitDiffPath,
      lastCommandsLogPath,
      headSha,
      branch: options.branch,
      auditStepId: options.auditStep.id,
      bypassCache: options.bypassCacheSteps?.has(options.auditStep.id) ?? false,
      sandboxConfig: options.sandboxConfig,
      policy: options.policy,
      config: options.config,
      plugins: options.plugins,
      memorySummaries: options.memorySummaries,
      securityThreshold: options.workflow.security?.threshold,
      modelBias: options.modelBias,
      allowArbitration: options.allowArbitration
    });

    if (!auditResult.ok) {
      ok = false;
    }

    if (auditResult.commandsLogPath) {
      lastCommandsLogPath = auditResult.commandsLogPath;
    }

    await options.onStepResult(options.auditStep.id, auditResult);

    options.onProgress();

    const blocking = auditResult.blocking;
    if (blocking === false) {
      return { ok, lastGitDiffPath, lastCommandsLogPath, headSha, specText };
    }

    if (blocking !== true) {
      return { ok: false, lastGitDiffPath, lastCommandsLogPath, headSha, specText, error: "Audit blocking missing", continueOnError: options.auditStep.continue_on_error };
    }

    const suggestedFix = (auditResult.outputJson as any)?.suggested_fix;
    if (suggestedFix && typeof suggestedFix === "string") {
      const diff = extractDiffBlock(suggestedFix);
      if (diff) {
        try {
          assertDiffPathSafety(diff);
          await requireApprovalIfNeeded({
            runDir: options.runDir,
            stepId: options.auditStep.id,
            runId: options.runId,
            findings: scanDiff(diff),
            events: options.events,
            repoPath: options.repoPath,
            kind: "diff"
          });
          await applyPatch(options.repoPath, diff);
          const violation = await checkPatchPolicy(options.repoPath, options.policy);
          if (violation) {
            options.events.emit({ t: "policy.violation", runId: options.runId, stepId: options.auditStep.id, reason: violation, ts: nowTs() });
            throw new Error(violation);
          }
          const currentDiff = await gitDiff(options.repoPath);
          const gitDiffPath = path.join(options.runDir, "steps", options.auditStep.id, "git.diff");
          await writeText(gitDiffPath, currentDiff);
          lastGitDiffPath = gitDiffPath;
        } catch (err) {
          ok = false;
        }
      }
    }

    if (!options.fixStep) {
      return { ok: false, lastGitDiffPath, lastCommandsLogPath, headSha, specText, error: "Fix step missing", continueOnError: options.auditStep.continue_on_error };
    }

    if (round >= options.maxRounds) {
      return { ok: false, lastGitDiffPath, lastCommandsLogPath, headSha, specText, error: "Max rounds reached", continueOnError: options.auditStep.continue_on_error };
    }

    const fixResult = await runStep({
      step: options.fixStep,
      stepId: options.fixStep.id,
      runId: options.runId,
      workflow: options.workflow,
      repoPath: options.repoPath,
      runDir: options.runDir,
      events: options.events,
      agentSemaphore: options.agentSemaphore,
      repoIndex: options.repoIndex,
      goal: options.goal,
      specText,
      lastGitDiffPath,
      lastCommandsLogPath,
      headSha,
      branch: options.branch,
      auditStepId: options.auditStep.id,
      bypassCache: options.bypassCacheSteps?.has(options.fixStep.id) ?? false,
      sandboxConfig: options.sandboxConfig,
      policy: options.policy,
      config: options.config,
      plugins: options.plugins,
      memorySummaries: options.memorySummaries,
      securityThreshold: options.workflow.security?.threshold,
      modelBias: options.modelBias,
      allowArbitration: options.allowArbitration
    });

    if (!fixResult.ok) {
      ok = false;
      if (!options.fixStep.continue_on_error) {
        return { ok: false, lastGitDiffPath, lastCommandsLogPath, headSha, specText, continueOnError: false };
      }
    }

    if (fixResult.commandsLogPath) {
      lastCommandsLogPath = fixResult.commandsLogPath;
    }

    if (fixResult.gitDiffPath) {
      lastGitDiffPath = fixResult.gitDiffPath;
    }

    if (fixResult.commitSha) {
      headSha = fixResult.commitSha;
    }

    await options.onStepResult(options.fixStep.id, fixResult);

    options.onProgress();
  }

  return { ok: false, lastGitDiffPath, lastCommandsLogPath, headSha, specText, error: "Audit loop incomplete", continueOnError: options.auditStep.continue_on_error };
}

async function runStep(options: {
  step: StepDefinition;
  stepId: string;
  runId: string;
  workflow: Workflow;
  repoPath: string;
  runDir: string;
  events: EventWriter;
  agentSemaphore: Semaphore;
  repoIndex: RepoIndex;
  goal: string;
  specText?: string;
  lastGitDiffPath: string | null;
  lastCommandsLogPath: string | null;
  headSha: string;
  branch?: string;
  auditStepId: string;
  bypassCache: boolean;
  sandboxConfig?: SandboxConfig | null;
  policy: Awaited<ReturnType<typeof loadPolicy>> | null;
  config: Awaited<ReturnType<typeof loadConfig>> | null;
  plugins: OrchestrumPlugin[];
  memorySummaries: string[];
  securityThreshold?: number;
  modelBias?: Record<string, number>;
  allowArbitration: boolean;
}): Promise<StepResult> {
  const { step, workflow, repoPath, runDir, events, goal } = options;
  const stepId = options.stepId;
  const stepDir = path.join(runDir, "steps", stepId);
  await ensureDir(stepDir);

  if (isCancelled(runDir)) {
    throw new CancelledError();
  }

  const agentConfig = step.agent ? workflow.agents[step.agent] : undefined;
  if (!agentConfig && step.agent) {
    throw new Error(`Missing agent config for ${step.agent}`);
  }
  const agentRole = resolveAgentRole(step.agent ?? null, agentConfig);
  const capability = resolveCapabilities(workflow, step.agent ?? null, agentRole);
  const providerSpecs = step.agent && agentConfig ? resolveProviderSpecs(step, agentConfig, options.config) : [];

  const inputs = await resolveInputs({
    step,
    workflow,
    repoPath,
    runDir,
    goal,
    specText: options.specText,
    lastGitDiffPath: options.lastGitDiffPath,
    lastCommandsLogPath: options.lastCommandsLogPath,
    repoIndex: options.repoIndex,
    memorySummaries: options.memorySummaries
  });

  const promptTemplate = step.prompt ? await fs.readFile(step.prompt, "utf8") : "";
  const renderedPrompt = renderPrompt(promptTemplate, inputs);

  const cacheHash = computeInputHash({
    renderedPrompt,
    model: providerSpecs.length > 0 ? providerSpecs.map((p) => `${p.provider}:${p.model}`).join("|") : (agentConfig?.model ?? ""),
    agent: step.agent ?? "",
    headSha: options.headSha
  });

  const cachePath = path.join(stepDir, "input.hash");
  if (!options.bypassCache && (await readTextIfExists(cachePath)) === cacheHash) {
    const cachedOutput = await readTextIfExists(path.join(stepDir, "output.md"));
    const cachedStatusRaw = await readTextIfExists(path.join(stepDir, "status.json"));
    const cachedStatusOk = cachedStatusRaw ? safeParseOk(cachedStatusRaw) : false;
    if (cachedOutput && cachedStatusOk) {
      events.emit({ t: "step.started", stepId, ts: nowTs() });
      if (step.agent) {
        events.emit({ t: "agent.status", agentId: step.agent, status: "idle", detail: stepId, ts: nowTs() });
      }
      await runPluginHook(options.plugins, "onStepStart", {
        stepId,
        status: "running",
        agentId: step.agent ?? null
      });
      let cachedUsage: LlmUsage | null = null;
      let cachedCost: number | null = null;
      let cachedRisk: number | null = null;
      let cachedBehavior: {
        reasoningSummary?: string | null;
        confidence?: number | null;
        decisionPath?: string[] | null;
      } | null = null;
      let cachedProvider: string | null = null;
      let cachedModel: string | null = null;
      if (cachedStatusRaw) {
        try {
          const parsed = JSON.parse(cachedStatusRaw) as {
            usage?: LlmUsage | null;
            costUsd?: number | null;
            riskScore?: number | null;
            provider?: string | null;
            model?: string | null;
            behavior?: {
              reasoningSummary?: string | null;
              confidence?: number | null;
              decisionPath?: string[] | null;
            } | null;
          };
          if (parsed.usage) cachedUsage = parsed.usage;
          if (typeof parsed.costUsd === "number") cachedCost = parsed.costUsd;
          if (typeof parsed.riskScore === "number") cachedRisk = parsed.riskScore;
          if (typeof parsed.provider === "string") cachedProvider = parsed.provider;
          if (typeof parsed.model === "string") cachedModel = parsed.model;
          if (parsed.behavior) cachedBehavior = parsed.behavior;
        } catch {
          // ignore
        }
      }
      if (!cachedUsage) {
        const usageRaw = await readTextIfExists(path.join(stepDir, "usage.json"));
        if (usageRaw) {
          try {
            cachedUsage = JSON.parse(usageRaw) as LlmUsage;
          } catch {
            // ignore
          }
        }
      }
      let cachedBlocking: boolean | undefined;
      let cachedOutputJson: unknown | undefined;
      let cachedGitDiff: string | null = null;
      if (stepId === options.auditStepId) {
        const cachedJsonRaw = await readTextIfExists(path.join(stepDir, "output.json"));
        if (cachedJsonRaw) {
          try {
            cachedOutputJson = JSON.parse(cachedJsonRaw);
            if (typeof (cachedOutputJson as any).blocking === "boolean") {
              cachedBlocking = (cachedOutputJson as any).blocking;
            }
          } catch {
            // ignore
          }
        } else {
          const parsed = extractJsonBlock(cachedOutput);
          if (parsed && typeof parsed === "object") {
            cachedOutputJson = parsed;
            if (typeof (parsed as any).blocking === "boolean") {
              cachedBlocking = (parsed as any).blocking;
            }
          }
        }
      }
      events.emit({ t: "step.cached", stepId, cached: true, ts: nowTs() });
      const status = {
        stepId,
        agentId: step.agent ?? null,
        type: step.type ?? null,
        start: nowIso(),
        end: nowIso(),
        ok: true,
        cached: true,
        error: null as string | null,
        usage: cachedUsage,
        costUsd: cachedCost,
        provider: cachedProvider,
        model: cachedModel
      };
      await writeJson(path.join(stepDir, "status.json"), status);
      events.emit({ t: "step.finished", stepId, ok: true, cached: true, ts: nowTs() });
      cachedGitDiff = await readTextIfExists(path.join(stepDir, "git.diff"));
      await runPluginHook(options.plugins, "onStepFinish", {
        stepId,
        status: "cached",
        agentId: step.agent ?? null,
        ok: true,
        cached: true,
        provider: cachedProvider,
        model: cachedModel,
        usage: cachedUsage,
        costUsd: cachedCost
      });
      return {
        ok: true,
        outputText: cachedOutput,
        cached: true,
        blocking: cachedBlocking,
        outputJson: cachedOutputJson,
        gitDiffPath: cachedGitDiff ? path.join(stepDir, "git.diff") : null,
        usage: cachedUsage,
        costUsd: cachedCost,
        riskScore: cachedRisk,
        behavior: cachedBehavior,
        agentId: step.agent ?? null,
        stepType: step.type ?? null,
        provider: cachedProvider,
        model: cachedModel
      };
    }
  }

  const inputJson = {
    stepId,
    agent: step.agent ?? null,
    prompt: step.prompt ?? null,
    inputs,
    renderedPrompt
  };
  await writeJson(path.join(stepDir, "input.json"), inputJson);
  await writeText(cachePath, cacheHash);

  if (step.agent) {
    events.emit({ t: "agent.status", agentId: step.agent, status: "active", detail: stepId, ts: nowTs() });
  }
  events.emit({ t: "step.started", stepId, ts: nowTs() });
  await runPluginHook(options.plugins, "onStepStart", {
    stepId,
    status: "running",
    agentId: step.agent ?? null
  });

  const status = {
    stepId,
    agentId: step.agent ?? null,
    type: step.type ?? null,
    start: nowIso(),
    end: null as string | null,
    ok: true,
    error: null as string | null,
    cached: false,
    commitSha: null as string | null,
    usage: null as LlmUsage | null,
    costUsd: null as number | null,
    provider: null as string | null,
    model: null as string | null,
    riskScore: null as number | null,
    behavior: null as {
      reasoningSummary?: string | null;
      confidence?: number | null;
      decisionPath?: string[] | null;
    } | null
  };

  let outputText = "";
  let outputJson: unknown | undefined;
  let blocking: boolean | undefined;
  let commandsLogPath: string | undefined;
  let gitDiffPath: string | null = null;
  let usage: LlmUsage | null = null;
  let costUsd: number | null = null;
  let riskScore: number | null = null;
  let behavior: {
    reasoningSummary?: string | null;
    confidence?: number | null;
    decisionPath?: string[] | null;
  } | null = null;

  try {
    if (step.agent && agentConfig) {
      if (providerSpecs.length === 0) {
        throw new Error(`No providers configured for agent ${step.agent}`);
      }

      const shouldSandbox =
        options.sandboxConfig?.enabled &&
        (agentRole === "dev" || agentRole === "audit");
      const env = buildAgentEnv(options.config);

      const executeProvider = async (spec: ProviderSpec) => {
        const start = Date.now();

        if (shouldSandbox && spec.provider === "openai") {
          const sandboxResult = await runSandboxedLLM({
            repoPath,
            runDir,
            stepId,
            provider: spec.provider,
            model: spec.model,
            image: options.sandboxConfig?.image ?? "node:20-alpine",
            env,
            config: options.sandboxConfig
          });
          if (sandboxResult.ok) {
            return {
              text: sandboxResult.outputText,
              usage: normalizeUsage(sandboxResult.usage ?? null),
              durationMs: Date.now() - start
            };
          }
          events.emit({
            t: "step.log",
            stepId,
            line: `Sandbox warning: ${sandboxResult.error}`,
            ts: nowTs()
          });
        } else if (shouldSandbox) {
          events.emit({
            t: "step.log",
            stepId,
            line: "Sandbox warning: provider not supported in docker mode.",
            ts: nowTs()
          });
        }

        if (options.config?.cluster?.enabled) {
          const queueRoot = resolveClusterRoot(runDir, options.config);
          events.emit({ t: "worker.spawned", runId: options.runId, stepId, ts: nowTs() });
          const task = buildTask({
            provider: spec.provider,
            model: spec.model,
            prompt: renderedPrompt,
            agentId: step.agent ?? "unknown",
            stepId,
            runId: options.runId
          });
          await enqueueTask(queueRoot, task);
          const result = await waitForResult(queueRoot, task.id);
          events.emit({ t: "worker.terminated", runId: options.runId, stepId, ts: nowTs() });
          if (!result.ok || !result.text) {
            throw new Error(result.error ?? "Cluster execution failed");
          }
          return {
            text: result.text,
            usage: normalizeUsage(result.usage ?? null),
            durationMs: result.durationMs ?? Date.now() - start
          };
        }

        const factory = getAgentFactory(spec.provider);
        if (!factory) {
          throw new Error(`Unsupported provider ${spec.provider}`);
        }
        const agentClient = factory({
          provider: spec.provider,
          model: spec.model,
          agentId: step.agent ?? "unknown",
          env
        });
        const result = await agentClient.complete(renderedPrompt);
        return {
          text: result.text,
          usage: normalizeUsage(result.usage ?? null),
          durationMs: Date.now() - start
        };
      };

      const arbitrationMode =
        workflow.arbitration?.mode ?? options.config?.arbitration?.mode ?? "score";
      const minModels =
        workflow.arbitration?.min_models ?? options.config?.arbitration?.min_models ?? 2;
      const shouldArbitrate =
        options.allowArbitration && providerSpecs.length >= minModels && providerSpecs.length > 1;

      if (shouldArbitrate) {
        const decision = await runArbitration({
          candidates: providerSpecs,
          prompt: renderedPrompt,
          step,
          workflow,
          policy: options.policy,
          config: options.config,
          mode: arbitrationMode,
          execute: (spec) => options.agentSemaphore.use(() => executeProvider(spec)),
          checkPatch: (diff) => checkPatchApplies(repoPath, diff),
          modelBias: options.modelBias
        });

        outputText = decision.winner.outputText;
        usage = decision.winner.usage;
        costUsd = decision.winner.costUsd;
        status.provider = decision.winner.spec.provider;
        status.model = decision.winner.spec.model;

        const arbitrationDir = path.join(stepDir, "arbitration");
        await ensureDir(arbitrationDir);
        const payload = {
          mode: decision.mode,
          winner: {
            provider: decision.winner.spec.provider,
            model: decision.winner.spec.model,
            score: decision.winner.score
          },
          candidates: decision.candidates.map((c) => ({
            provider: c.spec.provider,
            model: c.spec.model,
            score: c.score,
            durationMs: c.durationMs,
            valid: c.valid,
            policyOk: c.policyOk,
            patchOk: c.patchOk,
            testScore: c.testScore,
            tokenScore: c.tokenScore,
            usage: c.usage,
            costUsd: c.costUsd,
            outputFile: `${c.spec.id}.md`
          }))
        };
        await writeJson(path.join(stepDir, "arbitration.json"), payload);
        for (const candidate of decision.candidates) {
          await writeText(path.join(arbitrationDir, `${candidate.spec.id}.md`), candidate.outputText);
        }
        events.emit({
          t: "arbitration.completed",
          runId: options.runId,
          stepId,
          winner: decision.winner.spec.model,
          provider: decision.winner.spec.provider,
          ts: nowTs()
        });
      } else {
        const chosen = providerSpecs[0]!;
        const result = await options.agentSemaphore.use(() => executeProvider(chosen));
        outputText = result.text;
        usage = normalizeUsage(result.usage ?? null);
        status.provider = chosen.provider;
        status.model = chosen.model;
      }
    } else {
      outputText = renderedPrompt;
    }

    if (usage) {
      await writeJson(path.join(stepDir, "usage.json"), usage);
      status.usage = usage;
    }
    const modelForCost = status.model ?? agentConfig?.model ?? null;
    if (modelForCost) {
      const pricing = resolvePricing(options.config, modelForCost);
      costUsd = estimateCostUsd(usage, pricing);
      if (typeof costUsd === "number") {
        status.costUsd = costUsd;
      }
    }

    await writeText(path.join(stepDir, "output.md"), outputText);

    if (stepId === options.auditStepId || step.type === "red_team") {
      const parsed = extractJsonBlock(outputText);
      if (!parsed || typeof parsed !== "object") {
        status.ok = false;
        status.error = step.type === "red_team" ? "Red-team output is not valid JSON" : "Audit output is not valid JSON";
      } else {
        outputJson = parsed;
        const jsonPath = path.join(stepDir, "output.json");
        await writeJson(jsonPath, parsed);
        if (typeof (parsed as any).blocking === "boolean") {
          blocking = (parsed as any).blocking;
        }
      }
    }

    if (step.outputs && step.outputs.length > 0) {
      for (const outputName of step.outputs) {
        const targetPath = resolveSafePath(stepDir, outputName);
        if (outputName.endsWith(".json") && outputJson) {
          await writeJson(targetPath, outputJson);
        } else {
          await writeText(targetPath, outputText);
        }
      }
    }

    const behaviorData = extractBehavior(outputJson, outputText);
    if (behaviorData) {
      behavior = behaviorData;
      status.behavior = behaviorData;
      await writeJson(path.join(stepDir, "behavior.json"), behaviorData);
    }

    if (isCancelled(runDir)) {
      throw new CancelledError();
    }

    const isTestGeneration = step.type === "test_generation";
    const shouldApplyPatch = step.apply_patch || isTestGeneration;

    if (shouldApplyPatch) {
      const diff = extractDiffBlock(outputText);
      if (!diff) {
        throw new Error("No diff block found in output.");
      }
      if (isTestGeneration && !diffTargetsGeneratedTests(diff)) {
        throw new Error("Test generation diff must target __orchestrum_generated_tests__/");
      }
      assertFilesystemPermission(capability, stepId);
      assertDiffPathSafety(diff);
      await requireApprovalIfNeeded({
        runDir,
        stepId,
        runId: options.runId,
        findings: scanDiff(diff),
        events,
        repoPath,
        kind: "diff"
      });
      if (isTestGeneration) {
        await fs.mkdir(path.join(repoPath, "__orchestrum_generated_tests__"), { recursive: true });
      }
      await applyPatch(repoPath, diff);
      const violation = await checkPatchPolicy(repoPath, options.policy);
      if (violation) {
        events.emit({ t: "policy.violation", runId: options.runId, stepId, reason: violation, ts: nowTs() });
        throw new Error(violation);
      }
      const currentDiff = await gitDiff(repoPath);
      gitDiffPath = path.join(stepDir, "git.diff");
      await writeText(gitDiffPath, currentDiff);
      const changedFiles = await gitChangedFiles(repoPath).catch(() => [] as string[]);
      const risk = computeRiskScore({
        changedFiles,
        diffText: currentDiff,
        securityPaths: options.policy?.forbidden_paths
      });
      riskScore = risk.score;
      status.riskScore = risk.score;
      if (options.branch) {
        status.commitSha = await commitAll(repoPath, `orchestrum: step ${stepId}`);
      }
    }

    if (step.type === "red_team") {
      const vulnerability = extractVulnerabilityScore(outputJson ?? extractJsonBlock(outputText), outputText);
      if (typeof vulnerability === "number") {
        riskScore = vulnerability;
        status.riskScore = vulnerability;
        const threshold = options.securityThreshold ?? 0.7;
        if (vulnerability >= threshold) {
          status.ok = false;
          status.error = `Security alert: vulnerability score ${vulnerability.toFixed(2)}`;
          events.emit({
            t: "security.alert",
            stepId,
            score: vulnerability,
            threshold,
            ts: nowTs()
          });
        }
      }
    }

    const commands = step.run && step.run.length > 0
      ? step.run
      : isTestGeneration
        ? ["npm test"]
        : [];

    if (commands.length > 0) {
      assertShellPermission(capability, commands, options.config?.shell_allowlist);
      await requireApprovalIfNeeded({
        runDir,
        stepId,
        runId: options.runId,
        findings: scanCommands(commands),
        events,
        repoPath,
        kind: "command"
      });
      const logPath = path.join(stepDir, "commands.log");
      commandsLogPath = logPath;
      if (!fsSync.existsSync(logPath)) {
        await writeText(logPath, "");
      }
      const results = await runCommands({
        commands,
        cwd: repoPath,
        logFile: logPath,
        onLine: (line) => {
          events.emit({ t: "step.log", stepId, line, ts: nowTs() });
        }
      });
      const firstFailure = results.find((r) => !r.ok);
      if (firstFailure) {
        status.ok = false;
        status.error = status.error ?? "One or more commands failed";
      }
    }
  } catch (err) {
    status.ok = false;
    status.error = formatError(err);
    if (err instanceof CancelledError) {
      throw err;
    }
  }

  status.end = nowIso();
  await writeJson(path.join(stepDir, "status.json"), status);

  if (!status.ok) {
    events.emit({ t: "step.failed", stepId, error: status.error, ts: nowTs() });
  }
  events.emit({ t: "step.finished", stepId, ok: status.ok, ts: nowTs() });
  if (step.agent) {
    events.emit({ t: "agent.status", agentId: step.agent, status: status.ok ? "idle" : "failed", detail: stepId, ts: nowTs() });
  }

  await runPluginHook(options.plugins, "onStepFinish", {
    stepId,
    status: status.ok ? "completed" : "failed",
    agentId: step.agent ?? null,
    ok: status.ok,
    error: status.error,
    cached: status.cached,
    commitSha: status.commitSha,
    provider: status.provider ?? null,
    model: status.model ?? null,
    usage,
    costUsd,
    riskScore: status.riskScore ?? null,
    behavior: status.behavior ?? null
  });

  return {
    ok: status.ok,
    outputText,
    outputJson,
    blocking,
    commandsLogPath,
    cached: status.cached,
    commitSha: status.commitSha,
    gitDiffPath,
    usage,
    costUsd,
    agentId: step.agent ?? null,
    stepType: step.type ?? null,
    riskScore,
    behavior,
    provider: status.provider ?? null,
    model: status.model ?? null
  };
}

async function resolveInputs(options: {
  step: StepDefinition;
  workflow: Workflow;
  repoPath: string;
  runDir: string;
  goal: string;
  specText?: string;
  lastGitDiffPath: string | null;
  lastCommandsLogPath: string | null;
  repoIndex: RepoIndex;
  memorySummaries: string[];
}): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {};
  const list = options.step.inputs ?? [];

  for (const input of list) {
    if (input === "user_goal") {
      inputs[input] = options.goal || "(no goal provided)";
      continue;
    }

    if (input === "repo_context") {
      const mode = options.step.agent === "pm" ? "pm" : "dev";
      inputs[input] = await buildRepoContext({
        repoPath: options.repoPath,
        mode,
        goal: options.goal,
        specText: options.specText,
        index: options.repoIndex,
        memorySummaries: options.memorySummaries
      });
      continue;
    }

    if (input === "git.diff") {
      if (options.lastGitDiffPath) {
        inputs[input] = (await readTextIfExists(options.lastGitDiffPath)) ?? "";
      } else {
        inputs[input] = await gitDiff(options.repoPath).catch(() => "(git diff unavailable)");
      }
      continue;
    }

    if (input === "commands.log") {
      if (options.lastCommandsLogPath) {
        inputs[input] = (await readTextIfExists(options.lastCommandsLogPath)) ?? "";
      } else {
        inputs[input] = "(no commands log available yet)";
      }
      continue;
    }

    const stepMatch = input.match(/^([A-Za-z0-9_.-]+)\.(md|json|txt)$/);
    if (stepMatch) {
      const stepId = stepMatch[1];
      if (!stepId) {
        continue;
      }
      const ext = stepMatch[2];
      if (!ext) {
        continue;
      }
      const artifact = path.join(options.runDir, "steps", stepId, `output.${ext}`);
      const content = await readTextIfExists(artifact);
      inputs[input] = content ?? `(missing artifact: ${artifact})`;
      continue;
    }

    const direct = resolveSafePath(options.runDir, input);
    const content = await readTextIfExists(direct);
    inputs[input] = content ?? `(missing artifact: ${direct})`;
  }

  return inputs;
}

function renderPrompt(template: string, inputs: Record<string, string>): string {
  const inputKeys = Object.keys(inputs);
  if (inputKeys.length === 0) {
    return template.trim();
  }

  const sections = inputKeys
    .map((key) => `## ${key}\n${inputs[key]}`)
    .join("\n\n");

  return `${template.trim()}\n\n# Inputs\n${sections}`.trim();
}

function applyConfig(workflow: Workflow, config: Awaited<ReturnType<typeof loadConfig>>): Workflow {
  if (!config) return workflow;
  const merged = { ...workflow, agents: { ...workflow.agents } } as Workflow;

  if (config.models) {
    for (const [agentId, model] of Object.entries(config.models)) {
      if (merged.agents[agentId]) {
        merged.agents[agentId] = { ...merged.agents[agentId], model };
      }
    }
  }

  if (config.concurrency) {
    const max = resolveConcurrency(config);
    if (max) {
      merged.concurrency = { max_agents: max };
    }
  }

  return merged;
}

function toConfigOverrides(overrides?: RunConfigOverrides): Partial<OrchestrumConfig> | undefined {
  if (!overrides) return undefined;
  const result: Partial<OrchestrumConfig> = {};
  if (typeof overrides.concurrency === "number" && Number.isFinite(overrides.concurrency) && overrides.concurrency > 0) {
    result.concurrency = { max_agents: Math.max(1, Math.floor(overrides.concurrency)) };
  }
  if (typeof overrides.sandboxEnabled === "boolean") {
    result.sandbox = { enabled: overrides.sandboxEnabled };
  }
  if (overrides.modelOverrides && Object.keys(overrides.modelOverrides).length > 0) {
    result.models = { ...overrides.modelOverrides };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function estimateTotalSteps(workflow: Workflow): number {
  const blocks = buildStepBlocks(workflow);
  const filtered = flattenBlocks(blocks).filter((step) => {
    if (step.definition.type === "test_generation" && !workflow.enable_auto_tests) {
      return false;
    }
    return true;
  });
  const base = filtered.length;
  if (!workflow.loop) return base;
  const loopSteps = [workflow.loop.audit_step_id ?? "audit", workflow.loop.fix_step_id ?? "fix"].filter(Boolean).length;
  const rounds = workflow.loop.max_rounds ?? 1;
  const perStepLimit = workflow.loop.max_loop_per_step ?? rounds;
  const maxRounds = Math.min(rounds, perStepLimit);
  const extra = Math.max(0, maxRounds - 1) * loopSteps;
  return base + extra;
}

function emitProgress(events: EventWriter, runId: string, done: number, total: number) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const remaining = Math.max(0, total - done);
  events.emit({ t: "run.progress", runId, done, total, percent, remaining, ts: nowTs() });
}

function isCancelled(runDir: string): boolean {
  return fsSync.existsSync(path.join(runDir, "cancelled"));
}

async function loadCompletedSteps(runDir: string): Promise<Set<string>> {
  const stepsDir = path.join(runDir, "steps");
  const entries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  const completed = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(stepsDir, entry.name, "status.json");
    const raw = await readTextIfExists(statusPath);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as { ok?: boolean };
      if (data.ok) {
        completed.add(entry.name);
      }
    } catch {
      // ignore
    }
  }
  return completed;
}

async function findLatestArtifact(
  runDir: string,
  stepIds: string[],
  completed: Set<string>,
  filename: string
): Promise<string | null> {
  for (let i = stepIds.length - 1; i >= 0; i -= 1) {
    const stepId = stepIds[i];
    if (!stepId) continue;
    if (!completed.has(stepId)) continue;
    const candidate = path.join(runDir, "steps", stepId, filename);
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function loadGoalFromRun(runDir: string, workflow: Workflow): Promise<string | null> {
  const stepIds: string[] = [];
  for (const step of workflow.steps) {
    if (step.parallel && step.substeps) {
      for (const sub of step.substeps) {
        if (sub.inputs?.includes("user_goal")) {
          stepIds.push(`${step.id}.${sub.id}`);
        }
      }
      continue;
    }
    if (step.inputs?.includes("user_goal")) {
      stepIds.push(step.id);
    }
  }

  for (const stepId of stepIds) {
    const inputPath = path.join(runDir, "steps", stepId, "input.json");
    const raw = await readTextIfExists(inputPath);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as { inputs?: Record<string, string> };
      const goal = data.inputs?.user_goal;
      if (goal && typeof goal === "string") {
        return goal;
      }
    } catch {
      // ignore malformed input
    }
  }

  return null;
}

function safeParseOk(raw: string): boolean {
  try {
    const data = JSON.parse(raw) as { ok?: boolean };
    return !!data.ok;
  } catch {
    return false;
  }
}

function resolveSandboxConfig(
  cliSandbox: "docker" | undefined,
  config: Awaited<ReturnType<typeof loadConfig>> | null,
  advancedAllowed: boolean
): SandboxConfig | null {
  const enabled = cliSandbox === "docker" || config?.sandbox?.enabled;
  if (!enabled) return null;
  return {
    enabled: true,
    image: config?.sandbox?.image ?? "node:20-alpine",
    network: advancedAllowed ? (config?.sandbox?.network ?? false) : false,
    user: config?.sandbox?.user ?? "node",
    cpu_limit: advancedAllowed ? config?.sandbox?.cpu_limit : undefined,
    memory_limit_mb: advancedAllowed ? config?.sandbox?.memory_limit_mb : undefined
  };
}

async function resolveRunDir(
  runsDir: string,
  runId: string,
  workspaceId?: string
): Promise<{ runDir: string; workspaceId?: string }> {
  const legacy = path.join(runsDir, runId);
  if (workspaceId) {
    const candidate = path.join(runsDir, workspaceId, runId);
    if (fsSync.existsSync(candidate)) {
      return { runDir: candidate, workspaceId };
    }
    if (fsSync.existsSync(legacy)) {
      return { runDir: legacy, workspaceId: "legacy" };
    }
    throw new Error(`Run ${runId} not found in workspace ${workspaceId}`);
  }

  if (fsSync.existsSync(legacy)) {
    return { runDir: legacy, workspaceId: "legacy" };
  }

  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name, runId);
    if (fsSync.existsSync(candidate)) {
      return { runDir: candidate, workspaceId: entry.name };
    }
  }

  throw new Error(`Run ${runId} not found`);
}

function resolveAgentRole(agentId: string | null, agentConfig?: { role?: string } | null): string | null {
  if (agentConfig?.role) return agentConfig.role;
  if (!agentId) return null;
  const normalized = agentId.toLowerCase();
  if (normalized === "pm" || normalized === "dev" || normalized === "audit") {
    return normalized;
  }
  return agentConfig?.role ?? null;
}

function pickBestStrategy(weights?: Record<string, number> | null): string | null {
  if (!weights) return null;
  let best: { mode: string; weight: number } | null = null;
  for (const [mode, weight] of Object.entries(weights)) {
    if (!best || weight > best.weight) {
      best = { mode, weight };
    }
  }
  return best?.mode ?? null;
}

function diffTargetsGeneratedTests(diff: string): boolean {
  const lines = diff.split(/\r?\n/);
  let hasPath = false;
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const parts = line.split(/\s+/);
      const rawPath = parts[1] ?? "";
      if (rawPath === "/dev/null") continue;
      const cleaned = rawPath.replace(/^a\//, "").replace(/^b\//, "");
      if (cleaned.length === 0) continue;
      hasPath = true;
      if (!cleaned.startsWith("__orchestrum_generated_tests__/")) {
        return false;
      }
    }
  }
  return hasPath;
}

function hasArbitrationConfigured(workflow: Workflow): boolean {
  if (workflow.arbitration) return true;
  for (const agent of Object.values(workflow.agents)) {
    if (agent.providers && agent.providers.length > 1) return true;
  }
  for (const step of workflow.steps) {
    if (step.providers && step.providers.length > 1) return true;
    if (step.substeps) {
      for (const sub of step.substeps) {
        if (sub.providers && sub.providers.length > 1) return true;
      }
    }
  }
  return false;
}

type Capability = {
  filesystem: "read" | "read_write";
  network: boolean;
  shell: "false" | "limited" | "true";
};

function resolveCapabilities(workflow: Workflow, agentId: string | null, agentRole: string | null): Capability {
  const defaults: Record<string, Capability> = {
    pm: { filesystem: "read", network: false, shell: "false" },
    audit: { filesystem: "read", network: false, shell: "false" },
    dev: { filesystem: "read_write", network: false, shell: "limited" }
  };
  const cap =
    (agentId && workflow.capabilities?.[agentId]) ||
    (agentRole && workflow.capabilities?.[agentRole]) ||
    defaults[agentRole ?? ""] ||
    { filesystem: "read", network: false, shell: "false" };
  const shell =
    typeof cap.shell === "boolean"
      ? (cap.shell ? "true" : "false")
      : cap.shell === "none"
        ? "false"
        : cap.shell === "full"
          ? "true"
          : cap.shell ?? "false";
  return {
    filesystem: cap.filesystem ?? "read",
    network: cap.network ?? false,
    shell
  };
}

function assertFilesystemPermission(capability: Capability, stepId: string) {
  if (capability.filesystem !== "read_write") {
    throw new Error(`Filesystem write not permitted for step ${stepId}.`);
  }
}

function assertShellPermission(capability: Capability, commands: string[], allowlist?: string[]) {
  if (capability.shell === "false") {
    throw new Error("Shell execution not permitted by capability policy.");
  }
  if (capability.shell === "limited") {
    for (const cmd of commands) {
      if (!isAllowedLimitedCommand(cmd, allowlist)) {
        throw new Error(`Command not allowed in limited shell mode: ${cmd}`);
      }
      if (!capability.network && commandUsesNetwork(cmd)) {
        throw new Error(`Network access not permitted for command: ${cmd}`);
      }
    }
  }
  if (!capability.network) {
    for (const cmd of commands) {
      if (commandUsesNetwork(cmd)) {
        throw new Error(`Network access not permitted for command: ${cmd}`);
      }
    }
  }
}

function isAllowedLimitedCommand(cmd: string, allowlist?: string[]): boolean {
  const trimmed = cmd.trim();
  const defaultPrefixes = [
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run build",
    "pnpm test",
    "pnpm run test",
    "pnpm run lint",
    "yarn test",
    "yarn lint",
    "npx",
    "tsc",
    "node",
    "python",
    "python3",
    "pytest",
    "go test",
    "git status",
    "git diff",
    "make",
    "cargo"
  ];
  const prefixes = allowlist && allowlist.length > 0 ? allowlist : defaultPrefixes;
  return prefixes.some((prefix) => trimmed.startsWith(prefix));
}

function commandUsesNetwork(cmd: string): boolean {
  return /(https?:\/\/|curl\b|wget\b|npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|go\s+get)/i.test(cmd);
}

function assertDiffPathSafety(diff: string) {
  const files = extractDiffFiles(diff);
  for (const file of files) {
    if (path.isAbsolute(file) || file.includes("..") || /^[A-Za-z]:\\\\/.test(file)) {
      throw new Error(`Unsafe diff path detected: ${file}`);
    }
  }
}

function resolveSafePath(baseDir: string, relativePath: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(baseDir, relativePath);
  if (!target.startsWith(base)) {
    throw new Error("Unsafe path detected.");
  }
  return target;
}

function extractDiffFiles(diffText: string): string[] {
  const files = new Set<string>();
  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const parts = line.split(/\s+/);
      const raw = parts[1];
      if (!raw || raw === "/dev/null") continue;
      const cleaned = raw.replace(/^a\//, "").replace(/^b\//, "");
      files.add(cleaned);
    }
  }
  return Array.from(files);
}

async function requireApprovalIfNeeded(options: {
  runDir: string;
  stepId: string;
  runId: string;
  findings: ReturnType<typeof scanDiff> | ReturnType<typeof scanCommands>;
  events: EventWriter;
  repoPath: string;
  kind: "diff" | "command";
}) {
  if (!options.findings || options.findings.length === 0) return;
  if (!requiresApproval(options.findings)) return;
  const workspaceApproved = await isWorkspaceApproved(options.repoPath, options.stepId, options.kind);
  if (workspaceApproved) return;
  const approvalsDir = path.join(options.runDir, "approvals");
  await ensureDir(approvalsDir);
  const approvedPath = path.join(approvalsDir, `${options.stepId}.approved`);
  if (fsSync.existsSync(approvedPath)) {
    return;
  }
  const reason = summarizeFindings(options.findings);
  const token = createApprovalToken();
  const approvalPayload = {
    token,
    stepId: options.stepId,
    runId: options.runId,
    kind: options.kind,
    ts: nowIso(),
    findings: options.findings,
    reason
  };
  await writeApprovalRequest(options.runDir, approvalPayload);
  options.events.emit({
    t: "approval.required",
    runId: options.runId,
    stepId: options.stepId,
    reason,
    token,
    ts: nowTs()
  });
  throw new Error(`Approval required. Token: ${token}`);
}

function buildAgentEnv(config: Awaited<ReturnType<typeof loadConfig>> | null): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (config?.local_llm?.endpoint) {
    env.ORCHESTRUM_LOCAL_LLM_ENDPOINT = config.local_llm.endpoint;
  }
  return env;
}

function resolveProviderSpecs(
  step: StepDefinition,
  agentConfig: { provider?: string; model?: string; providers?: string[] },
  config: Awaited<ReturnType<typeof loadConfig>> | null
): ProviderSpec[] {
  const providers = step.providers ?? agentConfig.providers ?? null;
  const list = providers && providers.length > 0
    ? providers
    : agentConfig.provider && agentConfig.model
      ? [`${agentConfig.provider}:${agentConfig.model}`]
      : [];
  const specs: ProviderSpec[] = [];
  for (const entry of list) {
    const parsed = parseProviderSpec(entry, config);
    if (parsed) specs.push(parsed);
  }
  return specs;
}

function parseProviderSpec(entry: string, config: Awaited<ReturnType<typeof loadConfig>> | null): ProviderSpec | null {
  const parts = entry.split(":");
  if (parts.length < 2) return null;
  let provider = parts[0];
  let model = parts.slice(1).join(":");
  if (provider === "local") {
    provider = parts[1] ?? (config?.local_llm?.provider ?? "ollama");
    model = parts.slice(2).join(":") || config?.local_llm?.model || "llama3";
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY && config?.local_llm) {
    provider = config.local_llm.provider;
    model = config.local_llm.model ?? model;
  }
  if (!provider || !model) return null;
  const id = `${provider}-${model}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return { id, provider, model };
}

function resolveClusterRoot(runDir: string, config: Awaited<ReturnType<typeof loadConfig>> | null): string {
  if (config?.cluster?.queue_dir) return path.resolve(config.cluster.queue_dir);
  const workspaceDir = path.dirname(runDir);
  return path.join(workspaceDir, ".cluster");
}

function mergePolicy(base: any | null, override: any | null) {
  if (!override) return base;
  return {
    ...(base ?? {}),
    ...(override ?? {})
  };
}

type DynamicAgentSpec = { id: string; role: string };

function extractDynamicAgents(outputJson?: unknown, outputText?: string): DynamicAgentSpec[] {
  let payload: any = outputJson;
  if (!payload && outputText) {
    const parsed = extractJsonBlock(outputText);
    if (parsed && typeof parsed === "object") {
      payload = parsed;
    }
  }
  if (!payload || typeof payload !== "object") return [];
  const agents = Array.isArray((payload as any).agents) ? (payload as any).agents : [];
  const result: DynamicAgentSpec[] = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object") continue;
    const id = String((agent as any).id ?? "");
    const role = String((agent as any).role ?? "");
    if (!id || !role) continue;
    result.push({ id, role });
  }
  return result;
}

function extractBehavior(outputJson?: unknown, outputText?: string): {
  reasoningSummary?: string | null;
  confidence?: number | null;
  decisionPath?: string[] | null;
} | null {
  let payload: any = outputJson;
  if (!payload && outputText) {
    const parsed = extractJsonBlock(outputText);
    if (parsed && typeof parsed === "object") {
      payload = parsed;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const reasoningSummary = typeof payload.reasoning_summary === "string" ? payload.reasoning_summary : null;
  const confidence = typeof payload.confidence === "number" ? payload.confidence : null;
  const decisionPath = Array.isArray(payload.decision_path) ? payload.decision_path.map(String) : null;
  if (!reasoningSummary && confidence == null && !decisionPath) {
    return null;
  }
  return { reasoningSummary, confidence, decisionPath };
}

async function registerDynamicAgents(options: {
  agents: DynamicAgentSpec[];
  workflow: Workflow;
  runMeta: RunState & { repoPath: string; workflow: string; branch?: string | null };
  runMetaPath: string;
  events: EventWriter;
  sourceStepId: string;
  sourceAgent: string | null;
}): Promise<DynamicAgentSpec[]> {
  const spawned: DynamicAgentSpec[] = [];
  for (const agent of options.agents) {
    if (options.workflow.agents[agent.id]) continue;
    const roleConfig = options.workflow.agents[agent.role];
    if (!roleConfig) continue;
    options.workflow.agents[agent.id] = { ...roleConfig, role: agent.role };
    const existing = options.runMeta.dynamicAgents ?? [];
    if (!existing.some((a) => a.id === agent.id)) {
      existing.push({ id: agent.id, role: agent.role });
    }
    options.runMeta.dynamicAgents = existing;
    options.events.emit({
      t: "agent.spawned",
      agentId: agent.id,
      role: agent.role,
      sourceStepId: options.sourceStepId,
      sourceAgent: options.sourceAgent,
      ts: nowTs()
    });
    spawned.push(agent);
  }
  if (spawned.length > 0) {
    await writeJson(options.runMetaPath, options.runMeta);
  }
  return spawned;
}

async function runDynamicAgentSteps(options: {
  agents: DynamicAgentSpec[];
  workflow: Workflow;
  repoPath: string;
  runDir: string;
  runId: string;
  events: EventWriter;
  agentSemaphore: Semaphore;
  parallelLimiter: Semaphore;
  repoIndex: RepoIndex;
  goal: string;
  specText?: string;
  lastGitDiffPath: string | null;
  lastCommandsLogPath: string | null;
  headSha: string;
  branch?: string;
  auditStepId: string;
  sandboxConfig?: SandboxConfig | null;
  policy: Awaited<ReturnType<typeof loadPolicy>> | null;
  config: Awaited<ReturnType<typeof loadConfig>> | null;
  plugins: OrchestrumPlugin[];
  memorySummaries: string[];
  modelBias?: Record<string, number>;
  allowArbitration: boolean;
}): Promise<Array<{ stepId: string; result: StepResult }>> {
  const tasks = options.agents.map((agent) =>
    options.parallelLimiter.use(async () => {
      const template = findTemplateStepForRole(options.workflow, agent.role);
      if (!template) {
        return null;
      }
      const stepId = `${template.id}.${agent.id}`;
      const result = await runStep({
        step: { ...template, agent: agent.id },
        stepId,
        runId: options.runId,
        workflow: options.workflow,
        repoPath: options.repoPath,
        runDir: options.runDir,
        events: options.events,
        agentSemaphore: options.agentSemaphore,
        repoIndex: options.repoIndex,
        goal: options.goal,
        specText: options.specText,
        lastGitDiffPath: options.lastGitDiffPath,
        lastCommandsLogPath: options.lastCommandsLogPath,
        headSha: options.headSha,
        branch: options.branch,
        auditStepId: options.auditStepId,
        bypassCache: false,
        sandboxConfig: options.sandboxConfig,
        policy: options.policy,
        config: options.config,
        plugins: options.plugins,
        memorySummaries: options.memorySummaries,
        securityThreshold: options.workflow.security?.threshold,
        modelBias: options.modelBias,
        allowArbitration: options.allowArbitration
      });
      if (!result.ok && !template.continue_on_error) {
        throw new Error(`Dynamic agent step failed: ${stepId}`);
      }
      return { stepId, result };
    })
  );

  const results = await Promise.all(tasks);
  return results.filter((r): r is { stepId: string; result: StepResult } => Boolean(r));
}

function findTemplateStepForRole(workflow: Workflow, role: string): StepDefinition | null {
  for (const step of workflow.steps) {
    if (step.parallel) continue;
    if (step.agent === role) {
      return step;
    }
  }
  return null;
}

async function appendRunSummary(runMeta: RunState & { repoPath?: string }, runDir: string): Promise<void> {
  const workspacePath = runMeta.workspacePath ?? runMeta.repoPath;
  if (!workspacePath) return;
  const stepsDir = path.join(runDir, "steps");
  const entries = await fs.readdir(stepsDir, { withFileTypes: true }).catch(() => []);
  const steps: Array<{ stepId: string; ok: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(stepsDir, entry.name, "status.json");
    const raw = await readTextIfExists(statusPath);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as { ok?: boolean };
      steps.push({ stepId: entry.name, ok: data.ok !== false });
    } catch {
      steps.push({ stepId: entry.name, ok: true });
    }
  }
  const summary = buildRunSummary(runMeta, steps);
  await appendSummary(workspacePath, summary);
}

async function applyPostRunEvolution(options: {
  runMeta: RunState & { repoPath?: string };
  runDir: string;
  workflow: Workflow;
  repoPath: string;
  strategyConfig: Awaited<ReturnType<typeof loadStrategy>> | null;
  strategyProfileMode: string;
  strategyState: Awaited<ReturnType<typeof loadStrategyState>>;
  events: EventWriter;
  memorySummaries: string[];
  config: Awaited<ReturnType<typeof loadConfig>> | null;
  analyticsAllowed: boolean;
  strategyEvolutionAllowed: boolean;
}): Promise<void> {
  const workspacePath = options.runMeta.workspacePath ?? options.repoPath;
  if (!workspacePath) return;

  const analysis = await analyzeRun({ runDir: options.runDir, runMeta: options.runMeta, workflow: options.workflow });
  options.runMeta.policyViolations = analysis.policyViolations;
  options.runMeta.auditFailures = analysis.auditFailures;
  options.runMeta.testFailures = analysis.testFailures;
  options.runMeta.securityAlerts = analysis.securityAlerts;
  const avgRisk = analysis.riskScores.length
    ? analysis.riskScores.reduce((acc, v) => acc + v, 0) / analysis.riskScores.length
    : 0;
  const maxRisk = analysis.riskScores.length ? Math.max(...analysis.riskScores) : 0;
  options.runMeta.riskSummary = { avgRisk, maxRisk };

  const reward = computeReward(analysis, options.runMeta, options.config);
  options.runMeta.reward = reward;
  const history = options.runMeta.rewardHistory ?? [];
  history.push({ ts: nowIso(), reward });
  options.runMeta.rewardHistory = history.slice(-50);
  options.events.emit({ t: "reward.calculated", runId: options.runMeta.runId, reward, ts: nowTs() });

  if (options.analyticsAllowed) {
    const { agentScores } = await updateAnalytics(workspacePath, analysis, options.runMeta);
    options.runMeta.agentScores = agentScores;
  }

  const promptResult = await updatePromptHistory({
    workflow: options.workflow,
    workspacePath,
    runMeta: options.runMeta,
    analysis
  });
  options.runMeta.promptEvolution = {
    suggestions: promptResult.suggestions,
    lastScore: promptResult.lastScore
  };
  options.events.emit({
    t: "prompt.evolution",
    runId: options.runMeta.runId,
    suggestions: promptResult.suggestions,
    score: promptResult.lastScore,
    ts: nowTs()
  });

  const suggestedMode = suggestStrategyMode(
    analysis,
    options.strategyConfig?.available_modes ?? [options.strategyProfileMode],
    options.strategyProfileMode
  );
  options.runMeta.strategy = {
    ...options.runMeta.strategy,
    suggestedMode,
    performanceScore: analysis.performanceScore
  };
  if (suggestedMode !== options.strategyProfileMode) {
    options.events.emit({
      t: "strategy.adjusted",
      runId: options.runMeta.runId,
      from: options.strategyProfileMode,
      to: suggestedMode,
      ts: nowTs()
    });
  }

  if (options.strategyEvolutionAllowed) {
    await updateStrategyState(workspacePath, analysis, options.strategyState);
    await updateAdaptationState({
      workspacePath,
      workflow: options.workflow,
      runMeta: options.runMeta,
      reward
    });
  }
  const changedFiles = await gitChangedFiles(options.repoPath).catch(() => [] as string[]);
  await updateKnowledgeGraph({
    workspacePath,
    runMeta: options.runMeta,
    workflow: options.workflow,
    analysis,
    changedFiles
  });
  await generateOpportunities({
    workspacePath,
    repoPath: options.repoPath,
    memorySummaries: options.memorySummaries
  });
}
