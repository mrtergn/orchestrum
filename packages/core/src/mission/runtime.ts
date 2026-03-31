import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonIfExists, readTextIfExists, safeRunId, writeJson, writeText, appendLine } from "../runner/fs.js";
import { applyPatch, gitDiff } from "../runner/git.js";
import { loadConfig } from "../runner/config.js";
import { estimateCostUsd, normalizeUsage, resolvePricing } from "../runner/cost.js";
import { createApprovalToken, isWorkspaceApproved, writeApprovalRequest } from "../runner/approvals.js";
import { loadRepoExecutionProfile, runValidationSuite } from "../runner/repoExecution.js";
import { applyDerivedSessionState } from "../delivery/sessionState.js";
import { createRemediationTasks, extractFindingsFromImport, resolvePacketCompletionStatus } from "../delivery/triage.js";
import { buildRemediationPacket } from "../delivery/workPackets.js";
import { createDefaultTeamPreset, type DeliverySessionState, type PacketExport, type PacketImport, type WorkPacket } from "../delivery/types.js";
import { requiresApproval, scanDiff, summarizeFindings } from "../security/safety.js";
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
    strategyMode?: string;
  };
  onEvent?: EventHandler;
};

type ResumeMissionOptions = {
  runsDir: string;
  workspaceId?: string;
  runId: string;
  agents: MissionAgent[];
  onEvent?: EventHandler;
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
  const profile = await loadRepoExecutionProfile(options.repoPath, config).catch(() => null);
  const graph = createMissionGraph(template, options.agents, options.runOptions?.modelOverrides);
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
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "blocked") {
    return { ok: run.status === "completed", runId: run.runId, runDir, run };
  }
  run.status = "running";
  run.end = null;
  run.pauseReason = null;
  run.verdict = "running";
  await persistMissionRun(runDir, run);
  await emitMissionEvent(runDir, {
    t: "mission.resumed",
    runId: run.runId,
    ts: Date.now()
  }, options.onEvent);
  return continueMissionRun({
    runDir,
    repoPath: run.repoPath,
    config: await loadConfig(run.repoPath).catch(() => null),
    run,
    onEvent: options.onEvent
  });
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
      node.status = "failed";
      node.error = message;
      node.change = {
        status: "apply_failed",
        diffArtifact: "external_patch.diff",
        applyError: message,
        source: "external"
      };
      node.verdict = "failed";
      node.artifacts = upsertArtifacts(node.artifacts, [
        await writeArtifact(nodeDir, "apply-error.txt", message)
      ]);
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
  } else if (node.status === "failed") {
    run.status = "failed";
    run.end = nowIso();
  } else {
    run.status = "running";
    run.end = null;
  }
  updateRunTruth(run);
  await persistMissionRun(runDir, run);
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

  try {
    const result = await runMissionNodeExecutor({
      runDir: options.runDir,
      repoPath: options.repoPath,
      config: options.config,
      run: options.run,
      node
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
  return options.run;
}

async function runMissionNodeExecutor(options: {
  runDir: string;
  repoPath: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  run: MissionRun;
  node: MissionNode;
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
  const usage = normalizeUsage(result.usage ?? null);
  if (usage) {
    options.run.totalTokens = (options.run.totalTokens ?? 0) + usage.total_tokens;
    const pricing = resolvePricing(options.config, model);
    const cost = estimateCostUsd(usage, pricing);
    if (typeof cost === "number") {
      options.run.totalCost = Number(((options.run.totalCost ?? 0) + cost).toFixed(6));
    }
  }

  if (options.node.executor === "audit") {
    return executeAuditNode(options.runDir, options.node, result.text, result);
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
  node: MissionNode,
  outputText: string,
  execution: Awaited<ReturnType<typeof completeWithProvider>>
): Promise<NodeExecutorResult> {
  const nodeDir = getNodeDir(runDir, node.id);
  const parsed = parseAuditOutput(outputText);
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
    usage: execution.usage ?? null
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
        verdict: "failed",
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
      node.status = "failed";
      node.error = message;
      node.change = {
        status: "apply_failed",
        diffArtifact: "pending.diff",
        applyError: message,
        source: "provider"
      };
      node.end = nowIso();
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
  const inputs = await resolveMissionInputs(runDir, repoPath, run, node.inputs ?? []);
  return renderPrompt(template, inputs);
}

async function resolveMissionInputs(
  runDir: string,
  repoPath: string,
  run: MissionRun,
  refs: MissionInputRef[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const ref of refs) {
    if (ref === "goal") {
      result.goal = run.goal ?? run.userGoal ?? "";
      continue;
    }
    if (ref === "repo_context") {
      result.repo_context = await buildRepoContext(repoPath);
      continue;
    }
    if (ref === "git_diff") {
      result.git_diff = await gitDiff(repoPath).catch(() => "(git diff unavailable)");
      continue;
    }
    if (ref.startsWith("artifact:")) {
      const [, nodeId, fileName] = ref.split(":");
      if (!nodeId || !fileName) {
        result[ref] = `(invalid artifact ref: ${ref})`;
        continue;
      }
      const content = await readTextIfExists(path.join(getNodeDir(runDir, nodeId), fileName));
      result[`${nodeId}.${fileName}`] = content ?? `(missing artifact: ${nodeId}/${fileName})`;
      continue;
    }
    if (ref.startsWith("literal:")) {
      result.literal = ref.slice("literal:".length);
    }
  }
  return result;
}

function renderPrompt(template: string, inputs: Record<string, string>): string {
  const sections = Object.entries(inputs)
    .map(([key, value]) => `## ${key}\n${value}`)
    .join("\n\n");
  if (!sections) return template.trim();
  return `${template.trim()}\n\n# Inputs\n${sections}`.trim();
}

async function buildRepoContext(repoPath: string): Promise<string> {
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

async function collectRepoFiles(rootDir: string, currentDir: string, result: string[]): Promise<void> {
  if (result.length >= 80) return;
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (result.length >= 80) return;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "runs") continue;
    if (entry.name === ".orchestrum" && currentDir === rootDir) continue;
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath) || entry.name;
    if (entry.isDirectory()) {
      await collectRepoFiles(rootDir, fullPath, result);
      continue;
    }
    result.push(relPath);
  }
}

function createMissionGraph(
  template: ReturnType<typeof loadMissionTemplate>,
  agents: MissionAgent[],
  modelOverrides?: Record<string, string>
): MissionGraph {
  const missingRoles = new Set<string>();
  const nodes = template.nodes.map((definition) => {
    const agent = resolveMissionAgent(definition.role, agents);
    if (!agent) missingRoles.add(definition.role);
    const providerConfig = normalizeMissionProvider(agent?.provider ?? {}, definition.role);
    const roleOverride = resolveRoleModelOverride(definition.role, modelOverrides);
    if (roleOverride) {
      providerConfig.modelOverride = roleOverride;
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
    const agent = resolveMissionAgent(node.role, agents);
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

function resolveMissionAgent(role: string, agents: MissionAgent[]): MissionAgent | null {
  const needle = role.trim().toLowerCase();
  return agents.find((agent) => {
    const agentRole = agent.role.trim().toLowerCase();
    if (agentRole === needle || agentRole.includes(needle)) return true;
    return (agent.tags ?? []).some((tag) => tag.trim().toLowerCase() === needle);
  }) ?? null;
}

async function persistMissionRun(runDir: string, run: MissionRun): Promise<void> {
  run.graph.nodes.sort((a, b) => a.id.localeCompare(b.id));
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
  const inputs = await resolveMissionInputs(runDir, repoPath, run, node.inputs ?? []);
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

function parseAuditOutput(outputText: string): {
  blocking: boolean;
  issues: Array<{ severity: string; file: string; line: number | null; message: string }>;
  suggested_fix?: string;
} {
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

function mapMissionNodeStatusToStepStatus(status: MissionNode["status"]): string {
  if (status === "awaiting_approval" || status === "waiting_input") return "paused";
  return status;
}

function getNodeDir(runDir: string, nodeId: string): string {
  return path.join(runDir, "nodes", nodeId);
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
