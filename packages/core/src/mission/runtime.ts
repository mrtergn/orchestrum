import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonIfExists, readTextIfExists, safeRunId, writeJson, writeText, appendLine } from "../runner/fs.js";
import { applyPatch, gitDiff } from "../runner/git.js";
import { loadConfig } from "../runner/config.js";
import { estimateCostUsd, normalizeUsage, resolvePricing } from "../runner/cost.js";
import { createApprovalToken, isWorkspaceApproved, writeApprovalRequest } from "../runner/approvals.js";
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
  const graph = createMissionGraph(template, options.agents);
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
    workflow: template.id,
    missionTemplateId: template.id,
    totalSteps: graph.nodes.length,
    completedSteps: 0,
    totalTokens: 0,
    totalCost: 0,
    graph
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
  if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
    return { ok: run.status === "finished", runId: run.runId, runDir, run };
  }
  run.status = "running";
  run.end = null;
  await persistMissionRun(runDir, run);
  await emitMissionEvent(runDir, {
    t: "mission.resumed",
    runId: run.runId,
    ts: Date.now()
  }, options.onEvent);
  return continueMissionRun({
    runDir,
    repoPath: run.repoPath,
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
  node.artifacts = upsertArtifacts(node.artifacts, artifacts);
  node.findingCount = findings.length;
  node.status = blocked ? "blocked" : "completed";
  node.error = blocked ? summary || "Delivery import marked as blocked." : null;
  node.end = nowIso();

  recalculateRunProgress(run);
  if (blocked) {
    run.status = "failed";
    run.end = nowIso();
  }
  await persistMissionRun(runDir, run);
  await emitMissionEvent(runDir, {
    t: "mission.node.imported",
    runId: run.runId,
    nodeId: node.id,
    blocked,
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
    model: node.model ?? null
  }));
}

async function continueMissionRun(options: {
  runDir: string;
  repoPath: string;
  run: MissionRun;
  onEvent?: EventHandler;
}): Promise<MissionRunResult> {
  const config = await loadConfig(options.repoPath).catch(() => null);
  const concurrency = Math.max(1, resolveMissionConcurrency(config));
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
          config,
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
      const hasFailure = run.graph.nodes.some((node) => node.status === "failed" || node.status === "blocked");
      const allComplete = run.graph.nodes.every((node) => node.status === "completed");
      if (allComplete) {
        run.status = "finished";
        run.end = nowIso();
      } else if (hasFailure) {
        run.status = "failed";
        run.end = nowIso();
      } else if (hasPausedNode) {
        paused = true;
      }
      break;
    }

    for (const node of readyNodes.slice(0, concurrency)) {
      run = await executeMissionNode({
        runDir: options.runDir,
        repoPath: options.repoPath,
        config,
        run,
        nodeId: node.id,
        onEvent: options.onEvent
      });
      if (run.status !== "running") break;
    }
  }

  recalculateRunProgress(run);
  await persistMissionRun(options.runDir, run);
  await emitMissionEvent(options.runDir, {
    t: "mission.state",
    runId: run.runId,
    status: run.status,
    paused,
    completedSteps: run.completedSteps ?? 0,
    totalSteps: run.totalSteps ?? 0,
    ts: Date.now()
  }, options.onEvent);

  return {
    ok: run.status === "finished",
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
    await writeNodeStatus(nodeDir, node);
    await persistMissionRun(options.runDir, options.run);
    await emitMissionEvent(options.runDir, {
      t: "mission.node.waiting_input",
      runId: options.run.runId,
      nodeId: node.id,
      ts: Date.now()
    }, options.onEvent);
    return options.run;
  }

  node.status = "running";
  node.start = nowIso();
  node.end = undefined;
  node.error = null;
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
    if (result.waitingForInput) {
      node.status = "waiting_input";
      node.end = undefined;
    } else if (result.approval) {
      node.status = "awaiting_approval";
      node.end = undefined;
    } else if (result.blocked) {
      node.status = "blocked";
      node.end = nowIso();
      node.error = "Blocking mission feedback received.";
    } else {
      node.status = "completed";
      node.end = nowIso();
    }
  } catch (err) {
    node.status = "failed";
    node.end = nowIso();
    node.error = err instanceof Error ? err.message : String(err);
  }

  recalculateRunProgress(options.run);
  await writeNodeStatus(nodeDir, node);
  await persistMissionRun(options.runDir, options.run);
  await emitMissionEvent(options.runDir, {
    t: node.status === "completed" ? "mission.node.completed" : "mission.node.failed",
    runId: options.run.runId,
    nodeId: node.id,
    status: node.status,
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
    usage: result.usage ?? null
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
  return {
    outputText: packetText,
    artifacts: [
      await writeArtifact(nodeDir, "packet.md", packetText),
      await writeArtifact(nodeDir, "packet.json", JSON.stringify(packetJson, null, 2), "application/json")
    ]
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
  const alreadyApproved = node.approval?.status === "approved" || await isMissionNodeApproved(runDir, repoPath, node);
  if (node.approval?.status === "pending" && alreadyApproved) {
    node.approval.status = "approved";
  }
  if (requiresApproval(findings) && !alreadyApproved) {
    const token = createApprovalToken();
    const approval: MissionApprovalGate = {
      token,
      kind: "diff",
      reason: summarizeFindings(findings),
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
      usage: execution.usage ?? null
    };
  }

  if (!execution.nativeWrite) {
    await applyPatch(repoPath, diffText);
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
    usage: execution.usage ?? null
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
    await applyPatch(repoPath, diffText);
  }
  node.approval = node.approval ? { ...node.approval, status: "approved" } : null;
  node.status = "completed";
  node.end = nowIso();
  node.error = null;
  node.artifacts = upsertArtifacts(node.artifacts, [
    await writeArtifact(nodeDir, "post-apply.diff", await gitDiff(repoPath).catch(() => diffText), "text/x-diff")
  ]);
  recalculateRunProgress(run);
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

function createMissionGraph(template: ReturnType<typeof loadMissionTemplate>, agents: MissionAgent[]): MissionGraph {
  const missingRoles = new Set<string>();
  const nodes = template.nodes.map((definition) => {
    const agent = resolveMissionAgent(definition.role, agents);
    if (!agent) missingRoles.add(definition.role);
    const providerConfig = normalizeMissionProvider(agent?.provider ?? {}, definition.role);
    return {
      id: definition.id,
      title: definition.title,
      role: definition.role,
      executor: definition.executor,
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
      targetTool: definition.targetTool,
      approval: null,
      artifacts: [],
      error: null
    };
  });

  if (missingRoles.size > 0) {
    throw new Error(`Missing mission agents for roles: ${[...missingRoles].join(", ")}`);
  }

  return {
    templateId: template.id,
    name: template.name,
    description: template.description,
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
    model: node.model ?? null
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
  if (status === "awaiting_approval" || status === "waiting_input") return "running";
  if (status === "blocked") return "failed";
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
