import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonIfExists, readTextIfExists, safeRunId, writeJson, writeText, appendLine } from "../runner/fs.js";
import { applyPatch, gitChangedFiles, gitDiff, gitDiffStat, PatchApplyError } from "../runner/git.js";
import { loadConfig } from "../runner/config.js";
import { estimateCostUsd, normalizeUsage, resolvePricing } from "../runner/cost.js";
import { appendLearnings, buildRunLearnings } from "../runner/learnings.js";
import { buildStepState, loadPlugins, runPluginHook, type OrchestrumPlugin } from "../runner/plugins.js";
import { createApprovalToken, isWorkspaceApproved, writeApprovalRequest } from "../runner/approvals.js";
import { loadRepoExecutionProfile, runValidationSuite } from "../runner/repoExecution.js";
import { appendWorkspaceSignal } from "../runner/signals.js";
import { appendWorkItemTrace } from "../runner/traces.js";
import type { RunRecoveryState, RunState, StepState } from "../runner/types.js";
import { applyDerivedSessionState } from "../delivery/sessionState.js";
import { createRemediationTasks, extractFindingsFromImport, resolvePacketCompletionStatus } from "../delivery/triage.js";
import { buildRemediationPacket } from "../delivery/workPackets.js";
import { createDefaultTeamPreset, type DeliverySessionState, type PacketExport, type PacketImport, type WorkPacket } from "../delivery/types.js";
import { getLicenseStatus, type LicenseTier } from "../licensing/index.js";
import { requiresApproval, scanDiff, summarizeFindings } from "../security/safety.js";
import { emitTelemetry, type TelemetryConfig } from "../telemetry/index.js";
import { completeWithProvider, normalizeMissionProvider } from "./providers.js";
import { loadMissionTemplate } from "./templates.js";
import type {
  MissionAgent,
  MissionApprovalGate,
  MissionGraph,
  MissionImportFinding,
  MissionInputRef,
  MissionNode,
  MissionRun,
  MissionRunResult,
  NodeArtifactRef,
  NodeExecutorResult
} from "./types.js";

type EventHandler = (event: Record<string, unknown>) => Promise<void> | void;

type StartMissionOptions = {
  templateId: string;
  repoPath: string;
  runsDir: string;
  goal: string;
  workspaceId?: string;
  runId?: string;
  agents: MissionAgent[];
  runOptions?: {
    concurrency?: number;
    modelOverrides?: Record<string, string>;
    effortOverrides?: Record<string, string>;
    strategyMode?: string;
  };
  traceContext?: {
    workItemId?: string;
    cycleId?: string | null;
    workstreamId?: string | null;
    taskId?: string | null;
    ownerAgentId?: string | null;
    ownerAgentName?: string | null;
    ownerRole?: string | null;
  };
  onEvent?: EventHandler;
};

type MissionRuntimeSignals = {
  plugins: OrchestrumPlugin[];
  telemetryConfig: TelemetryConfig | null | undefined;
  tier: LicenseTier;
  workspaceId: string;
  finalized: boolean;
  traceContext?: StartMissionOptions["traceContext"];
};

type ResumeMissionOptions = {
  runsDir: string;
  workspaceId?: string;
  runId: string;
  agents: MissionAgent[];
  onEvent?: EventHandler;
};

const MAX_GOAL_INPUT_CHARS = 12_000;
const MAX_REPO_CONTEXT_INPUT_CHARS = 12_000;
const MAX_ARTIFACT_INPUT_CHARS = 48_000;
const MAX_LITERAL_INPUT_CHARS = 8_000;
const MAX_GIT_DIFF_PROMPT_CHARS = 80_000;
const MAX_GIT_DIFF_STAT_CHARS = 4_000;
const MAX_CHANGED_FILES_IN_PROMPT = 40;
const MAX_GIT_DIFF_HEAD_CHARS = 48_000;
const MAX_GIT_DIFF_TAIL_CHARS = 16_000;
const MAX_AUDIT_REPO_CONTEXT_INPUT_CHARS = 2_500;
const MAX_AUDIT_GIT_DIFF_PROMPT_CHARS = 12_000;
const MAX_AUDIT_GIT_DIFF_STAT_CHARS = 1_200;
const MAX_AUDIT_CHANGED_FILES_IN_PROMPT = 24;
const MAX_AUDIT_GIT_DIFF_HEAD_CHARS = 3_500;
const MAX_AUDIT_GIT_DIFF_TAIL_CHARS = 1_500;
const MAX_COMPACT_REPO_CONTEXT_ENTRIES = 20;
const MAX_COMPACT_REPO_CONTEXT_FILES = 8;
const MAX_COMPACT_REPO_PACKAGE_JSON_CHARS = 900;
const MAX_COMPACT_REPO_README_CHARS = 700;
const MODULE_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".svg"];

type GitDiffPromptBudget = {
  maxChars: number;
  maxStatChars: number;
  maxChangedFiles: number;
  headChars: number;
  tailChars: number;
};

type PromptInputBudget = {
  goalChars: number;
  repoContextChars: number;
  repoContextMode: "default" | "compact";
  gitDiff: GitDiffPromptBudget;
};

const DEFAULT_GIT_DIFF_PROMPT_BUDGET: GitDiffPromptBudget = {
  maxChars: MAX_GIT_DIFF_PROMPT_CHARS,
  maxStatChars: MAX_GIT_DIFF_STAT_CHARS,
  maxChangedFiles: MAX_CHANGED_FILES_IN_PROMPT,
  headChars: MAX_GIT_DIFF_HEAD_CHARS,
  tailChars: MAX_GIT_DIFF_TAIL_CHARS
};

const AUDIT_GIT_DIFF_PROMPT_BUDGET: GitDiffPromptBudget = {
  maxChars: MAX_AUDIT_GIT_DIFF_PROMPT_CHARS,
  maxStatChars: MAX_AUDIT_GIT_DIFF_STAT_CHARS,
  maxChangedFiles: MAX_AUDIT_CHANGED_FILES_IN_PROMPT,
  headChars: MAX_AUDIT_GIT_DIFF_HEAD_CHARS,
  tailChars: MAX_AUDIT_GIT_DIFF_TAIL_CHARS
};

const DEFAULT_PROMPT_INPUT_BUDGET: PromptInputBudget = {
  goalChars: MAX_GOAL_INPUT_CHARS,
  repoContextChars: MAX_REPO_CONTEXT_INPUT_CHARS,
  repoContextMode: "default",
  gitDiff: DEFAULT_GIT_DIFF_PROMPT_BUDGET
};

const AUDIT_PROMPT_INPUT_BUDGET: PromptInputBudget = {
  goalChars: MAX_GOAL_INPUT_CHARS,
  repoContextChars: MAX_AUDIT_REPO_CONTEXT_INPUT_CHARS,
  repoContextMode: "compact",
  gitDiff: AUDIT_GIT_DIFF_PROMPT_BUDGET
};

type ImportMissionNodeInputOptions = {
  runsDir: string;
  workspaceId?: string;
  runId: string;
  nodeId: string;
  text: string;
  targetTool?: string;
  onEvent?: EventHandler;
};

export async function runMissionDetailed(options: StartMissionOptions): Promise<MissionRunResult> {
  const runId = safeRunId(options.runId ?? `mission-${Date.now()}`);
  const workspaceId = options.workspaceId ?? "default";
  const runDir = path.join(options.runsDir, workspaceId, runId);
  const template = loadMissionTemplate(options.templateId);
  const baseConfig = await loadConfig(options.repoPath).catch(() => null);
  const config = applyMissionStartOptions(baseConfig, options.runOptions);
  const license = await getLicenseStatus().catch(() => ({ tier: "Free" as const }));
  const plugins = await loadPlugins(options.repoPath, config).catch(() => []);
  const signals: MissionRuntimeSignals = {
    plugins,
    telemetryConfig: config?.telemetry ?? null,
    tier: license.tier,
    workspaceId,
    finalized: false,
    traceContext: options.traceContext
  };
  const profile = await loadRepoExecutionProfile(options.repoPath, config).catch(() => null);
  const roleModelOverrides = resolveMissionRoleModelOverrides(config, options.runOptions?.modelOverrides);
  const roleEffortOverrides = resolveMissionRoleEffortOverrides(config, options.runOptions?.effortOverrides);
  const graph = createMissionGraph(template, options.agents, options.goal, roleModelOverrides, roleEffortOverrides);
  const run: MissionRun = {
    schemaVersion: 2,
    runId,
    kind: "mission",
    status: "running",
    start: nowIso(),
    end: null,
    goal: options.goal,
    userGoal: options.goal,
    workspaceId,
    repoPath: options.repoPath,
    missionTemplateId: template.id,
    totalSteps: graph.nodes.length,
    completedSteps: 0,
    totalTokens: 0,
    totalCost: 0,
    graph,
    pauseReason: null,
    change: { status: "none" },
    validation: { status: "not_requested", commands: [], results: [] },
    verdict: "running",
    profile: profile ? { repo_execution: profile, execution_mode: config?.execution?.mode } : null,
    strategy: options.runOptions?.strategyMode ? { mode: options.runOptions.strategyMode } : undefined
  };

  await ensureDir(runDir);
  await ensureDir(path.join(runDir, "nodes"));
  await ensureDir(path.join(runDir, "logs"));
  await writeText(path.join(runDir, "events.ndjson"), "");
  await persistMissionRun(runDir, run);
  await runPluginHook(plugins, "onRunStart", buildMissionRunState(run), {
    repoPath: options.repoPath,
    workspaceId,
    entityId: runId
  });
  await emitTelemetry({
    t: "mission.run.started",
    ts: nowIso(),
    tier: license.tier,
    run_kind: "mission",
    run_status: run.status,
    workspace_id: workspaceId,
    template_id: template.id
  }, signals.telemetryConfig, { workspacePath: options.repoPath });
  await appendWorkspaceSignal(options.repoPath, {
    workspaceId,
    source: "mission",
    type: "mission.run.started",
    entityId: runId,
    status: run.status,
    summary: `Mission started from ${template.id}`,
    payload: {
      runId,
      templateId: template.id
    }
  });
  await emitMissionEvent(runDir, {
    t: "mission.started",
    runId,
    workspaceId,
    templateId: template.id,
    ts: Date.now()
  }, options.onEvent);

  return continueMissionRun({
    runDir,
    repoPath: options.repoPath,
    config,
    run,
    signals,
    onEvent: options.onEvent
  });
}

export async function resumeMissionRun(options: ResumeMissionOptions): Promise<MissionRunResult> {
  const runDir = path.join(options.runsDir, options.workspaceId ?? "default", safeRunId(options.runId));
  const run = await loadMissionRun(runDir);
  if (!run) {
    throw new Error(`Mission run not found: ${options.runId}`);
  }
  hydrateMissionAgents(run, options.agents);
  const config = await loadConfig(run.repoPath).catch(() => null);
  const license = await getLicenseStatus().catch(() => ({ tier: "Free" as const }));
  const plugins = await loadPlugins(run.repoPath, config).catch(() => []);
  const signals: MissionRuntimeSignals = {
    plugins,
    telemetryConfig: config?.telemetry ?? null,
    tier: license.tier,
    workspaceId: run.workspaceId ?? options.workspaceId ?? "default",
    finalized: false
  };
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return { ok: run.status === "completed", runId: run.runId, runDir, run };
  }
  if (run.status === "blocked") {
    const recovered = await attemptBlockedMissionRecovery({
      runDir,
      repoPath: run.repoPath,
      run
    });
    if (!recovered) {
      await persistMissionRun(runDir, run);
      return { ok: false, runId: run.runId, runDir, run };
    }
  }
  run.status = "running";
  run.end = null;
  run.pauseReason = null;
  run.verdict = "running";
  run.recovery = null;
  await persistMissionRun(runDir, run);
  await emitMissionEvent(runDir, {
    t: "mission.resumed",
    runId: run.runId,
    ts: Date.now()
  }, options.onEvent);
  return continueMissionRun({
    runDir,
    repoPath: run.repoPath,
    config,
    run,
    signals,
    onEvent: options.onEvent
  });
}

async function attemptBlockedMissionRecovery(options: {
  runDir: string;
  repoPath: string;
  run: MissionRun;
}): Promise<boolean> {
  const node = [...options.run.graph.nodes].reverse().find((entry) => entry.status === "blocked") ?? null;
  if (!node) {
    return false;
  }
  const nodeDir = getNodeDir(options.runDir, node.id);
  if (node.change?.status === "apply_failed") {
    const diffText = await loadRecoveryDiff(nodeDir);
    if (!diffText) {
      node.error = node.error ?? "Recovery diff is missing for the blocked step.";
      return false;
    }
    try {
      await applyPatch(options.repoPath, diffText);
      node.status = "completed";
      node.end = nowIso();
      node.error = null;
      node.pauseReason = null;
      node.change = {
        status: "applied",
        diffArtifact: node.change?.diffArtifact ?? "apply.patch",
        appliedAt: nowIso(),
        source: node.change?.source ?? "provider"
      };
      node.verdict = "ready_for_review";
      node.artifacts = upsertArtifacts(node.artifacts, [
        await writeArtifact(nodeDir, "post-apply.diff", await gitDiff(options.repoPath).catch(() => diffText), "text/x-diff")
      ]);
      recalculateRunProgress(options.run);
      updateRunTruth(options.run);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      node.status = "blocked";
      node.end = nowIso();
      node.error = message;
      node.change = {
        status: "apply_failed",
        diffArtifact: node.change?.diffArtifact ?? "apply.patch",
        applyError: message,
        source: node.change?.source ?? "provider"
      };
      node.verdict = "blocked";
      if (err instanceof PatchApplyError && err.artifacts) {
        node.artifacts = upsertArtifacts(node.artifacts, [
          await writeArtifact(nodeDir, "apply.patch", diffText, "text/x-diff"),
          await writeArtifact(nodeDir, "git-status.txt", await fs.readFile(err.artifacts.gitStatusPath, "utf8").catch(() => ""), "text/plain"),
          await writeArtifact(nodeDir, "conflicts.json", await fs.readFile(err.artifacts.conflictsPath, "utf8").catch(() => "{}"), "application/json"),
          await writeArtifact(nodeDir, "conflict-summary.md", await fs.readFile(err.artifacts.summaryPath, "utf8").catch(() => message), "text/markdown"),
          await writeArtifact(nodeDir, "recovery-guide.md", await fs.readFile(err.artifacts.recoveryGuidePath, "utf8").catch(() => message), "text/markdown")
        ]);
      }
      recalculateRunProgress(options.run);
      updateRunTruth(options.run);
      return false;
    }
  }
  if (node.executor === "validate") {
    node.status = "pending";
    node.end = undefined;
    node.error = null;
    node.pauseReason = null;
    node.verdict = "running";
    recalculateRunProgress(options.run);
    updateRunTruth(options.run);
    return true;
  }
  return false;
}

async function loadRecoveryDiff(nodeDir: string): Promise<string | null> {
  for (const candidate of ["pending.diff", "external_patch.diff", "git.diff", "apply.patch"]) {
    const content = await readTextIfExists(path.join(nodeDir, candidate));
    if (content?.trim()) {
      return content;
    }
  }
  return null;
}

export async function importMissionNodeInput(options: ImportMissionNodeInputOptions): Promise<MissionRun> {
  const runDir = path.join(options.runsDir, options.workspaceId ?? "default", safeRunId(options.runId));
  const run = await loadMissionRun(runDir);
  if (!run) throw new Error(`Mission run not found: ${options.runId}`);
  const node = run.graph.nodes.find((entry) => entry.id === options.nodeId);
  if (!node) throw new Error(`Mission node not found: ${options.nodeId}`);
  if (node.executor !== "delivery.wait") {
    throw new Error(`Node ${options.nodeId} does not accept handoff imports.`);
  }
  const nodeDir = getNodeDir(runDir, node.id);
  await ensureDir(nodeDir);

  const findings = parseMissionFindings(options.text);
  const explicitStatus = parseExplicitStatus(options.text);
  const summary = summarizeInput(options.text);
  const blocked = explicitStatus === "blocked";
  const diffText = extractDiffBlock(options.text);
  const artifacts = [
    await writeArtifact(nodeDir, "response.md", options.text),
    await writeArtifact(nodeDir, "response.json", JSON.stringify({
      importedAt: nowIso(),
      targetTool: options.targetTool ?? node.targetTool ?? null,
      status: explicitStatus ?? "completed",
      summary,
      findings
    }, null, 2), "application/json"),
    await writeArtifact(nodeDir, "findings.json", JSON.stringify(findings, null, 2), "application/json")
  ];
  if (diffText) {
    artifacts.push(await writeArtifact(nodeDir, "external_patch.diff", diffText, "text/x-diff"));
  }
  node.artifacts = upsertArtifacts(node.artifacts, artifacts);
  node.findingCount = findings.length;
  node.pauseReason = null;
  node.change = diffText
    ? { status: "generated", diffArtifact: "external_patch.diff", source: "external" }
    : { status: "none", source: "external" };
  node.status = blocked ? "blocked" : "completed";
  node.error = blocked ? summary || "Delivery import marked as blocked." : null;
  node.end = nowIso();
  node.verdict = blocked ? "blocked" : diffText ? "ready_for_review" : "needs_human_review";

  if (!blocked && diffText) {
    try {
      await applyPatch(run.repoPath, diffText);
      node.change = {
        status: "applied",
        diffArtifact: "external_patch.diff",
        appliedAt: nowIso(),
        source: "external"
      };
      node.artifacts = upsertArtifacts(node.artifacts, [
        await writeArtifact(nodeDir, "post-apply.diff", await gitDiff(run.repoPath).catch(() => diffText), "text/x-diff")
      ]);
      node.verdict = "ready_for_review";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      node.status = "blocked";
      node.error = message;
      node.change = {
        status: "apply_failed",
        diffArtifact: "external_patch.diff",
        applyError: message,
        source: "external"
      };
      node.verdict = "blocked";
      const applyArtifacts = [await writeArtifact(nodeDir, "apply-error.txt", message)];
      if (err instanceof PatchApplyError && err.artifacts) {
        applyArtifacts.push(
          await writeArtifact(nodeDir, "apply.patch", diffText, "text/x-diff"),
          await writeArtifact(nodeDir, "git-status.txt", await fs.readFile(err.artifacts.gitStatusPath, "utf8").catch(() => ""), "text/plain"),
          await writeArtifact(nodeDir, "conflicts.json", await fs.readFile(err.artifacts.conflictsPath, "utf8").catch(() => "{}"), "application/json"),
          await writeArtifact(nodeDir, "conflict-summary.md", await fs.readFile(err.artifacts.summaryPath, "utf8").catch(() => message), "text/markdown"),
          await writeArtifact(nodeDir, "recovery-guide.md", await fs.readFile(err.artifacts.recoveryGuidePath, "utf8").catch(() => message), "text/markdown")
        );
      }
      node.artifacts = upsertArtifacts(node.artifacts, applyArtifacts);
    }
  }
  await recordMissionDeliveryImport({
    runDir,
    run,
    node,
    rawText: options.text,
    targetTool: options.targetTool,
    findings,
    diffText,
    blocked: node.status === "blocked"
  });

  recalculateRunProgress(run);
  if (node.status === "blocked") {
    run.status = "blocked";
    run.end = nowIso();
  } else {
    run.status = "running";
    run.end = null;
  }
  updateRunTruth(run);
  await persistMissionRun(runDir, run);
  if (isTerminalMissionStatus(run.status)) {
    const config = await loadConfig(run.repoPath).catch(() => null);
    const license = await getLicenseStatus().catch(() => ({ tier: "Free" as const }));
    const plugins = await loadPlugins(run.repoPath, config).catch(() => []);
    await finalizeMissionSignals({
      runDir,
      repoPath: run.repoPath,
      run,
      signals: {
        plugins,
        telemetryConfig: config?.telemetry ?? null,
        tier: license.tier,
        workspaceId: run.workspaceId ?? options.workspaceId ?? "default",
        finalized: false
      }
    });
  }
  await emitMissionEvent(runDir, {
    t: "mission.node.imported",
    runId: run.runId,
    nodeId: node.id,
    blocked: node.status === "blocked",
    changeStatus: node.change?.status ?? null,
    findings: findings.length,
    ts: Date.now()
  }, options.onEvent);
  return run;
}

export async function loadMissionRun(runDir: string): Promise<MissionRun | null> {
  const run = await readJsonIfExists<MissionRun>(path.join(runDir, "run.json"));
  if (!run || run.kind !== "mission" || !run.graph) return null;
  return run;
}

export function missionGraphToStepStates(graph: MissionGraph) {
  return graph.nodes.map((node) => ({
    stepId: node.id,
    status: mapMissionNodeStatusToStepStatus(node.status),
    start: node.start,
    end: node.end,
    ok: node.status === "completed",
    error: node.error ?? null,
    agentId: node.assignedAgentId ?? null,
    provider: node.provider ?? null,
    model: node.model ?? null,
    pauseReason: node.pauseReason ?? null,
    change: node.change ?? null,
    validation: node.validation ?? null,
    verdict: node.verdict ?? null
  }));
}

async function continueMissionRun(options: {
  runDir: string;
  repoPath: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  run: MissionRun;
  signals: MissionRuntimeSignals;
  onEvent?: EventHandler;
}): Promise<MissionRunResult> {
  const concurrency = Math.max(1, resolveMissionConcurrency(options.config));
  let run = options.run;
  let paused = false;

  while (run.status === "running") {
    const readyNodes = run.graph.nodes.filter((node) =>
      node.status === "pending" &&
      node.dependsOn.every((dependency) => run.graph.nodes.find((candidate) => candidate.id === dependency)?.status === "completed")
    );

    if (readyNodes.length === 0) {
      const approvalNodes = run.graph.nodes.filter((node) =>
        node.status === "awaiting_approval" &&
        node.dependsOn.every((dependency) => run.graph.nodes.find((candidate) => candidate.id === dependency)?.status === "completed")
      );
      let approvalAdvanced = false;
      for (const node of approvalNodes.slice(0, concurrency)) {
        const beforeStatus = node.status;
        run = await executeMissionNode({
          runDir: options.runDir,
          repoPath: options.repoPath,
          config: options.config,
          run,
          nodeId: node.id,
          signals: options.signals,
          onEvent: options.onEvent
        });
        const afterStatus = run.graph.nodes.find((entry) => entry.id === node.id)?.status;
        if (afterStatus && afterStatus !== beforeStatus) {
          approvalAdvanced = true;
        }
        if (run.status !== "running") break;
      }
      if (approvalAdvanced) {
        continue;
      }

      const hasPausedNode = run.graph.nodes.some((node) => node.status === "waiting_input" || node.status === "awaiting_approval");
      const hasFailure = run.graph.nodes.some((node) => node.status === "failed");
      const hasBlocked = run.graph.nodes.some((node) => node.status === "blocked");
      const allComplete = run.graph.nodes.every((node) => node.status === "completed");
      if (allComplete) {
        run.status = "completed";
        run.end = nowIso();
      } else if (hasBlocked) {
        run.status = "blocked";
        run.end = nowIso();
        run.verdict = "blocked";
      } else if (hasFailure) {
        run.status = "failed";
        run.end = nowIso();
      } else if (hasPausedNode) {
        paused = true;
        run.status = "paused";
        run.pauseReason = firstPauseReason(run.graph.nodes);
        run.verdict = "needs_human_review";
      }
      break;
    }

    for (const node of readyNodes.slice(0, concurrency)) {
      run = await executeMissionNode({
        runDir: options.runDir,
        repoPath: options.repoPath,
        config: options.config,
        run,
        nodeId: node.id,
        signals: options.signals,
        onEvent: options.onEvent
      });
      if (run.status !== "running") break;
    }
  }

  recalculateRunProgress(run);
  updateRunTruth(run);
  await persistMissionRun(options.runDir, run);
  await emitMissionEvent(options.runDir, {
    t: "mission.state",
    runId: run.runId,
    status: run.status,
    paused,
    pauseReason: run.pauseReason ?? null,
    verdict: run.verdict ?? null,
    completedSteps: run.completedSteps ?? 0,
    totalSteps: run.totalSteps ?? 0,
    ts: Date.now()
  }, options.onEvent);
  await finalizeMissionSignals({
    runDir: options.runDir,
    repoPath: options.repoPath,
    run,
    signals: options.signals
  });

  return {
    ok: run.status === "completed",
    runId: run.runId,
    runDir: options.runDir,
    paused,
    run
  };
}

async function executeMissionNode(options: {
  runDir: string;
  repoPath: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  run: MissionRun;
  nodeId: string;
  signals: MissionRuntimeSignals;
  onEvent?: EventHandler;
}): Promise<MissionRun> {
  const node = options.run.graph.nodes.find((entry) => entry.id === options.nodeId);
  if (!node) return options.run;
  const nodeDir = getNodeDir(options.runDir, node.id);
  await ensureDir(nodeDir);

  if (node.status === "awaiting_approval") {
    return finalizeApprovedPatchNode(options.runDir, options.repoPath, options.run, node, options.onEvent);
  }

  if (node.executor === "delivery.wait") {
    node.status = "waiting_input";
    node.start = node.start ?? nowIso();
    node.end = undefined;
    node.pauseReason = "awaiting_input";
    node.verdict = "needs_human_review";
    await writeNodeStatus(nodeDir, node);
    await persistMissionRun(options.runDir, options.run);
    await emitMissionEvent(options.runDir, {
      t: "mission.node.paused",
      runId: options.run.runId,
      nodeId: node.id,
      pauseReason: "awaiting_input",
      ts: Date.now()
    }, options.onEvent);
    return options.run;
  }

  node.status = "running";
  node.start = nowIso();
  node.end = undefined;
  node.error = null;
  node.pauseReason = null;
  node.verdict = "running";
  await writeNodeStatus(nodeDir, node);
  await persistMissionRun(options.runDir, options.run);
  await emitMissionEvent(options.runDir, {
    t: "mission.node.started",
    runId: options.run.runId,
    nodeId: node.id,
    executor: node.executor,
    agentId: node.assignedAgentId,
    provider: node.provider,
    model: node.model,
    ts: Date.now()
  }, options.onEvent);
  await runPluginHook(options.signals.plugins, "onStepStart", buildMissionStepState(node), {
    repoPath: options.repoPath,
    workspaceId: options.run.workspaceId,
    entityId: node.id
  });

  try {
    const result = await runMissionNodeExecutor({
      runDir: options.runDir,
      repoPath: options.repoPath,
      config: options.config,
      run: options.run,
      node,
      traceContext: options.signals.traceContext
    });

    node.artifacts = upsertArtifacts(node.artifacts, result.artifacts ?? []);
    node.findingCount = result.findingCount;
    node.approval = result.approval ?? null;
    node.provider = result.provider ?? node.provider;
    node.transport = result.transport ?? node.transport;
    node.profileId = result.profileId ?? node.profileId;
    node.model = result.model ?? node.model;
    node.effort = result.effort ?? node.effort;
    node.authSource = result.authSource ?? node.authSource ?? null;
    node.exitCode = result.exitCode ?? node.exitCode ?? null;
    node.change = result.change ?? node.change ?? { status: "none" };
    node.validation = result.validation ?? node.validation ?? { status: "not_requested", commands: [], results: [] };
    node.verdict = result.verdict ?? node.verdict ?? "running";
    if (result.waitingForInput) {
      node.status = "waiting_input";
      node.end = undefined;
      node.pauseReason = result.pauseReason ?? "awaiting_input";
      node.verdict = "needs_human_review";
    } else if (result.approval) {
      node.status = "awaiting_approval";
      node.end = undefined;
      node.pauseReason = "awaiting_approval";
      node.change = node.change && node.change.status === "generated"
        ? { ...node.change, status: "needs_review" }
        : node.change;
      node.verdict = "needs_human_review";
    } else if (result.blocked) {
      node.status = "blocked";
      node.end = nowIso();
      node.error = result.failureMessage ?? "Blocking mission feedback received.";
      node.verdict = "blocked";
    } else if (result.failureMessage) {
      node.status = "failed";
      node.end = nowIso();
      node.error = result.failureMessage;
      node.verdict = "failed";
    } else {
      node.status = "completed";
      node.end = nowIso();
      node.verdict = result.verdict ?? "ready_for_review";
    }
  } catch (err) {
    node.status = "failed";
    node.end = nowIso();
    node.error = err instanceof Error ? err.message : String(err);
    node.verdict = "failed";
  }

  recalculateRunProgress(options.run);
  updateRunTruth(options.run);
  await writeNodeStatus(nodeDir, node);
  await persistMissionRun(options.runDir, options.run);
  await emitMissionEvent(options.runDir, {
    t: missionNodeEventType(node.status),
    runId: options.run.runId,
    nodeId: node.id,
    status: node.status,
    pauseReason: node.pauseReason ?? null,
    changeStatus: node.change?.status ?? null,
    validationStatus: node.validation?.status ?? null,
    error: node.error ?? null,
    ts: Date.now()
  }, options.onEvent);
  await runPluginHook(options.signals.plugins, "onStepFinish", buildMissionStepState(node), {
    repoPath: options.repoPath,
    workspaceId: options.run.workspaceId,
    entityId: node.id
  });
  return options.run;
}

async function runMissionNodeExecutor(options: {
  runDir: string;
  repoPath: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  run: MissionRun;
  node: MissionNode;
  traceContext?: StartMissionOptions["traceContext"];
}): Promise<NodeExecutorResult> {
  if (options.node.executor === "delivery.export") {
    return executeDeliveryExportNode(options);
  }

  if (options.node.executor === "validate") {
    return executeValidationNode(options.runDir, options.repoPath, options.run, options.node, options.config);
  }

  const prompt = await buildPromptForNode(options.runDir, options.repoPath, options.run, options.node);
  const providerSpec = normalizeMissionProvider(
    options.node.providerConfig ?? {
      vendor: options.node.provider ?? "openai",
      transport: options.node.transport ?? "api",
      profileId: options.node.profileId,
      modelOverride: options.node.model,
      effort: options.node.effort
    },
    options.node.role
  );
  const result = await completeWithProvider(providerSpec, prompt, process.env, {
    repoPath: options.repoPath,
    artifactDir: getNodeDir(options.runDir, options.node.id),
    role: options.node.role,
    executor: options.node.executor
  });
  const model = result.model;
  let estimatedCost: number | null = null;
  const usage = normalizeUsage(result.usage ?? null);
  if (usage) {
    options.run.totalTokens = (options.run.totalTokens ?? 0) + usage.total_tokens;
    const pricing = resolvePricing(options.config, model);
    const cost = estimateCostUsd(usage, pricing);
    if (typeof cost === "number") {
      options.run.totalCost = Number(((options.run.totalCost ?? 0) + cost).toFixed(6));
      estimatedCost = cost;
    }
    if (options.node.assignedAgentId) {
      const existing = options.run.costByAgent?.[options.node.assignedAgentId] ?? { tokens: 0, cost: 0 };
      options.run.costByAgent = {
        ...(options.run.costByAgent ?? {}),
        [options.node.assignedAgentId]: {
          tokens: existing.tokens + usage.total_tokens,
          cost: Number((existing.cost + (estimatedCost ?? 0)).toFixed(6))
        }
      };
    }
  }
  if (model?.trim()) {
    options.run.modelUsage = {
      ...(options.run.modelUsage ?? {}),
      [model]: (options.run.modelUsage?.[model] ?? 0) + 1
    };
  }
  const nodeDir = getNodeDir(options.runDir, options.node.id);
  await writeArtifact(nodeDir, "prompt.md", prompt, "text/markdown");
  await appendProviderTrace({
    repoPath: options.repoPath,
    workspaceId: options.run.workspaceId ?? "default",
    runId: options.run.runId,
    node: options.node,
    traceContext: options.traceContext,
    prompt,
    response: result.text,
    provider: result,
    usage,
    estimatedCost
  });

  if (options.node.executor === "audit") {
    return executeAuditNode(options.runDir, options.repoPath, options.node, result.text, result);
  }

  if (options.node.executor === "patch") {
    return executePatchNode(options.runDir, options.repoPath, options.run, options.node, result.text, result);
  }
  const artifact = await writeArtifact(getNodeDir(options.runDir, options.node.id), "output.md", result.text);
  return {
    outputText: result.text,
    artifacts: [artifact],
    provider: result.vendor,
    transport: result.transport,
    profileId: result.profileId,
    model: result.model,
    effort: result.effort,
    authSource: result.authSource,
    exitCode: result.exitCode,
    usage: result.usage ?? null,
    verdict: "ready_for_review"
  };
}

async function executeDeliveryExportNode(options: {
  runDir: string;
  repoPath: string;
  run: MissionRun;
  node: MissionNode;
}): Promise<NodeExecutorResult> {
  const nodeDir = getNodeDir(options.runDir, options.node.id);
  const packetText = await buildDeliveryPacket(options.runDir, options.repoPath, options.run, options.node);
  const packetJson = {
    runId: options.run.runId,
    nodeId: options.node.id,
    missionTemplateId: options.run.missionTemplateId,
    role: options.node.role,
    targetTool: options.node.targetTool ?? "claude",
    goal: options.run.goal ?? "",
    generatedAt: nowIso()
  };
  await recordMissionDeliveryExport({
    runDir: options.runDir,
    run: options.run,
    node: options.node,
    packetText,
    targetTool: options.node.targetTool ?? "claude"
  });
  return {
    outputText: packetText,
    artifacts: [
      await writeArtifact(nodeDir, "packet.md", packetText),
      await writeArtifact(nodeDir, "packet.json", JSON.stringify(packetJson, null, 2), "application/json")
    ],
    verdict: "needs_human_review"
  };
}

async function executeAuditNode(
  runDir: string,
  repoPath: string,
  node: MissionNode,
  outputText: string,
  execution: Awaited<ReturnType<typeof completeWithProvider>>
): Promise<NodeExecutorResult> {
  const nodeDir = getNodeDir(runDir, node.id);
  const parsed = await normalizeAuditOutput(repoPath, parseAuditOutput(outputText));
  const findingSummary = parsed.blocking ? summarizeAuditFindings(parsed) : null;
  const artifacts = [
    await writeArtifact(nodeDir, "output.md", outputText),
    await writeArtifact(nodeDir, "output.json", JSON.stringify(parsed, null, 2), "application/json")
  ];
  if (typeof parsed.suggested_fix === "string" && parsed.suggested_fix.trim()) {
    const diffText = extractDiffBlock(parsed.suggested_fix) ?? parsed.suggested_fix.trim();
    artifacts.push(await writeArtifact(nodeDir, "suggested_fix.diff", diffText, "text/x-diff"));
  }
  return {
    outputText,
    outputJson: parsed,
    blocked: Boolean(parsed.blocking),
    findingCount: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
    artifacts,
    provider: execution.vendor,
    transport: execution.transport,
    profileId: execution.profileId,
    model: execution.model,
    effort: execution.effort,
    authSource: execution.authSource,
    exitCode: execution.exitCode,
    usage: execution.usage ?? null,
    failureMessage: findingSummary
  };
}

async function executePatchNode(
  runDir: string,
  repoPath: string,
  run: MissionRun,
  node: MissionNode,
  outputText: string,
  execution: Awaited<ReturnType<typeof completeWithProvider>>
): Promise<NodeExecutorResult> {
  const nodeDir = getNodeDir(runDir, node.id);
  const diffText = execution.nativeWrite
    ? await gitDiff(repoPath).catch(() => "")
    : extractDiffBlock(outputText);
  if (!diffText) {
    throw new Error(`Node ${node.id} did not produce a unified diff.`);
  }
  const artifacts: NodeArtifactRef[] = [
    await writeArtifact(nodeDir, "output.md", outputText),
    await writeArtifact(nodeDir, "git.diff", diffText, "text/x-diff")
  ];
  const findings = scanDiff(diffText);
  const protectedPaths = findProtectedPaths(diffText, optionsRepoExecutionProtectedPaths(run));
  const alreadyApproved = node.approval?.status === "approved" || await isMissionNodeApproved(runDir, repoPath, node);
  if (node.approval?.status === "pending" && alreadyApproved) {
    node.approval.status = "approved";
  }
  if ((requiresApproval(findings) || protectedPaths.length > 0) && !alreadyApproved) {
    const token = createApprovalToken();
    const approval: MissionApprovalGate = {
      token,
      kind: "diff",
      reason: protectedPaths.length > 0
        ? `Protected paths changed: ${protectedPaths.join(", ")}`
        : summarizeFindings(findings),
      status: "pending"
    };
    if (execution.nativeWrite) {
      await writeText(path.join(nodeDir, "pending.native"), "true");
      await writeText(path.join(nodeDir, "pending.diff"), diffText);
    } else {
      await writeText(path.join(nodeDir, "pending.diff"), diffText);
    }
    await writeApprovalRequest(runDir, {
      token,
      runId: run.runId,
      stepId: node.id,
      kind: "diff",
      reason: approval.reason,
      findings,
      ts: nowIso()
    });
    return {
      outputText,
      diffText,
      approval,
      artifacts,
      provider: execution.vendor,
      transport: execution.transport,
      profileId: execution.profileId,
      model: execution.model,
      effort: execution.effort,
      authSource: execution.authSource,
      exitCode: execution.exitCode,
      usage: execution.usage ?? null,
      change: {
        status: "needs_review",
        diffArtifact: "git.diff",
        source: "provider"
      },
      verdict: "needs_human_review"
    };
  }

  if (!execution.nativeWrite) {
    try {
      await applyPatch(repoPath, diffText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      artifacts.push(await writeArtifact(nodeDir, "apply-error.txt", message));
      if (err instanceof PatchApplyError && err.artifacts) {
        artifacts.push(
          await writeArtifact(nodeDir, "apply.patch", diffText, "text/x-diff"),
          await writeArtifact(nodeDir, "git-status.txt", await fs.readFile(err.artifacts.gitStatusPath, "utf8").catch(() => ""), "text/plain"),
          await writeArtifact(nodeDir, "conflicts.json", await fs.readFile(err.artifacts.conflictsPath, "utf8").catch(() => "{}"), "application/json"),
          await writeArtifact(nodeDir, "conflict-summary.md", await fs.readFile(err.artifacts.summaryPath, "utf8").catch(() => message), "text/markdown"),
          await writeArtifact(nodeDir, "recovery-guide.md", await fs.readFile(err.artifacts.recoveryGuidePath, "utf8").catch(() => message), "text/markdown")
        );
      }
      return {
        outputText,
        diffText,
        artifacts,
        provider: execution.vendor,
        transport: execution.transport,
        profileId: execution.profileId,
        model: execution.model,
        effort: execution.effort,
        authSource: execution.authSource,
        exitCode: execution.exitCode,
        usage: execution.usage ?? null,
        change: {
          status: "apply_failed",
          diffArtifact: "git.diff",
          applyError: message,
          source: "provider"
        },
        blocked: true,
        verdict: "blocked",
        failureMessage: message
      };
    }
  }
  const currentDiff = await gitDiff(repoPath).catch(() => diffText);
  artifacts.push(await writeArtifact(nodeDir, "post-apply.diff", currentDiff, "text/x-diff"));
  return {
    outputText,
    diffText,
    artifacts,
    provider: execution.vendor,
    transport: execution.transport,
    profileId: execution.profileId,
    model: execution.model,
    effort: execution.effort,
    authSource: execution.authSource,
    exitCode: execution.exitCode,
    usage: execution.usage ?? null,
    change: {
      status: "applied",
      diffArtifact: "git.diff",
      appliedAt: nowIso(),
      source: "provider"
    },
    verdict: "ready_for_review"
  };
}

async function executeValidationNode(
  runDir: string,
  repoPath: string,
  run: MissionRun,
  node: MissionNode,
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<NodeExecutorResult> {
  const nodeDir = getNodeDir(runDir, node.id);
  const validation = await runValidationSuite({
    repoPath,
    stepDir: nodeDir,
    config
  });
  const artifacts: NodeArtifactRef[] = [
    {
      name: "validation/summary.json",
      path: "validation/summary.json",
      mimeType: "application/json"
    }
  ];
  syncPatchValidationState(run, node, validation);
  if (validation.status === "unavailable") {
    return {
      artifacts,
      validation,
      blocked: true,
      verdict: "blocked",
      failureMessage: validation.summary ?? "Validation is unavailable."
    };
  }
  if (validation.status === "failed") {
    return {
      artifacts,
      validation,
      blocked: true,
      verdict: "blocked",
      failureMessage: validation.summary ?? "Validation failed."
    };
  }
  return {
    artifacts,
    validation,
    verdict: "ready_to_merge"
  };
}

async function finalizeApprovedPatchNode(
  runDir: string,
  repoPath: string,
  run: MissionRun,
  node: MissionNode,
  onEvent?: EventHandler
): Promise<MissionRun> {
  const approved = await isMissionNodeApproved(runDir, repoPath, node);
  if (!approved) {
    await writeNodeStatus(getNodeDir(runDir, node.id), node);
    return run;
  }
  const nodeDir = getNodeDir(runDir, node.id);
  const diffText = await readTextIfExists(path.join(nodeDir, "pending.diff"));
  if (!diffText) {
    node.status = "failed";
    node.error = "Pending diff missing for approved node.";
    node.end = nowIso();
    await writeNodeStatus(nodeDir, node);
    await persistMissionRun(runDir, run);
    return run;
  }
  const nativePending = Boolean(await readTextIfExists(path.join(nodeDir, "pending.native")));
  if (!nativePending) {
    try {
      await applyPatch(repoPath, diffText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      node.status = "blocked";
      node.error = message;
      node.change = {
        status: "apply_failed",
        diffArtifact: "pending.diff",
        applyError: message,
        source: "provider"
      };
      node.verdict = "blocked";
      node.end = nowIso();
      if (err instanceof PatchApplyError && err.artifacts) {
        node.artifacts = upsertArtifacts(node.artifacts, [
          await writeArtifact(nodeDir, "apply.patch", diffText, "text/x-diff"),
          await writeArtifact(nodeDir, "git-status.txt", await fs.readFile(err.artifacts.gitStatusPath, "utf8").catch(() => ""), "text/plain"),
          await writeArtifact(nodeDir, "conflicts.json", await fs.readFile(err.artifacts.conflictsPath, "utf8").catch(() => "{}"), "application/json"),
          await writeArtifact(nodeDir, "conflict-summary.md", await fs.readFile(err.artifacts.summaryPath, "utf8").catch(() => message), "text/markdown"),
          await writeArtifact(nodeDir, "recovery-guide.md", await fs.readFile(err.artifacts.recoveryGuidePath, "utf8").catch(() => message), "text/markdown")
        ]);
      }
      await writeNodeStatus(nodeDir, node);
      await persistMissionRun(runDir, run);
      return run;
    }
  }
  node.approval = node.approval ? { ...node.approval, status: "approved" } : null;
  node.status = "completed";
  node.end = nowIso();
  node.error = null;
  node.pauseReason = null;
  node.change = {
    status: "applied",
    diffArtifact: "pending.diff",
    appliedAt: nowIso(),
    source: "provider"
  };
  node.verdict = "ready_for_review";
  node.artifacts = upsertArtifacts(node.artifacts, [
    await writeArtifact(nodeDir, "post-apply.diff", await gitDiff(repoPath).catch(() => diffText), "text/x-diff")
  ]);
  recalculateRunProgress(run);
  updateRunTruth(run);
  await writeNodeStatus(nodeDir, node);
  await persistMissionRun(runDir, run);
  await emitMissionEvent(runDir, {
    t: "mission.node.completed",
    runId: run.runId,
    nodeId: node.id,
    status: node.status,
    ts: Date.now()
  }, onEvent);
  return run;
}

async function buildPromptForNode(runDir: string, repoPath: string, run: MissionRun, node: MissionNode): Promise<string> {
  const template = node.promptPath ? await fs.readFile(node.promptPath, "utf8").catch(() => "") : "";
  const inputs = await resolveMissionInputs(runDir, repoPath, run, node, node.inputs ?? []);
  return renderPrompt(template, inputs);
}

async function resolveMissionInputs(
  runDir: string,
  repoPath: string,
  run: MissionRun,
  node: MissionNode,
  refs: MissionInputRef[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const promptBudget = resolvePromptInputBudget(node);
  for (const ref of refs) {
    if (ref === "goal") {
      result.goal = truncatePromptInput(
        run.goal ?? run.userGoal ?? "",
        promptBudget.goalChars,
        "Goal truncated for prompt safety."
      );
      continue;
    }
    if (ref === "repo_context") {
      result.repo_context = truncatePromptInput(
        await buildRepoContext(repoPath, { mode: promptBudget.repoContextMode }),
        promptBudget.repoContextChars,
        "Repo context truncated for prompt safety."
      );
      continue;
    }
    if (ref === "git_diff") {
      result.git_diff = await buildPromptSafeGitDiff(repoPath, promptBudget.gitDiff);
      continue;
    }
    if (ref.startsWith("artifact:")) {
      const [, nodeId, fileName] = ref.split(":");
      if (!nodeId || !fileName) {
        result[ref] = `(invalid artifact ref: ${ref})`;
        continue;
      }
      const content = await readTextIfExists(path.join(getNodeDir(runDir, nodeId), fileName));
      result[`${nodeId}.${fileName}`] = content
        ? truncatePromptInput(content, MAX_ARTIFACT_INPUT_CHARS, "Artifact content truncated for prompt safety.")
        : `(missing artifact: ${nodeId}/${fileName})`;
      continue;
    }
    if (ref.startsWith("literal:")) {
      result.literal = truncatePromptInput(
        ref.slice("literal:".length),
        MAX_LITERAL_INPUT_CHARS,
        "Literal input truncated for prompt safety."
      );
    }
  }
  return result;
}

function resolvePromptInputBudget(node: MissionNode): PromptInputBudget {
  if (node.executor === "audit") {
    return AUDIT_PROMPT_INPUT_BUDGET;
  }
  return DEFAULT_PROMPT_INPUT_BUDGET;
}

async function buildPromptSafeGitDiff(repoPath: string, budget: GitDiffPromptBudget = DEFAULT_GIT_DIFF_PROMPT_BUDGET): Promise<string> {
  const diff = await gitDiff(repoPath).catch(() => "");
  if (!diff.trim()) {
    return "(git diff unavailable or empty)";
  }
  if (diff.length <= budget.maxChars) {
    return diff;
  }

  const [changedFiles, diffStat] = await Promise.all([
    gitChangedFiles(repoPath).catch(() => []),
    gitDiffStat(repoPath).catch(() => "")
  ]);
  const omittedFiles = Math.max(0, changedFiles.length - budget.maxChangedFiles);
  const diffHead = diff.slice(0, budget.headChars).trimEnd();
  const diffTail = diff.length > budget.headChars
    ? diff.slice(Math.max(budget.headChars, diff.length - budget.tailChars)).trimStart()
    : "";
  const summary = [
    "Git diff truncated for prompt safety.",
    `Original diff size: ${diff.length.toLocaleString()} characters across ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}.`,
    diffStat
      ? `Diff stat:\n${truncatePromptInput(diffStat, budget.maxStatChars, "Diff stat truncated for prompt safety.")}`
      : "",
    changedFiles.length > 0
      ? [
          "Changed files:",
          ...changedFiles.slice(0, budget.maxChangedFiles).map((file) => `- ${file}`),
          omittedFiles > 0 ? `- ... ${omittedFiles} more file${omittedFiles === 1 ? "" : "s"}` : ""
        ].filter(Boolean).join("\n")
      : "",
    `Patch excerpt (start):\n${diffHead}`,
    diffTail ? `Patch excerpt (end):\n${diffTail}` : ""
  ].filter(Boolean).join("\n\n");

  return truncatePromptInput(summary, budget.maxChars, "Git diff summary truncated further for prompt safety.");
}

function truncatePromptInput(value: string, maxChars: number, reason: string): string {
  if (value.length <= maxChars) return value;
  const marker = `\n... (${reason})`;
  const sliceLength = Math.max(0, maxChars - marker.length);
  return `${value.slice(0, sliceLength)}${marker}`;
}

function renderPrompt(template: string, inputs: Record<string, string>): string {
  const sections = Object.entries(inputs)
    .map(([key, value]) => `## ${key}\n${value}`)
    .join("\n\n");
  if (!sections) return template.trim();
  return `${template.trim()}\n\n# Inputs\n${sections}`.trim();
}

async function buildRepoContext(repoPath: string, options: { mode?: "default" | "compact" } = {}): Promise<string> {
  if (options.mode === "compact") {
    return buildCompactRepoContext(repoPath);
  }
  const files: string[] = [];
  await collectRepoFiles(repoPath, repoPath, files);
  const packageJson = await readTextIfExists(path.join(repoPath, "package.json"));
  const readme = await readTextIfExists(path.join(repoPath, "README.md"));
  return [
    `Repo: ${repoPath}`,
    `Files:\n${files.slice(0, 60).map((file) => `- ${file}`).join("\n")}`,
    packageJson ? `package.json:\n${packageJson.slice(0, 2000)}` : "",
    readme ? `README excerpt:\n${readme.slice(0, 2000)}` : ""
  ].filter(Boolean).join("\n\n");
}

async function buildCompactRepoContext(repoPath: string): Promise<string> {
  const entries = (await fs.readdir(repoPath, { withFileTypes: true }).catch(() => []))
    .filter((entry) => !shouldIgnoreRepoContextEntry(entry.name, entry.isDirectory(), repoPath, repoPath))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  await collectRepoFiles(repoPath, repoPath, files);
  const topLevelEntries = entries
    .slice(0, MAX_COMPACT_REPO_CONTEXT_ENTRIES)
    .map((entry) => `- ${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .join("\n");
  const representativeFiles = files
    .slice(0, MAX_COMPACT_REPO_CONTEXT_FILES)
    .map((file) => `- ${file}`)
    .join("\n");
  const packageJson = await readTextIfExists(path.join(repoPath, "package.json"));
  const readme = packageJson ? "" : await readTextIfExists(path.join(repoPath, "README.md"));
  return [
    `Repo: ${repoPath}`,
    topLevelEntries ? `Top-level entries:\n${topLevelEntries}` : "",
    representativeFiles ? `Representative files:\n${representativeFiles}` : "",
    packageJson ? `Root package.json excerpt:\n${packageJson.slice(0, MAX_COMPACT_REPO_PACKAGE_JSON_CHARS)}` : "",
    !packageJson && readme ? `README excerpt:\n${readme.slice(0, MAX_COMPACT_REPO_README_CHARS)}` : ""
  ].filter(Boolean).join("\n\n");
}

const REPO_CONTEXT_IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".mypy_cache",
  ".next",
  ".nox",
  ".orchestrum",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "output",
  "runs",
  "temp",
  "tmp",
  "venv"
]);

const REPO_CONTEXT_IGNORED_FILES = new Set([
  ".DS_Store"
]);

async function collectRepoFiles(rootDir: string, currentDir: string, result: string[]): Promise<void> {
  if (result.length >= 80) return;
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (result.length >= 80) return;
    if (shouldIgnoreRepoContextEntry(entry.name, entry.isDirectory(), currentDir, rootDir)) continue;
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath) || entry.name;
    if (entry.isDirectory()) {
      await collectRepoFiles(rootDir, fullPath, result);
      continue;
    }
    result.push(relPath);
  }
}

function shouldIgnoreRepoContextEntry(
  name: string,
  isDirectory: boolean,
  currentDir: string,
  rootDir: string
): boolean {
  if (isDirectory && REPO_CONTEXT_IGNORED_DIRECTORIES.has(name)) return true;
  if (REPO_CONTEXT_IGNORED_FILES.has(name)) return true;
  if (name === ".orchestrum" && currentDir === rootDir) return true;
  if (!isDirectory && (name.endsWith(".pyc") || name.endsWith(".pyo"))) return true;
  return false;
}

function createMissionGraph(
  template: ReturnType<typeof loadMissionTemplate>,
  agents: MissionAgent[],
  goal: string,
  modelOverrides?: Record<string, string>,
  effortOverrides?: Record<string, string>
): MissionGraph {
  const missingRoles = new Set<string>();
  const nodes = template.nodes.map((definition) => {
    const agent = resolveMissionAgent({
      role: definition.role,
      title: definition.title,
      executor: definition.executor,
      phase: definition.phase,
      acceptanceCriteria: definition.acceptanceCriteria,
      goal
    }, agents);
    if (!agent) missingRoles.add(definition.role);
    const providerConfig = normalizeMissionProvider(agent?.provider ?? {}, definition.role);
    const roleOverride = resolveRoleModelOverride(definition.role, modelOverrides);
    if (roleOverride) {
      providerConfig.modelOverride = roleOverride;
    }
    const roleEffortOverride = resolveRoleEffortOverride(definition.role, effortOverrides);
    if (roleEffortOverride) {
      providerConfig.effort = roleEffortOverride;
    }
    return {
      id: definition.id,
      title: definition.title,
      role: definition.role,
      executor: definition.executor,
      phase: definition.phase,
      dependsOn: definition.dependsOn ?? [],
      status: "pending" as const,
      assignedAgentId: agent?.id,
      assignedAgentName: agent?.name,
      providerConfig,
      provider: providerConfig.vendor,
      transport: providerConfig.transport,
      profileId: providerConfig.profileId,
      model: providerConfig.modelOverride,
      effort: providerConfig.effort,
      promptPath: definition.promptPath,
      inputs: definition.inputs,
      acceptanceCriteria: definition.acceptanceCriteria,
      targetTool: definition.targetTool,
      approval: null,
      artifacts: [],
      error: null,
      pauseReason: null,
      change: { status: "none" as const },
      validation: { status: "not_requested" as const, commands: [], results: [] },
      verdict: "running" as const
    };
  });

  if (missingRoles.size > 0) {
    throw new Error(`Missing mission agents for roles: ${[...missingRoles].join(", ")}`);
  }

  return {
    templateId: template.id,
    name: template.name,
    description: template.description,
    category: template.category,
    defaultGoalHint: template.defaultGoalHint,
    recommendedRoles: template.recommendedRoles,
    outcomes: template.outcomes,
    nodes
  };
}

function hydrateMissionAgents(run: MissionRun, agents: MissionAgent[]) {
  for (const node of run.graph.nodes) {
    const agent = resolveMissionAgent({
      role: node.role,
      title: node.title,
      executor: node.executor,
      phase: node.phase,
      acceptanceCriteria: node.acceptanceCriteria,
      goal: run.goal
    }, agents);
    if (!agent) continue;
    const providerConfig = normalizeMissionProvider(agent.provider, node.role);
    node.assignedAgentId = agent.id;
    node.assignedAgentName = agent.name;
    node.providerConfig = providerConfig;
    node.provider = providerConfig.vendor;
    node.transport = providerConfig.transport;
    node.profileId = providerConfig.profileId;
    node.model = providerConfig.modelOverride;
    node.effort = providerConfig.effort;
  }
}

function resolveMissionAgent(
  request: {
    role: string;
    title?: string;
    executor?: string;
    phase?: string;
    acceptanceCriteria?: string[];
    goal?: string;
  },
  agents: MissionAgent[]
): MissionAgent | null {
  const scored = agents
    .map((agent) => ({ agent, score: scoreMissionAgent(agent, request) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.agent.name.localeCompare(right.agent.name);
    });
  return scored[0]?.agent ?? null;
}

function scoreMissionAgent(
  agent: MissionAgent,
  request: {
    role: string;
    title?: string;
    executor?: string;
    phase?: string;
    acceptanceCriteria?: string[];
    goal?: string;
  }
): number {
  const requiredRole = request.role.trim().toLowerCase();
  const agentRole = agent.role.trim().toLowerCase();
  const specialization = (agent.specialization ?? "").trim().toLowerCase();
  const seniority = (agent.seniority ?? "").trim().toLowerCase();
  const tags = (agent.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const context = [
    request.title ?? "",
    request.goal ?? "",
    ...(request.acceptanceCriteria ?? [])
  ].join("\n").toLowerCase();
  const isImplementationNeed = request.executor === "prompt" || request.executor === "patch";
  const isValidationNeed = request.executor === "validate" || request.phase === "verify";
  const isReviewNeed = request.executor === "audit" || request.phase === "review";

  let score = 0;
  const roleMatched =
    agentRole === requiredRole ||
    agentRole.includes(requiredRole) ||
    tags.includes(requiredRole) ||
    (requiredRole === "dev" && (agentRole === "developer" || agentRole === "engineering")) ||
    (requiredRole === "dev" && ["frontend", "backend", "fullstack", "tester", "qa"].includes(specialization)) ||
    (requiredRole === "pm" && ["pm", "product_manager"].includes(specialization)) ||
    (requiredRole === "audit" && ["audit", "reviewer"].includes(specialization));

  if (!roleMatched) {
    return Number.NEGATIVE_INFINITY;
  }

  if (agentRole === requiredRole) score += 24;
  else if (tags.includes(requiredRole)) score += 18;
  else score += 12;

  if (requiredRole === "pm" && ["pm", "product_manager"].includes(specialization)) score += 22;
  if (requiredRole === "audit" && ["audit", "reviewer"].includes(specialization)) score += 22;

  if (requiredRole === "dev") {
    const frontendNeed = /\b(frontend|ui|ux|component|layout|page|react|next|css|tailwind|modal)\b/.test(context);
    const backendNeed = /\b(backend|api|server|database|schema|migration|endpoint|service|worker|queue)\b/.test(context);
    const browserNeed = /\b(browser|playwright|e2e|journey|qa|smoke)\b/.test(context);

    if (isValidationNeed) {
      if (specialization === "tester") score += 28;
      if (specialization === "qa") score += 24;
      if (specialization === "fullstack") score += 12;
    } else if (isReviewNeed) {
      if (specialization === "qa") score += 8;
      if (specialization === "tester") score += 6;
    } else if (isImplementationNeed) {
      if (frontendNeed && specialization === "frontend") score += 28;
      if (backendNeed && specialization === "backend") score += 28;
      if (frontendNeed && backendNeed && specialization === "fullstack") score += 26;
      if (!frontendNeed && !backendNeed && specialization === "fullstack") score += 18;
      if (frontendNeed && specialization === "fullstack") score += 14;
      if (backendNeed && specialization === "fullstack") score += 14;
      if (browserNeed && specialization === "qa") score += 8;
    }

    if (specialization === "tester" && !isValidationNeed) score -= 8;
    if (specialization === "qa" && !isValidationNeed && !browserNeed) score -= 8;
  }

  if (tags.includes("frontend") && /\b(frontend|ui|react|next|css|tailwind)\b/.test(context)) score += 10;
  if (tags.includes("backend") && /\b(backend|api|server|database|schema|queue)\b/.test(context)) score += 10;
  if (tags.includes("tester") && isValidationNeed) score += 10;
  if (tags.includes("qa") && /\b(browser|playwright|e2e|journey|qa|smoke)\b/.test(context)) score += 10;

  if (seniority === "lead") score += 4;
  else if (seniority === "senior") score += 3;
  else if (seniority === "mid") score += 2;

  const maxParallelWork = Math.max(1, Math.floor(agent.capacity?.maxParallelWork ?? 1));
  const activeLoad = Math.max(0, Math.floor(agent.runtime?.activeLoad ?? 0));
  if (activeLoad >= maxParallelWork) {
    score -= 18 + activeLoad;
  } else {
    score += Math.max(0, maxParallelWork - activeLoad);
  }
  if ((agent.runtime?.state ?? "").trim().toLowerCase() === "sleeping") score -= 2;
  if ((agent.runtime?.state ?? "").trim().toLowerCase() === "error") score -= 12;

  return score;
}

async function persistMissionRun(runDir: string, run: MissionRun): Promise<void> {
  run.graph.nodes.sort((a, b) => a.id.localeCompare(b.id));
  run.recovery = buildMissionRecoveryState(run);
  await writeJson(path.join(runDir, "run.json"), run);
}

async function emitMissionEvent(runDir: string, event: Record<string, unknown>, onEvent?: EventHandler): Promise<void> {
  await appendLine(path.join(runDir, "events.ndjson"), JSON.stringify(event));
  await onEvent?.(event);
}

async function writeNodeStatus(nodeDir: string, node: MissionNode): Promise<void> {
  await writeJson(path.join(nodeDir, "status.json"), {
    stepId: node.id,
    status: mapMissionNodeStatusToStepStatus(node.status),
    start: node.start,
    end: node.end,
    ok: node.status === "completed",
    error: node.error ?? null,
    agentId: node.assignedAgentId ?? null,
    provider: node.provider ?? null,
    model: node.model ?? null,
    pauseReason: node.pauseReason ?? null,
    change: node.change ?? null,
    validation: node.validation ?? null,
    verdict: node.verdict ?? null
  });
}

async function writeArtifact(nodeDir: string, fileName: string, content: string, mimeType?: string): Promise<NodeArtifactRef> {
  await writeText(path.join(nodeDir, fileName), content);
  return {
    name: fileName,
    path: fileName,
    mimeType
  };
}

function buildMissionRecoveryState(run: MissionRun): RunRecoveryState | null {
  if (run.status === "completed" || run.status === "cancelled") {
    return null;
  }
  const blockingNode = [...run.graph.nodes].reverse().find((node) =>
    node.status === "blocked" ||
    node.status === "failed" ||
    node.status === "waiting_input" ||
    node.status === "awaiting_approval"
  ) ?? null;
  if (run.status === "paused" && blockingNode?.status === "awaiting_approval") {
    return {
      status: "attention_required",
      kind: "approval_pause",
      summary: blockingNode.approval?.reason ?? "Mission is waiting for operator approval.",
      guidance: [
        "Review the generated diff and approval reason for the blocked step.",
        "Approve the step when the patch is acceptable, then resume the run.",
        "If the change is unsafe, keep the run paused and request remediation instead."
      ],
      artifacts: buildRecoveryArtifacts(blockingNode.artifacts),
      suggestedActions: [
        {
          kind: "resume_run",
          label: "Resume after approval",
          detail: "Approve the blocked step first, then resume the mission run.",
          runId: run.runId
        }
      ],
      updatedAt: run.end ?? nowIso(),
      blockingStepId: blockingNode.id,
      blockingStepTitle: blockingNode.title
    };
  }
  if (run.status === "paused" && blockingNode?.status === "waiting_input") {
    return {
      status: "attention_required",
      kind: "input_pause",
      summary: blockingNode.error ?? "Mission is waiting for external input before it can continue.",
      guidance: [
        "Import the requested external handoff or response for the paused step.",
        "Resume the mission only after the missing input has been recorded.",
        "Keep the run paused if the external response is still incomplete."
      ],
      artifacts: buildRecoveryArtifacts(blockingNode.artifacts),
      suggestedActions: [
        {
          kind: "manual_recover",
          label: "Import required input",
          detail: "Record the missing delivery or operator input for the paused step before resuming."
        }
      ],
      updatedAt: run.end ?? nowIso(),
      blockingStepId: blockingNode.id,
      blockingStepTitle: blockingNode.title
    };
  }
  if (run.status === "blocked" && blockingNode) {
    const dirtyTreeBlocked = isDirtyTreeRecovery(blockingNode.error, blockingNode.change?.applyError);
    const patchBlocked = blockingNode.change?.status === "apply_failed";
    const validationBlocked = blockingNode.executor === "validate" || run.validation?.status === "failed" || run.validation?.status === "unavailable";
    const artifacts = buildRecoveryArtifacts(blockingNode.artifacts);
    const auditFindingsBlocked = isAuditFindingRecoveryNode(blockingNode, artifacts);
    if (auditFindingsBlocked) {
      const primaryArtifact = artifacts.find((artifact) => artifact.path === "output.json")
        ?? artifacts.find((artifact) => artifact.path === "output.md")
        ?? null;
      const hasSuggestedFix = artifacts.some((artifact) => artifact.path === "suggested_fix.diff");
      return {
        status: "attention_required",
        kind: "audit_findings",
        summary: blockingNode.error ?? summarizeAuditFindingCount(blockingNode.findingCount ?? 0),
        guidance: [
          "Review the preserved audit findings before treating this as a runtime failure.",
          "Fix the blocking issues in the workspace and use the suggested diff only after verifying it is still correct.",
          "Rerun the audit or relaunch the cycle after the findings are addressed."
        ],
        artifacts,
        suggestedActions: [
          ...(primaryArtifact
            ? [{
                kind: "inspect_artifact" as const,
                label: "Review audit findings",
                detail: "Open the preserved audit output to inspect every blocking finding.",
                artifactPath: primaryArtifact.path
              }]
            : []),
          ...(hasSuggestedFix
            ? [{
                kind: "inspect_artifact" as const,
                label: "Inspect suggested fix",
                detail: "Review the proposed diff before applying any manual remediation.",
                artifactPath: "suggested_fix.diff"
              }]
            : []),
          {
            kind: "manual_recover",
            label: "Fix findings in the workspace",
            detail: "Address the blocking findings in the repository, then rerun the audit or relaunch the work item."
          }
        ],
        updatedAt: run.end ?? nowIso(),
        blockingStepId: blockingNode.id,
        blockingStepTitle: blockingNode.title
      };
    }
    if (patchBlocked) {
      return {
        status: "attention_required",
        kind: dirtyTreeBlocked ? "dirty_tree" : "patch_conflict",
        summary: blockingNode.change?.applyError ?? blockingNode.error ?? "Patch apply is blocked and needs operator recovery.",
        guidance: dirtyTreeBlocked
          ? [
              "Inspect the current repo status and resolve overlapping local changes before retrying the patch.",
              "Commit, stash, or discard the conflicting files outside `.orchestrum`.",
              "Resume the mission run after the repository is clean enough to accept the generated patch."
            ]
          : [
              "Inspect the conflict summary and conflicted files recorded for this step.",
              "Resolve the merge conflicts in the repository and make sure `git status` is clean enough for retry.",
              "Resume the mission run to retry patch application from the preserved diff."
            ],
        artifacts,
        suggestedActions: [
          artifacts.find((artifact) => artifact.path === "conflict-summary.md")
            ? {
                kind: "inspect_artifact",
                label: "Inspect conflict summary",
                detail: "Review the preserved conflict summary before changing repository state.",
                artifactPath: "conflict-summary.md"
              }
            : {
                kind: "inspect_artifact",
                label: "Inspect git status",
                detail: "Review the preserved repo state before retrying patch application.",
                artifactPath: "git-status.txt"
              },
          {
            kind: dirtyTreeBlocked ? "clean_repo" : "resolve_conflicts",
            label: dirtyTreeBlocked ? "Clean overlapping repo state" : "Resolve merge conflicts",
            detail: dirtyTreeBlocked
              ? "Commit, stash, or discard the overlapping files so the patch can be retried safely."
              : "Resolve the conflicted files recorded in the conflict bundle before resuming the run."
          },
          {
            kind: "resume_run",
            label: "Resume blocked run",
            detail: "Retry patch application from the preserved diff after the repository state is fixed.",
            runId: run.runId
          }
        ],
        updatedAt: run.end ?? nowIso(),
        blockingStepId: blockingNode.id,
        blockingStepTitle: blockingNode.title
      };
    }
    if (validationBlocked) {
      return {
        status: "attention_required",
        kind: "validation_blocked",
        summary: blockingNode.error ?? run.validation?.summary ?? "Validation is blocked and needs operator recovery.",
        guidance: [
          "Inspect the validation summary and logs for the blocked step.",
          "Fix the failing or unavailable validation prerequisites in the repository or machine environment.",
          "Resume the mission run to re-run validation after the environment is ready."
        ],
        artifacts,
        suggestedActions: [
          {
            kind: "inspect_artifact",
            label: "Inspect validation artifacts",
            detail: "Review the validation summary for the blocked step before retrying."
          },
          {
            kind: "resume_run",
            label: "Resume blocked run",
            detail: "Re-run validation after the missing dependency or failing command is fixed.",
            runId: run.runId
          }
        ],
        updatedAt: run.end ?? nowIso(),
        blockingStepId: blockingNode.id,
        blockingStepTitle: blockingNode.title
      };
    }
  }
  if (run.status === "failed" && blockingNode) {
    return {
      status: "attention_required",
      kind: "unknown",
      summary: blockingNode.error ?? run.error ?? "Mission failed and needs operator recovery.",
      guidance: [
        "Inspect the failed step artifacts and logs to determine the actual failure mode.",
        "Fix the underlying repository or environment issue before retrying execution.",
        "Relaunch or manually recover the work item once the failure cause is understood."
      ],
      artifacts: buildRecoveryArtifacts(blockingNode.artifacts),
      suggestedActions: [
        {
          kind: "inspect_artifact",
          label: "Inspect failure artifacts",
          detail: "Review the preserved step artifacts before retrying."
        }
      ],
      updatedAt: run.end ?? nowIso(),
      blockingStepId: blockingNode.id,
      blockingStepTitle: blockingNode.title
    };
  }
  return run.recovery ?? null;
}

function buildRecoveryArtifacts(artifacts: NodeArtifactRef[]): RunRecoveryState["artifacts"] {
  const preferred = new Map([
    ["output.md", { label: "Audit report", mimeType: "text/markdown" }],
    ["output.json", { label: "Audit findings JSON", mimeType: "application/json" }],
    ["suggested_fix.diff", { label: "Suggested fix diff", mimeType: "text/x-diff" }],
    ["conflict-summary.md", { label: "Conflict summary", mimeType: "text/markdown" }],
    ["recovery-guide.md", { label: "Recovery guide", mimeType: "text/markdown" }],
    ["git-status.txt", { label: "Git status", mimeType: "text/plain" }],
    ["conflicts.json", { label: "Conflict details", mimeType: "application/json" }],
    ["apply.patch", { label: "Preserved patch", mimeType: "text/x-diff" }],
    ["apply-error.txt", { label: "Apply error", mimeType: "text/plain" }],
    ["validation/summary.json", { label: "Validation summary", mimeType: "application/json" }]
  ]);
  return artifacts
    .filter((artifact) => preferred.has(artifact.path) || preferred.has(artifact.name))
    .map((artifact) => {
      const descriptor = preferred.get(artifact.path) ?? preferred.get(artifact.name) ?? {
        label: artifact.name,
        mimeType: artifact.mimeType ?? null
      };
      return {
        label: descriptor.label,
        path: artifact.path,
        mimeType: artifact.mimeType ?? descriptor.mimeType ?? null
      };
    });
}

function isDirtyTreeRecovery(...messages: Array<string | null | undefined>): boolean {
  return messages.some((message) =>
    typeof message === "string" &&
    /overlapping uncommitted changes|merge conflicts|commit, stash, or clean/i.test(message)
  );
}

function getMissionDeliveryDir(runDir: string): string {
  return path.join(runDir, "delivery");
}

async function loadMissionDeliverySession(runDir: string): Promise<DeliverySessionState | null> {
  return readJsonIfExists<DeliverySessionState>(path.join(getMissionDeliveryDir(runDir), "session.json"));
}

async function persistMissionDeliverySession(runDir: string, session: DeliverySessionState): Promise<void> {
  const deliveryDir = getMissionDeliveryDir(runDir);
  await ensureDir(deliveryDir);
  await writeJson(path.join(deliveryDir, "session.json"), session);
}

async function ensureMissionDeliverySession(
  runDir: string,
  run: MissionRun,
  node: MissionNode
): Promise<DeliverySessionState> {
  const existing = await loadMissionDeliverySession(runDir);
  if (existing) {
    if (!existing.packets.find((entry) => entry.id === node.id)) {
      existing.packets.unshift(createMissionDeliveryPacket(run, node));
      applyDerivedSessionState(existing);
      await persistMissionDeliverySession(runDir, existing);
    }
    return existing;
  }

  const createdAt = nowIso();
  const session: DeliverySessionState = {
    runId: run.runId,
    workspaceId: run.workspaceId ?? "default",
    repoPath: run.repoPath,
    goal: run.goal ?? "",
    sprintName: run.graph.name,
    notes: `Mission-backed delivery session for ${run.missionTemplateId}.`,
    selectedPaths: [],
    status: "running",
    preset: createDefaultTeamPreset(),
    capabilities: [],
    roleBindings: [{
      roleId: node.role,
      mode: "manual_browser",
      target: normalizeMissionTargetTool(node.targetTool ?? "claude"),
      capabilityIds: ["handoff:browser"],
      available: true,
      reason: "Mission-backed delivery handoff",
      confirmed: true
    }],
    packets: [createMissionDeliveryPacket(run, node)],
    exports: [],
    imports: [],
    findings: [],
    remediations: [],
    evidence: [{
      id: crypto.randomUUID(),
      sessionId: run.runId,
      packetId: node.id,
      kind: "session_started",
      actor: "system",
      roleId: node.role,
      source: "mission",
      summary: `Mission delivery session started from ${run.missionTemplateId}.`,
      createdAt
    }],
    outputs: {
      completedPacketIds: [],
      openFindingIds: [],
      resolvedFindingIds: [],
      suggestedCommitScope: [],
      humanActionItems: []
    },
    worktreePath: run.worktreePath ?? null,
    createdAt,
    updatedAt: createdAt
  };
  applyDerivedSessionState(session);
  await persistMissionDeliverySession(runDir, session);
  return session;
}

function createMissionDeliveryPacket(run: MissionRun, node: MissionNode): WorkPacket {
  const createdAt = nowIso();
  return {
    id: node.id,
    sessionId: run.runId,
    roleId: node.role,
    title: node.title,
    objective: run.goal ?? "",
    summary: `Mission handoff for ${node.id}.`,
    mode: "manual_browser",
    status: "pending",
    target: normalizeMissionTargetTool(node.targetTool ?? "claude"),
    repoPath: run.repoPath,
    workspaceId: run.workspaceId ?? "default",
    goal: run.goal ?? "",
    sprintName: run.graph.name,
    selectedPaths: [],
    contextNotes: [],
    repoScripts: [],
    acceptanceCriteria: node.acceptanceCriteria ?? [],
    expectedOutput: [
      "Status line",
      "Summary",
      "Findings",
      "Unified diff when code changes are proposed"
    ],
    dependsOn: [],
    createdAt,
    updatedAt: createdAt
  };
}

function normalizeMissionTargetTool(value: string): "chatgpt" | "claude" | "cursor" | "codex" | "copilot" {
  switch (value) {
    case "chatgpt":
    case "cursor":
    case "codex":
    case "copilot":
      return value;
    default:
      return "claude";
  }
}

async function buildDeliveryPacket(runDir: string, repoPath: string, run: MissionRun, node: MissionNode): Promise<string> {
  const inputs = await resolveMissionInputs(runDir, repoPath, run, node, node.inputs ?? []);
  const sections = Object.entries(inputs)
    .map(([key, value]) => `## ${key}\n${value}`)
    .join("\n\n");
  return [
    `# Mission Packet`,
    ``,
    `Run ID: ${run.runId}`,
    `Node ID: ${node.id}`,
    `Template: ${run.missionTemplateId}`,
    `Target Tool: ${node.targetTool ?? "claude"}`,
    ``,
    `## Goal`,
    run.goal ?? "",
    ``,
    sections,
    ``,
    `## Response Contract`,
    `- Start with \`Status: completed\` or \`Status: blocked\`.`,
    `- Add \`Summary: ...\`.`,
    `- Add findings as \`- [category|severity] title :: summary\`.`
  ].join("\n").trim();
}

async function recordMissionDeliveryExport(options: {
  runDir: string;
  run: MissionRun;
  node: MissionNode;
  packetText: string;
  targetTool: string;
}): Promise<void> {
  const session = await ensureMissionDeliverySession(options.runDir, options.run, options.node);
  const packet = session.packets.find((entry) => entry.id === options.node.id);
  if (!packet) return;
  const createdAt = nowIso();
  const exportRecord: PacketExport = {
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    format: "markdown+json",
    targetTool: normalizeMissionTargetTool(options.targetTool),
    textVariant: "review_prompt",
    renderedText: options.packetText,
    markdown: options.packetText,
    sidecar: {
      runId: session.runId,
      packetId: packet.id,
      nodeId: options.node.id,
      goal: session.goal
    },
    fileNameBase: `${session.runId}-${packet.id}-${options.targetTool}`,
    createdAt
  };
  const deliveryDir = getMissionDeliveryDir(options.runDir);
  await ensureDir(path.join(deliveryDir, "exports"));
  await writeText(path.join(deliveryDir, "exports", `${exportRecord.fileNameBase}.md`), options.packetText);
  await writeJson(path.join(deliveryDir, "exports", `${exportRecord.fileNameBase}.json`), exportRecord.sidecar);
  session.exports = [exportRecord, ...session.exports.filter((entry) => entry.id !== exportRecord.id)];
  packet.lastExportId = exportRecord.id;
  packet.status = "awaiting_import";
  packet.updatedAt = createdAt;
  session.evidence.push({
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    kind: "packet_exported",
    actor: "system",
    roleId: packet.roleId,
    source: "mission",
    summary: `Exported mission delivery packet ${packet.id} for ${exportRecord.targetTool}.`,
    createdAt,
    data: {
      targetTool: exportRecord.targetTool
    }
  });
  session.updatedAt = createdAt;
  applyDerivedSessionState(session);
  await persistMissionDeliverySession(options.runDir, session);
}

async function recordMissionDeliveryImport(options: {
  runDir: string;
  run: MissionRun;
  node: MissionNode;
  rawText: string;
  targetTool?: string;
  findings: MissionImportFinding[];
  diffText: string | null;
  blocked: boolean;
}): Promise<void> {
  const session = await ensureMissionDeliverySession(options.runDir, options.run, options.node);
  const packet = session.packets.find((entry) => entry.id === options.node.id);
  if (!packet) return;
  const createdAt = nowIso();
  const importRecord: PacketImport = {
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    matchedPacketId: packet.id,
    targetTool: options.targetTool ? normalizeMissionTargetTool(options.targetTool) : undefined,
    matchStatus: "matched",
    candidatePacketIds: [packet.id],
    source: "paste",
    rawText: options.rawText,
    summary: summarizeInput(options.rawText),
    confidence: "high",
    matchReasons: ["Mission handoff import is tied to a specific wait node."],
    createdAt
  };
  const deliveryDir = getMissionDeliveryDir(options.runDir);
  await ensureDir(path.join(deliveryDir, "imports"));
  await writeText(path.join(deliveryDir, "imports", `${importRecord.id}.txt`), options.rawText);
  session.imports.unshift(importRecord);
  packet.lastImportId = importRecord.id;
  packet.updatedAt = createdAt;

  const packetFindings = extractFindingsFromImport({
    session,
    packet,
    importRecord
  });
  session.findings = [...packetFindings, ...session.findings];
  const remediations = createRemediationTasks(session, packet, packetFindings, createdAt);
  if (remediations.length > 0) {
    const remediationPackets = remediations.map((task) => {
      const remediationPacket = buildRemediationPacket(session, task, createdAt);
      task.packetId = remediationPacket.id;
      return remediationPacket;
    });
    session.remediations = [...remediations, ...session.remediations];
    session.packets = [...session.packets, ...remediationPackets];
  }

  packet.status = resolvePacketCompletionStatus(options.blocked ? "blocked" : "completed", packetFindings);
  session.evidence.push({
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    kind: "packet_imported",
    actor: "user",
    roleId: packet.roleId,
    source: options.targetTool ?? "mission",
    summary: `Imported mission delivery response for packet ${packet.id}.`,
    createdAt,
    data: {
      importId: importRecord.id,
      diffDetected: Boolean(options.diffText),
      findingCount: options.findings.length
    }
  });
  if (!options.diffText) {
    session.evidence.push({
      id: crypto.randomUUID(),
      sessionId: session.runId,
      packetId: packet.id,
      kind: "packet_imported",
      actor: "system",
      roleId: packet.roleId,
      source: "mission",
      summary: `No patch was generated for packet ${packet.id}; import is evidence-only.`,
      createdAt,
      data: {
        patchGenerated: false
      }
    });
  }
  for (const finding of packetFindings) {
    session.evidence.push({
      id: crypto.randomUUID(),
      sessionId: session.runId,
      packetId: packet.id,
      findingId: finding.id,
      remediationTaskId: finding.remediationTaskId,
      kind: "finding_created",
      actor: "system",
      roleId: packet.roleId,
      source: "mission",
      summary: `Captured mission delivery finding: ${finding.title}.`,
      createdAt
    });
  }
  session.updatedAt = createdAt;
  applyDerivedSessionState(session);
  await persistMissionDeliverySession(options.runDir, session);
}

function upsertArtifacts(existing: NodeArtifactRef[], incoming: NodeArtifactRef[]): NodeArtifactRef[] {
  const map = new Map(existing.map((artifact) => [artifact.name, artifact]));
  for (const artifact of incoming) {
    map.set(artifact.name, artifact);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type AuditIssue = {
  severity: string;
  file: string;
  line: number | null;
  message: string;
};

type ParsedAuditOutput = {
  blocking: boolean;
  issues: AuditIssue[];
  suggested_fix?: string;
};

function parseAuditOutput(outputText: string): ParsedAuditOutput {
  const jsonText = extractJsonBlock(outputText) ?? outputText.trim();
  try {
    const parsed = JSON.parse(jsonText) as {
      blocking?: boolean;
      issues?: Array<{ severity?: string; file?: string; line?: number | null; message?: string }>;
      suggested_fix?: string;
    };
    return {
      blocking: Boolean(parsed.blocking),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.map((issue) => ({
          severity: issue.severity ?? "medium",
          file: issue.file ?? "",
          line: typeof issue.line === "number" ? issue.line : null,
          message: issue.message ?? "Unspecified audit issue."
        }))
        : [],
      suggested_fix: parsed.suggested_fix
    };
  } catch {
    return {
      blocking: false,
      issues: [],
      suggested_fix: undefined
    };
  }
}

async function normalizeAuditOutput(repoPath: string, parsed: ParsedAuditOutput): Promise<ParsedAuditOutput> {
  if (parsed.issues.length === 0) return parsed;

  const issues: AuditIssue[] = [];
  for (const issue of parsed.issues) {
    if (
      await isResolvableMissingModuleFalsePositive(repoPath, issue)
      || await isResolvableMissingApiRouteFalsePositive(repoPath, issue)
      || await isResolvableUnusedImportFalsePositive(repoPath, issue)
      || await isResolvableLinkedWorkItemTaskFalsePositive(repoPath, issue)
      || await isResolvableBuildScriptFalsePositive(repoPath, issue)
    ) {
      continue;
    }
    issues.push(issue);
  }

  return {
    blocking: parsed.blocking && issues.length > 0,
    issues,
    suggested_fix: issues.length > 0 ? parsed.suggested_fix : undefined
  };
}

async function isResolvableMissingModuleFalsePositive(repoPath: string, issue: AuditIssue): Promise<boolean> {
  if (!issue.file.trim()) return false;
  if (!/\b(module not found|cannot find module|does not exist)\b/i.test(issue.message)) return false;

  const sourceFilePath = path.resolve(repoPath, issue.file);
  if (!sourceFilePath.startsWith(path.resolve(repoPath))) return false;
  if (!await isFile(sourceFilePath)) return false;

  const specifier = await inferAuditIssueModuleSpecifier(repoPath, sourceFilePath, issue);
  if (!specifier) return false;

  const resolvedModule = await resolveAuditIssueModule(repoPath, sourceFilePath, specifier);
  return resolvedModule !== null;
}

async function isResolvableMissingApiRouteFalsePositive(repoPath: string, issue: AuditIssue): Promise<boolean> {
  if (!issue.message.includes("/api/")) return false;
  if (!/(route|routes|handler|handlers|404|exist)/i.test(issue.message)) return false;

  const rawRouteMatches = Array.from(new Set(
    [...issue.message.matchAll(/\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*/g)].map((match) => match[0].replace(/\/+$/u, ""))
  ));
  const routeMatches = rawRouteMatches.filter((routePath, _, all) =>
    !all.some((other) => other !== routePath && other.startsWith(`${routePath}/`))
  );
  if (routeMatches.length === 0) return false;

  for (const routePath of routeMatches) {
    const routeBase = path.join(repoPath, "apps", "ui", "src", "app", routePath.slice(1), "route");
    const resolvedRoute = await resolveExistingModulePath(repoPath, routeBase);
    if (!resolvedRoute) return false;
  }

  return true;
}

async function isResolvableUnusedImportFalsePositive(repoPath: string, issue: AuditIssue): Promise<boolean> {
  if (!issue.file.trim()) return false;
  if (!/\bunused imports?\b/i.test(issue.message)) return false;

  const sourceFilePath = path.resolve(repoPath, issue.file);
  if (!sourceFilePath.startsWith(path.resolve(repoPath))) return false;

  const source = await readTextIfExists(sourceFilePath);
  if (!source) return false;

  const sourceLines = source.split(/\r?\n/u);
  const importBlock = extractImportBlockForIssue(sourceLines, issue);
  if (!importBlock) return false;

  const importBindings = extractImportBindings(importBlock.text);
  if (importBindings.length === 0) return false;

  const issueBindings = extractUnusedImportBindingsFromMessage(issue.message);
  const bindingsToVerify = (issueBindings.length > 0 ? issueBindings : importBindings)
    .filter((binding) => importBindings.includes(binding));
  if (bindingsToVerify.length === 0) return false;

  const sourceWithoutImport = [
    ...sourceLines.slice(0, importBlock.startLine - 1),
    ...sourceLines.slice(importBlock.endLine)
  ].join("\n");

  return bindingsToVerify.every((binding) => buildIdentifierUsagePattern(binding).test(sourceWithoutImport));
}

async function isResolvableLinkedWorkItemTaskFalsePositive(repoPath: string, issue: AuditIssue): Promise<boolean> {
  if (!/linkedWorkItemId/.test(issue.message) || !/getQueuedTasks/.test(issue.message)) return false;

  const [taskRuntimeSource, agentPlatformSource] = await Promise.all([
    readTextIfExists(path.join(repoPath, "apps", "ui", "src", "lib", "workRuntime.ts")),
    readTextIfExists(path.join(repoPath, "packages", "service", "src", "agentPlatform.ts"))
  ]);
  if (!taskRuntimeSource || !agentPlatformSource) return false;
  if (!taskRuntimeSource.includes("linkedWorkItemId")) return false;

  return [
    /linkedWorkItemId:\s*options\.workItem\.id/,
    /linkedWorkItemId:\s*input\.linkedWorkItemId/,
    /linkedWorkItemId:\s*typeof record\.linkedWorkItemId/
  ].every((pattern) => pattern.test(agentPlatformSource));
}

async function isResolvableBuildScriptFalsePositive(repoPath: string, issue: AuditIssue): Promise<boolean> {
  if (!/build:desktop/i.test(issue.message) || !/non-existent script/i.test(issue.message)) return false;

  const issueFilePath = path.resolve(repoPath, issue.file || "");
  const packageJsonPath = path.resolve(repoPath, "package.json");
  if (issueFilePath !== packageJsonPath) return false;

  const packageJsonText = await readTextIfExists(packageJsonPath);
  if (!packageJsonText) return false;

  try {
    const parsed = JSON.parse(packageJsonText) as { scripts?: Record<string, unknown> };
    const buildDesktop = parsed.scripts?.["build:desktop"];
    return typeof buildDesktop === "string" && buildDesktop.includes("npm run build:service");
  } catch {
    return false;
  }
}

function extractImportBlockForIssue(
  sourceLines: string[],
  issue: AuditIssue
): { startLine: number; endLine: number; text: string } | null {
  let startIndex = -1;
  if (typeof issue.line === "number" && issue.line > 0 && issue.line <= sourceLines.length) {
    startIndex = issue.line - 1;
    while (startIndex >= 0 && !/\bimport\b/.test(sourceLines[startIndex] ?? "")) {
      startIndex -= 1;
    }
  }
  if (startIndex < 0) {
    startIndex = findImportLineIndexForIssue(sourceLines, issue);
  }
  if (startIndex < 0) return null;

  let endIndex = startIndex;
  let text = sourceLines[startIndex] ?? "";
  while (endIndex + 1 < sourceLines.length && !/;\s*$/u.test(sourceLines[endIndex] ?? "")) {
    endIndex += 1;
    text = `${text}\n${sourceLines[endIndex] ?? ""}`;
  }

  return {
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    text
  };
}

function findImportLineIndexForIssue(sourceLines: string[], issue: AuditIssue): number {
  const importSource = inferAuditIssueImportSource(issue.message);
  if (importSource) {
    const matchIndex = sourceLines.findIndex((line) => /\bimport\b/.test(line) && line.includes(importSource));
    if (matchIndex >= 0) return matchIndex;
  }
  return -1;
}

function inferAuditIssueImportSource(message: string): string | null {
  const match = message.match(/\bfrom\s+["'`](.+?)["'`]/iu);
  return match?.[1]?.trim() ?? null;
}

function extractUnusedImportBindingsFromMessage(message: string): string[] {
  const match = message.match(/\bUnused imports?:\s*(.+?)(?:\s+from\b|$)/iu);
  if (!match?.[1]) return [];
  return match[1]
    .replace(/[{}]/g, " ")
    .split(/,|\band\b/iu)
    .map((value) => value.replace(/["'`]/g, "").trim())
    .map((value) => value.split(/\s+as\s+/iu).at(-1)?.trim() ?? "")
    .filter((value) => /^[A-Za-z_$][\w$]*$/u.test(value));
}

function extractImportBindings(importText: string): string[] {
  const normalized = importText.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^import\s+(?:type\s+)?(.+?)\s+from\s+["'`].+?["'`]\s*;?$/u);
  const clause = match?.[1]?.trim() ?? "";
  if (!clause) return [];

  const bindings = new Set<string>();
  const namedMatch = clause.match(/\{([^}]+)\}/u);
  if (namedMatch?.[1]) {
    for (const entry of namedMatch[1].split(",")) {
      const normalizedEntry = entry.replace(/^type\s+/u, "").trim();
      if (!normalizedEntry) continue;
      const localName = normalizedEntry.split(/\s+as\s+/iu).at(-1)?.trim() ?? "";
      if (/^[A-Za-z_$][\w$]*$/u.test(localName)) {
        bindings.add(localName);
      }
    }
  }

  const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u);
  if (namespaceMatch?.[1]) {
    bindings.add(namespaceMatch[1]);
  }

  const defaultClause = clause
    .replace(/\{[^}]+\}/u, "")
    .replace(/\*\s+as\s+[A-Za-z_$][\w$]*/u, "")
    .replace(/,+/gu, " ")
    .replace(/^type\s+/u, "")
    .trim();
  if (/^[A-Za-z_$][\w$]*$/u.test(defaultClause)) {
    bindings.add(defaultClause);
  }

  return [...bindings];
}

function buildIdentifierUsagePattern(binding: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(binding)}\\b`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function inferAuditIssueModuleSpecifier(
  repoPath: string,
  sourceFilePath: string,
  issue: AuditIssue
): Promise<string | null> {
  const quotedMatches = [...issue.message.matchAll(/["'`](.+?)["'`]/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  const localSpecifier = quotedMatches.find((value) => isLikelyLocalModuleSpecifier(value));
  if (localSpecifier) return localSpecifier;

  if (typeof issue.line === "number" && issue.line > 0) {
    const source = await readTextIfExists(sourceFilePath);
    const lineText = source?.split(/\r?\n/u)[issue.line - 1] ?? "";
    const importSpecifier = extractImportSpecifierFromSourceLine(lineText);
    if (importSpecifier) return importSpecifier;
  }

  return quotedMatches[0] ?? null;
}

function isLikelyLocalModuleSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("@/") || value.startsWith("/");
}

function extractImportSpecifierFromSourceLine(lineText: string): string | null {
  const importMatch = lineText.match(/from\s+["'`](.+?)["'`]/u)
    ?? lineText.match(/import\s*\(\s*["'`](.+?)["'`]\s*\)/u)
    ?? lineText.match(/require\(\s*["'`](.+?)["'`]\s*\)/u);
  return importMatch?.[1]?.trim() ?? null;
}

async function resolveAuditIssueModule(repoPath: string, sourceFilePath: string, specifier: string): Promise<string | null> {
  if (!specifier.trim()) return null;

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveExistingModulePath(repoPath, path.resolve(path.dirname(sourceFilePath), specifier));
  }

  if (specifier.startsWith("/")) {
    return resolveExistingModulePath(repoPath, path.join(repoPath, specifier.slice(1)));
  }

  const tsconfigPath = await findNearestTsconfigPath(repoPath, path.dirname(sourceFilePath));
  if (!tsconfigPath) return null;

  const tsconfig = await loadTsconfigResolver(tsconfigPath);
  if (!tsconfig) return null;

  for (const [pattern, replacements] of Object.entries(tsconfig.paths)) {
    for (const replacement of replacements) {
      const resolvedPattern = applyTsconfigPathPattern(pattern, replacement, specifier);
      if (!resolvedPattern) continue;
      const candidate = path.resolve(tsconfig.baseDir, tsconfig.baseUrl, resolvedPattern);
      const resolved = await resolveExistingModulePath(repoPath, candidate);
      if (resolved) return resolved;
    }
  }

  const baseUrlCandidate = path.resolve(tsconfig.baseDir, tsconfig.baseUrl, specifier);
  return resolveExistingModulePath(repoPath, baseUrlCandidate);
}

async function findNearestTsconfigPath(repoPath: string, startDir: string): Promise<string | null> {
  const rootDir = path.resolve(repoPath);
  let currentDir = startDir;

  while (currentDir.startsWith(rootDir)) {
    const candidate = path.join(currentDir, "tsconfig.json");
    if (await isFile(candidate)) return candidate;
    if (currentDir === rootDir) break;
    currentDir = path.dirname(currentDir);
  }

  return null;
}

async function loadTsconfigResolver(tsconfigPath: string): Promise<{
  baseDir: string;
  baseUrl: string;
  paths: Record<string, string[]>;
} | null> {
  try {
    const raw = await fs.readFile(tsconfigPath, "utf8");
    const parsed = JSON.parse(raw) as {
      compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[] | string>;
      };
    };
    const rawPaths = parsed.compilerOptions?.paths ?? {};
    const normalizedPaths: Record<string, string[]> = {};
    for (const [pattern, replacements] of Object.entries(rawPaths)) {
      const values = Array.isArray(replacements)
        ? replacements.filter((value): value is string => typeof value === "string")
        : [];
      if (values.length > 0) {
        normalizedPaths[pattern] = values;
      }
    }
    return {
      baseDir: path.dirname(tsconfigPath),
      baseUrl: parsed.compilerOptions?.baseUrl?.trim() || ".",
      paths: normalizedPaths
    };
  } catch {
    return null;
  }
}

function applyTsconfigPathPattern(pattern: string, replacement: string, specifier: string): string | null {
  if (pattern === specifier) return replacement;
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1) return null;

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;

  const wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length);
  return replacement.includes("*") ? replacement.replace("*", wildcardValue) : replacement;
}

async function resolveExistingModulePath(repoPath: string, candidateBase: string): Promise<string | null> {
  const rootDir = path.resolve(repoPath);
  const candidates = new Set<string>([candidateBase]);
  if (!path.extname(candidateBase)) {
    for (const extension of MODULE_RESOLUTION_EXTENSIONS) {
      candidates.add(`${candidateBase}${extension}`);
      candidates.add(path.join(candidateBase, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(candidate);
    if (!resolvedCandidate.startsWith(rootDir)) continue;
    if (await isFile(resolvedCandidate)) return resolvedCandidate;
  }

  return null;
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

function summarizeAuditFindingCount(count: number): string {
  if (count > 0) {
    return count === 1
      ? "Audit recorded 1 blocking finding."
      : `Audit recorded ${count} blocking findings.`;
  }
  return "Audit returned blocking findings.";
}

function summarizeAuditFindings(parsed: ReturnType<typeof parseAuditOutput>): string {
  const count = parsed.issues.length;
  if (count === 0) return summarizeAuditFindingCount(0);
  const lead = parsed.issues[0]!;
  const location = formatAuditIssueLocation(lead);
  const detail = [location, trimSentence(lead.message)].filter(Boolean).join(" ");
  return count === 1
    ? `Audit recorded 1 blocking finding: ${detail}.`
    : `Audit recorded ${count} blocking findings. Lead finding: ${detail}.`;
}

function formatAuditIssueLocation(issue: {
  file: string;
  line: number | null;
}): string {
  const file = issue.file.trim();
  if (!file) return "";
  return typeof issue.line === "number" ? `${file}:${issue.line}` : file;
}

function trimSentence(value: string): string {
  return value.trim().replace(/[.]+$/g, "");
}

function isAuditFindingRecoveryNode(
  node: MissionNode,
  artifacts: RunRecoveryState["artifacts"]
): boolean {
  if (node.executor !== "audit") return false;
  if ((node.findingCount ?? 0) > 0) return true;
  return artifacts.some((artifact) => artifact.path === "output.json" || artifact.path === "output.md");
}

function extractDiffBlock(outputText: string): string | null {
  const match = outputText.match(/```diff\s*([\s\S]*?)```/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return outputText.includes("--- ") && outputText.includes("+++ ") ? outputText.trim() : null;
}

function extractJsonBlock(outputText: string): string | null {
  const fenced = outputText.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const trimmed = outputText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}

function parseMissionFindings(text: string): MissionImportFinding[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^- \[([^|\]]+)\|([^\]]+)\] (.+?) :: (.+)$/);
      if (!match) return [];
      return [{
        category: match[1]!.trim(),
        severity: match[2]!.trim(),
        title: match[3]!.trim(),
        summary: match[4]!.trim()
      }];
    });
}

function parseExplicitStatus(text: string): "completed" | "blocked" | null {
  const match = text.match(/^status:\s*(completed|blocked)\s*$/im);
  if (!match?.[1]) return null;
  return match[1].toLowerCase() as "completed" | "blocked";
}

function summarizeInput(text: string): string {
  const summary = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith("summary:"));
  return summary ? summary.slice("summary:".length).trim() : "";
}

function mapMissionNodeStatusToStepStatus(status: MissionNode["status"]): StepState["status"] {
  if (status === "awaiting_approval" || status === "waiting_input") return "paused";
  return status;
}

function getNodeDir(runDir: string, nodeId: string): string {
  return path.join(runDir, "nodes", nodeId);
}

function buildMissionRunState(run: MissionRun): RunState {
  return {
    ...run,
    workspacePath: run.repoPath,
    meta: {
      id: run.runId,
      workspaceId: run.workspaceId,
      startedAt: run.start,
      finishedAt: run.end
    },
    stats: {
      totalCost: run.totalCost,
      totalTokens: run.totalTokens,
      totalSteps: run.totalSteps
    },
    steps: missionGraphToStepStates(run.graph)
  };
}

function buildMissionStepState(node: MissionNode) {
  const step = buildStepState({
    stepId: node.id,
    status: mapMissionNodeStatusToStepStatus(node.status),
    agentId: node.assignedAgentId ?? null,
    ok: node.status === "completed",
    error: node.error ?? null,
    provider: node.provider ?? null,
    model: node.model ?? null
  });
  step.start = node.start;
  step.end = node.end;
  step.pauseReason = node.pauseReason ?? null;
  step.change = node.change ?? null;
  step.validation = node.validation ?? null;
  step.verdict = node.verdict ?? null;
  return step;
}

async function appendProviderTrace(options: {
  repoPath: string;
  workspaceId: string;
  runId: string;
  node: MissionNode;
  traceContext?: StartMissionOptions["traceContext"];
  prompt: string;
  response: string;
  provider: Awaited<ReturnType<typeof completeWithProvider>>;
  usage: ReturnType<typeof normalizeUsage>;
  estimatedCost: number | null;
}) {
  const workItemId = options.traceContext?.workItemId?.trim();
  if (!workItemId) return;
  const cycleId = options.traceContext?.cycleId ?? null;
  const workstreamId = options.traceContext?.workstreamId ?? options.node.id;
  const taskId = options.traceContext?.taskId ?? null;
  const ownerAgentId = options.node.assignedAgentId ?? options.traceContext?.ownerAgentId ?? null;
  const ownerAgentName = options.node.assignedAgentName ?? options.traceContext?.ownerAgentName ?? null;
  const ownerRole = options.traceContext?.ownerRole ?? options.node.role ?? null;
  const promptTrace = await appendWorkItemTrace(options.repoPath, {
    workspaceId: options.workspaceId,
    workItemId,
    cycleId,
    workstreamId,
    taskId,
    runId: options.runId,
    nodeId: options.node.id,
    traceType: "provider_prompt",
    ownerAgentId,
    ownerAgentName,
    ownerRole,
    providerVendor: options.provider.vendor,
    providerTransport: options.provider.transport,
    providerModel: options.provider.model,
    providerEffort: options.provider.effort ?? null,
    promptCountDelta: 1,
    exchangeCountDelta: 0,
    summary: `${options.node.title} sent a provider prompt.`,
    promptSummary: summarizeTraceText(options.prompt),
    promptRaw: options.prompt,
    workstreamTitle: options.node.title,
    laneLabel: options.node.role,
    payload: {
      executor: options.node.executor,
      phase: options.node.phase ?? null
    }
  }).catch(() => undefined);
  if (promptTrace) {
    await appendTraceWorkspaceSignal(options.repoPath, options.workspaceId, promptTrace, "prompt.sent").catch(() => undefined);
  }
  const responseTrace = await appendWorkItemTrace(options.repoPath, {
    workspaceId: options.workspaceId,
    workItemId,
    cycleId,
    workstreamId,
    taskId,
    runId: options.runId,
    nodeId: options.node.id,
    traceType: "provider_response",
    ownerAgentId,
    ownerAgentName,
    ownerRole,
    providerVendor: options.provider.vendor,
    providerTransport: options.provider.transport,
    providerModel: options.provider.model,
    providerEffort: options.provider.effort ?? null,
    promptCountDelta: 0,
    exchangeCountDelta: 1,
    summary: `${options.node.title} produced a provider response.`,
    responseSummary: summarizeTraceText(options.response),
    responseRaw: options.response,
    outputSummary: summarizeTraceText(options.response),
    workstreamTitle: options.node.title,
    laneLabel: options.node.role,
    payload: {
      executor: options.node.executor,
      phase: options.node.phase ?? null
    }
  }).catch(() => undefined);
  if (responseTrace) {
    await appendTraceWorkspaceSignal(options.repoPath, options.workspaceId, responseTrace, "response.received").catch(() => undefined);
  }
  if (options.usage || typeof options.estimatedCost === "number") {
    const costTrace = await appendWorkItemTrace(options.repoPath, {
      workspaceId: options.workspaceId,
      workItemId,
      cycleId,
      workstreamId,
      taskId,
      runId: options.runId,
      nodeId: options.node.id,
      traceType: "cost_update",
      ownerAgentId,
      ownerAgentName,
      ownerRole,
      providerVendor: options.provider.vendor,
      providerTransport: options.provider.transport,
      providerModel: options.provider.model,
      providerEffort: options.provider.effort ?? null,
      promptCountDelta: 0,
      exchangeCountDelta: 0,
      inputTokens: options.usage?.prompt_tokens ?? null,
      outputTokens: options.usage?.completion_tokens ?? null,
      totalTokens: options.usage?.total_tokens ?? null,
      estimatedCostUsd: typeof options.estimatedCost === "number"
        ? Number(options.estimatedCost.toFixed(6))
        : null,
      summary: `${options.node.title} updated prompt cost and usage.`,
      workstreamTitle: options.node.title,
      laneLabel: options.node.role
    }).catch(() => undefined);
    if (costTrace) {
      await appendTraceWorkspaceSignal(options.repoPath, options.workspaceId, costTrace, "cost.updated").catch(() => undefined);
    }
  }
}

function summarizeTraceText(text: string, maxLength = 220): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 3).trim()}...`;
}

async function appendTraceWorkspaceSignal(
  repoPath: string,
  workspaceId: string,
  trace: {
    id: string;
    workItemId: string;
    cycleId?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    laneLabel?: string | null;
    ownerAgentId?: string | null;
    ownerAgentName?: string | null;
    assignmentToAgentId?: string | null;
    assignmentToAgentName?: string | null;
    providerModel?: string | null;
    estimatedCostUsd?: number | null;
    traceType: string;
    summary: string;
  },
  type: string
) {
  await appendWorkspaceSignal(repoPath, {
    workspaceId,
    source: "work",
    type,
    entityId: trace.id,
    status: "recorded",
    summary: trace.summary,
    payload: {
      workItemId: trace.workItemId,
      cycleId: trace.cycleId ?? null,
      workstreamId: trace.workstreamId ?? null,
      workstreamTitle: trace.workstreamTitle ?? null,
      laneLabel: trace.laneLabel ?? null,
      traceType: trace.traceType,
      ownerAgentId: trace.ownerAgentId ?? null,
      ownerAgentName: trace.ownerAgentName ?? null,
      assignmentToAgentId: trace.assignmentToAgentId ?? null,
      assignmentToAgentName: trace.assignmentToAgentName ?? null,
      providerModel: trace.providerModel ?? null,
      estimatedCostUsd: trace.estimatedCostUsd ?? null
    }
  });
}

async function finalizeMissionSignals(options: {
  runDir: string;
  repoPath: string;
  run: MissionRun;
  signals: MissionRuntimeSignals;
}) {
  if (!isTerminalMissionStatus(options.run.status)) return;
  if (options.signals.finalized) return;
  options.signals.finalized = true;

  const learnings = await buildRunLearnings({
    workspacePath: options.repoPath,
    runMeta: buildMissionRunState(options.run),
    runDir: options.runDir
  }).catch(() => []);
  await appendLearnings(options.repoPath, learnings).catch(() => undefined);
  const signalWorkspaceId = options.run.workspaceId ?? options.signals.workspaceId;
  await runPluginHook(options.signals.plugins, "onRunFinish", buildMissionRunState(options.run), {
    repoPath: options.repoPath,
    workspaceId: signalWorkspaceId,
    entityId: options.run.runId
  });
  await emitTelemetry({
    t: "mission.run.finished",
    ts: nowIso(),
    tier: options.signals.tier,
    run_kind: "mission",
    run_status: options.run.status,
    workspace_id: options.run.workspaceId,
    template_id: options.run.missionTemplateId,
    duration_ms: durationMs(options.run.start, options.run.end),
    total_tokens: options.run.totalTokens,
    total_cost: options.run.totalCost
  }, options.signals.telemetryConfig, { workspacePath: options.repoPath });
  await appendWorkspaceSignal(options.repoPath, {
    workspaceId: signalWorkspaceId,
    source: "mission",
    type: "mission.run.finished",
    entityId: options.run.runId,
    status: options.run.status,
    summary: `Mission finished with ${options.run.verdict ?? options.run.status}`,
    payload: {
      runId: options.run.runId,
      verdict: options.run.verdict,
      templateId: options.run.missionTemplateId
    }
  }).catch(() => undefined);
}

function isTerminalMissionStatus(status: MissionRun["status"]) {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}

function durationMs(start?: string | null, end?: string | null): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

function nowIso(): string {
  return new Date().toISOString();
}

function recalculateRunProgress(run: MissionRun): void {
  run.completedSteps = run.graph.nodes.filter((node) => node.status === "completed").length;
  run.totalSteps = run.graph.nodes.length;
}

function resolveMissionConcurrency(config: Awaited<ReturnType<typeof loadConfig>>): number {
  if (!config?.concurrency) return 1;
  if (typeof config.concurrency === "number") return config.concurrency;
  return config.concurrency.max_agents ?? 1;
}

async function isMissionNodeApproved(runDir: string, repoPath: string, node: MissionNode): Promise<boolean> {
  const localApproval = await readTextIfExists(path.join(runDir, "approvals", `${node.id}.approved`));
  if (localApproval) return true;
  return isWorkspaceApproved(repoPath, node.id, "diff");
}

function applyMissionStartOptions(
  config: Awaited<ReturnType<typeof loadConfig>>,
  runOptions?: StartMissionOptions["runOptions"]
) {
  if (!runOptions) return config;
  return {
    ...(config ?? {}),
    concurrency: runOptions.concurrency ?? config?.concurrency,
    strategy: {
      ...(config?.strategy ?? {}),
      ...(runOptions.strategyMode ? { mode: runOptions.strategyMode } : {})
    }
  };
}

function resolveRoleModelOverride(role: string, modelOverrides?: Record<string, string>): string | undefined {
  if (!modelOverrides) return undefined;
  const normalizedRole = role.trim().toLowerCase();
  return modelOverrides[normalizedRole] ?? modelOverrides[normalizedRole.split(/[^a-z]+/)[0] ?? ""];
}

function resolveRoleEffortOverride(role: string, effortOverrides?: Record<string, string>): MissionNode["effort"] | undefined {
  if (!effortOverrides) return undefined;
  const normalizedRole = role.trim().toLowerCase();
  const value = effortOverrides[normalizedRole] ?? effortOverrides[normalizedRole.split(/[^a-z]+/)[0] ?? ""];
  if (!value) return undefined;
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === "minimal"
    || normalizedValue === "low"
    || normalizedValue === "medium"
    || normalizedValue === "high"
    || normalizedValue === "max"
    ? normalizedValue
    : undefined;
}

function resolveMissionRoleModelOverrides(
  config: Awaited<ReturnType<typeof loadConfig>>,
  runtimeOverrides?: Record<string, string>
): Record<string, string> | undefined {
  const merged = new Map<string, string>();
  const ingest = (source?: Record<string, string> | null) => {
    if (!source) return;
    for (const [key, value] of Object.entries(source)) {
      const normalizedKey = key.trim().toLowerCase();
      const normalizedValue = value.trim();
      if (!normalizedKey || !normalizedValue) continue;
      if (isLegacyProviderAlias(normalizedValue)) continue;
      merged.set(normalizedKey, normalizedValue);
    }
  };
  ingest(config?.models ?? undefined);
  ingest(runtimeOverrides);
  return merged.size > 0 ? Object.fromEntries(merged.entries()) : undefined;
}

function resolveMissionRoleEffortOverrides(
  config: Awaited<ReturnType<typeof loadConfig>>,
  runtimeOverrides?: Record<string, string>
): Record<string, string> | undefined {
  const merged = new Map<string, string>();
  const ingest = (source?: Record<string, string> | null) => {
    if (!source) return;
    for (const [key, value] of Object.entries(source)) {
      const normalizedKey = key.trim().toLowerCase();
      const normalizedValue = resolveRoleEffortOverride(key, { [key]: value });
      if (!normalizedKey || !normalizedValue) continue;
      merged.set(normalizedKey, normalizedValue);
    }
  };
  ingest(config?.efforts as Record<string, string> | undefined);
  ingest(runtimeOverrides);
  return merged.size > 0 ? Object.fromEntries(merged.entries()) : undefined;
}

function isLegacyProviderAlias(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "codex"
    || normalized === "copilot"
    || normalized === "claude"
    || normalized === "cursor"
    || normalized === "openai"
    || normalized === "ollama"
    || normalized === "llama.cpp";
}

function missionNodeEventType(status: MissionNode["status"]): string {
  if (status === "completed") return "mission.node.completed";
  if (status === "blocked") return "mission.node.blocked";
  if (status === "waiting_input" || status === "awaiting_approval") return "mission.node.paused";
  return "mission.node.failed";
}

function firstPauseReason(nodes: MissionNode[]): "awaiting_input" | "awaiting_approval" | null {
  const awaitingApproval = nodes.find((node) => node.status === "awaiting_approval");
  if (awaitingApproval) return "awaiting_approval";
  const awaitingInput = nodes.find((node) => node.status === "waiting_input");
  if (awaitingInput) return "awaiting_input";
  return null;
}

function updateRunTruth(run: MissionRun): void {
  run.pauseReason = firstPauseReason(run.graph.nodes);
  const latestValidationNode = [...run.graph.nodes]
    .reverse()
    .find((node) => node.validation && node.validation.status !== "not_requested");
  run.validation = latestValidationNode?.validation ?? run.validation ?? { status: "not_requested", commands: [], results: [] };
  const latestChangedNode = [...run.graph.nodes]
    .reverse()
    .find((node) => node.change && node.change.status !== "none");
  run.change = latestChangedNode?.change ?? run.change ?? { status: "none" };
  if (run.status === "failed") {
    run.verdict = "failed";
    return;
  }
  if (run.status === "blocked") {
    run.verdict = "blocked";
    return;
  }
  if (run.status === "paused") {
    run.verdict = "needs_human_review";
    return;
  }
  if (run.status === "completed") {
    if (run.validation?.status === "passed" && (run.change?.status === "validated" || run.change?.status === "none")) {
      run.verdict = "ready_to_merge";
    } else if (run.change?.status === "applied" || run.change?.status === "generated") {
      run.verdict = "ready_for_review";
    } else {
      run.verdict = "ready_for_review";
    }
    return;
  }
  run.verdict = "running";
}

function optionsRepoExecutionProtectedPaths(run: MissionRun): string[] {
  return run.profile?.repo_execution?.protected_paths ?? [];
}

function findProtectedPaths(diffText: string, protectedPaths: string[]): string[] {
  if (protectedPaths.length === 0) return [];
  const touchedFiles = Array.from(new Set(
    diffText
      .split(/\r?\n/)
      .map((line) => line.match(/^\+\+\+ b\/(.+)$/)?.[1] ?? line.match(/^--- a\/(.+)$/)?.[1] ?? null)
      .filter((value): value is string => Boolean(value) && value !== "/dev/null")
  ));
  return touchedFiles.filter((file) => protectedPaths.some((protectedPath) => file === protectedPath || file.startsWith(`${protectedPath}/`)));
}

function syncPatchValidationState(run: MissionRun, node: MissionNode, validation: NonNullable<MissionNode["validation"]>): void {
  for (const dependencyId of node.dependsOn) {
    const dependency = run.graph.nodes.find((candidate) => candidate.id === dependencyId);
    if (!dependency || dependency.executor !== "patch") continue;
    dependency.validation = validation;
    dependency.change = dependency.change ?? { status: "none" };
    dependency.change.status = validation.status === "passed" ? "validated" : "validation_failed";
    dependency.verdict = validation.status === "passed" ? "ready_to_merge" : "blocked";
  }
}
