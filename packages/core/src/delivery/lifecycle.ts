import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, appendLine, readJsonIfExists, safeRunId, writeJson, writeText } from "../runner/fs.js";
import { lookupBinary } from "../runner/bin.js";
import { loadConfig } from "../runner/config.js";
import { formatLearningsForContext, loadRelevantLearnings } from "../runner/learnings.js";
import { prepareWorktreeContext } from "../runner/worktrees.js";
import { runCommands } from "../runner/commands.js";
import {
  appendGovernanceEvent,
  resolveGovernanceSettings,
  scanGovernedCommands
} from "../runner/governance.js";
import { computeReleaseReadiness } from "../release/readiness.js";
import type { RunState } from "../runner/types.js";
import {
  CapabilityDiscoveryResultSchema,
  DeliverySessionRequestSchema,
  DeliverySessionStateSchema,
  type CapabilityDiscoveryResult,
  type DeliveryImportAnalysis,
  type DeliverySessionRequest,
  type DeliverySessionState,
  type DeliverySummary,
  type EvidenceRecord,
  type DeliveryTargetTool,
  type DeliveryTextVariant,
  type MachineCapability,
  type PacketExport,
  type PacketImport,
  type RemediationTask,
  type ReviewFinding,
  type RoleBinding,
  type TeamPreset,
  type TeamPresetResponse,
  type WorkPacket
} from "./types.js";
import {
  accumulateDeliverySummary,
  applyDerivedSessionState,
  createEmptyDeliverySummary
} from "./sessionState.js";
import {
  createRemediationTasks,
  extractFindingsFromImport,
  parseExplicitStatus,
  resolvePacketCompletionStatus
} from "./triage.js";
import { summarizeImport } from "./importSignals.js";
import { resolveImportPacket } from "./importMatching.js";
import {
  buildInitialPackets,
  buildRemediationPacket,
  createScaffoldTeamPreset,
  getCurrentBranch,
  loadRepoScripts,
  loadSelectedPathNotes
} from "./workPackets.js";

const TEAM_PRESET_RELATIVE_PATH = path.join(".orchestrum", "team-preset.json");
const DELIVERY_DIRNAME = "delivery";
const SESSION_FILE = "session.json";

type DeliveryRunOptions = DeliverySessionRequest & {
  repoPath: string;
  runsDir: string;
  preset?: TeamPreset | null;
  roleBindings?: RoleBinding[];
};

type PacketImportOptions = {
  runsDir: string;
  runId: string;
  workspaceId?: string;
  packetId?: string;
  text?: string;
  filePath?: string;
  fileName?: string;
  source?: "paste" | "file" | "auto_cli";
  targetTool?: DeliveryTargetTool;
};

export type DeliveryImportResult = {
  packet: WorkPacket;
  importRecord: PacketImport;
  findings: ReviewFinding[];
  remediations: RemediationTask[];
  session: DeliverySessionState;
};

type DeliveryToolProfile = {
  id: DeliveryTargetTool;
  label: string;
  textVariant: DeliveryTextVariant;
  guidance: string[];
  responseContract: string[];
};

const BUILTIN_TOOL_PROFILES: Record<DeliveryTargetTool, DeliveryToolProfile> = {
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    textVariant: "browser_prompt",
    guidance: [
      "Treat this as a browser handoff packet for ChatGPT.",
      "Stay within the repo context and scoped files.",
      "If you are blocked, say exactly what is missing instead of guessing."
    ],
    responseContract: [
      "Status: completed|blocked",
      "Summary: <one concise paragraph>",
      "Findings:",
      "- [category|severity] title :: summary",
      "Files:",
      "- path/to/file"
    ]
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    textVariant: "ide_task",
    guidance: [
      "Treat this as an IDE implementation task for Cursor.",
      "Prefer precise file scope, concrete edits, and brief verification notes.",
      "Call out any repo commands that should be run locally after the change."
    ],
    responseContract: [
      "Status: completed|blocked",
      "Summary: <what changed or what blocked progress>",
      "Changed Files:",
      "- path/to/file",
      "Verification:",
      "- command or check",
      "Findings:",
      "- [category|severity] title :: summary"
    ]
  },
  codex: {
    id: "codex",
    label: "Codex",
    textVariant: "patch_brief",
    guidance: [
      "Treat this as a patch-plus-verification brief for Codex.",
      "Prefer minimal, defensible diffs over speculative rewrites.",
      "Report exact verification commands or explain what could not be verified."
    ],
    responseContract: [
      "Status: completed|blocked",
      "Summary: <patch summary>",
      "Changed Files:",
      "- path/to/file",
      "Verification:",
      "- command :: result",
      "Findings:",
      "- [category|severity] title :: summary"
    ]
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    textVariant: "ide_task",
    guidance: [
      "Treat this as an editor-assist task for Copilot.",
      "Keep the scope narrow and align with existing patterns in the selected files.",
      "If the repo context is insufficient, surface the gap explicitly."
    ],
    responseContract: [
      "Status: completed|blocked",
      "Summary: <what was implemented>",
      "Changed Files:",
      "- path/to/file",
      "Next Checks:",
      "- command or manual validation",
      "Findings:",
      "- [category|severity] title :: summary"
    ]
  },
  claude: {
    id: "claude",
    label: "Claude",
    textVariant: "review_prompt",
    guidance: [
      "Treat this as a review or audit packet for Claude.",
      "Lead with concrete findings ordered by severity.",
      "Separate blockers from follow-ups and note missing validation."
    ],
    responseContract: [
      "Status: completed|blocked",
      "Summary: <review summary>",
      "Findings:",
      "- [category|severity] title :: summary",
      "Files:",
      "- path/to/file",
      "Follow Up:",
      "- optional next step"
    ]
  }
};

export function getTeamPresetPath(repoPath: string): string {
  return path.join(repoPath, TEAM_PRESET_RELATIVE_PATH);
}

export async function loadTeamPreset(repoPath: string): Promise<TeamPreset | null> {
  const preset = await readJsonIfExists<unknown>(getTeamPresetPath(repoPath));
  if (!preset) return null;
  return CapabilityDiscoveryResultSchema.shape.scaffoldPreset.parse(preset);
}

export async function saveTeamPreset(repoPath: string, preset: TeamPreset): Promise<TeamPreset> {
  const parsed = CapabilityDiscoveryResultSchema.shape.scaffoldPreset.parse(preset);
  await ensureDir(path.dirname(getTeamPresetPath(repoPath)));
  await writeJson(getTeamPresetPath(repoPath), parsed);
  return parsed;
}

export async function discoverDeliverySetup(options: {
  repoPath: string;
  workspaceId?: string;
}): Promise<CapabilityDiscoveryResult> {
  const capabilities = await detectMachineCapabilities(options.repoPath);
  const preset = await loadTeamPreset(options.repoPath).catch(() => null);
  const scaffoldPreset = createScaffoldTeamPreset(capabilities);
  const basePreset = preset ?? scaffoldPreset;
  const suggestedBindings = suggestRoleBindings(basePreset, capabilities);
  return CapabilityDiscoveryResultSchema.parse({
    workspaceId: options.workspaceId,
    repoPath: options.repoPath,
    preset,
    scaffoldPreset,
    capabilities,
    suggestedBindings
  });
}

export async function initTeamPreset(options: {
  repoPath: string;
  workspaceId?: string;
  force?: boolean;
}): Promise<TeamPresetResponse> {
  const discovered = await discoverDeliverySetup(options);
  const targetPreset = discovered.preset && !options.force ? discovered.preset : discovered.scaffoldPreset;
  await saveTeamPreset(options.repoPath, targetPreset);
  return {
    workspaceId: options.workspaceId,
    repoPath: options.repoPath,
    path: getTeamPresetPath(options.repoPath),
    preset: targetPreset,
    scaffoldPreset: discovered.scaffoldPreset,
    capabilities: discovered.capabilities,
    suggestedBindings: discovered.suggestedBindings
  };
}

export async function detectMachineCapabilities(repoPath: string): Promise<MachineCapability[]> {
  const now = new Date().toISOString();
  const binaries = await Promise.all(
    ["git", "node", "npm", "pnpm", "yarn", "gh", "codex", "claude", "cursor", "code"].map(async (name) => {
      const result = await lookupBinary(name);
      return {
        id: `binary:${name}`,
        kind: "binary" as const,
        label: name,
        available: result.available,
        command: result.path,
        details: result.available ? result.path : `${name} not found on PATH`,
        source: "path" as const,
        detectedAt: now
      };
    })
  );
  const packageScripts = await loadRepoScripts(repoPath);
  const scriptCaps = packageScripts.names.map((name) => ({
    id: `script:${name}`,
    kind: "repo_script" as const,
    label: `script:${name}`,
    available: true,
    command: packageScripts.packageManagerCommand(name),
    details: `Repo script "${name}" from package.json`,
    source: "repo" as const,
    detectedAt: now
  }));
  const ideAvailable = binaries.some((cap) => cap.available && ["binary:cursor", "binary:code", "binary:codex"].includes(cap.id));
  return [
    ...binaries,
    {
      id: "handoff:browser",
      kind: "browser_handoff",
      label: "Browser handoff",
      available: true,
      details: "Prompt packets can be copied to browser-based AI tools.",
      source: "builtin",
      detectedAt: now
    },
    {
      id: "handoff:ide",
      kind: "ide_handoff",
      label: "IDE handoff",
      available: ideAvailable,
      details: ideAvailable ? "IDE-based AI tooling detected." : "No IDE-integrated AI tooling detected on PATH.",
      source: "builtin",
      detectedAt: now
    },
    ...scriptCaps
  ];
}

export function suggestRoleBindings(preset: TeamPreset, capabilities: MachineCapability[]): RoleBinding[] {
  const capabilityMap = new Map(capabilities.map((cap) => [cap.id, cap]));
  const toolPreferenceMap = preset.tool_preferences ?? {};
  return preset.roles.map((role) => {
    const preferredTargets = toolPreferenceMap[role.id] ?? role.preferred_targets ?? [];
    if (role.mode === "disabled") {
      return {
        roleId: role.id,
        mode: "disabled",
        target: "disabled",
        capabilityIds: [],
        available: false,
        reason: "Role disabled by team preset.",
        confirmed: false
      };
    }
    if (role.mode === "auto_cli") {
      const scriptCaps = capabilities.filter((cap) => cap.kind === "repo_script" && ["script:typecheck", "script:test", "script:lint", "script:build"].includes(cap.id));
      const shellCap = capabilityMap.get("binary:npm") ?? capabilityMap.get("binary:pnpm") ?? capabilityMap.get("binary:yarn");
      return {
        roleId: role.id,
        mode: role.mode,
        target: shellCap?.available ? shellCap.label : "local-shell",
        capabilityIds: [
          ...(shellCap ? [shellCap.id] : []),
          ...scriptCaps.map((cap) => cap.id)
        ],
        available: Boolean(shellCap?.available) || scriptCaps.length > 0,
        reason:
          scriptCaps.length > 0
            ? `Suggested local validation via ${scriptCaps.map((cap) => cap.label.replace("script:", "")).join(", ")}.`
            : "Suggested local shell execution if commands are provided later.",
        confirmed: false
      };
    }
    if (role.mode === "manual_ide") {
      const target = preferredTargets.find((value) => capabilityMap.get(`binary:${value}`)?.available)
        ?? (capabilityMap.get("binary:cursor")?.available ? "cursor" : capabilityMap.get("binary:code")?.available ? "code" : capabilityMap.get("binary:codex")?.available ? "codex" : "manual-ide");
      const available = Boolean(capabilityMap.get(`binary:${target}`)?.available || capabilityMap.get("handoff:ide")?.available);
      return {
        roleId: role.id,
        mode: role.mode,
        target,
        capabilityIds: [
          ...(capabilityMap.get("handoff:ide") ? ["handoff:ide"] : []),
          ...(capabilityMap.get(`binary:${target}`) ? [`binary:${target}`] : [])
        ],
        available,
        reason: available ? `Suggested IDE handoff target: ${target}.` : "No IDE-capable handoff target was detected.",
        confirmed: false
      };
    }
    const target = preferredTargets[0] ?? "chatgpt";
    return {
      roleId: role.id,
      mode: role.mode,
      target,
      capabilityIds: ["handoff:browser"],
      available: true,
      reason: `Suggested browser handoff target: ${target}.`,
      confirmed: false
    };
  });
}

export async function runDeliverySessionDetailed(options: DeliveryRunOptions): Promise<{
  ok: boolean;
  runId: string;
  runDir: string;
  session: DeliverySessionState;
}> {
  const request = DeliverySessionRequestSchema.parse(options);
  const runId = safeRunId(request.runId ?? `delivery-${Date.now()}`);
  const runDir = path.join(options.runsDir, request.workspaceId, runId);
  await ensureDir(runDir);
  await ensureDir(getDeliveryDir(runDir));
  await ensureDir(path.join(getDeliveryDir(runDir), "exports"));
  await ensureDir(path.join(getDeliveryDir(runDir), "imports"));
  await ensureDir(path.join(runDir, "logs"));
  await writeText(path.join(runDir, "events.ndjson"), "");

  const discovered = await discoverDeliverySetup({
    repoPath: options.repoPath,
    workspaceId: request.workspaceId
  });
  const preset = options.preset ? CapabilityDiscoveryResultSchema.shape.scaffoldPreset.parse(options.preset) : (discovered.preset ?? discovered.scaffoldPreset);
  const roleBindings = (options.roleBindings ?? discovered.suggestedBindings).map((binding) => ({
    ...binding,
    confirmed: binding.confirmed ?? true
  }));
  const config = await loadConfig(options.repoPath);
  const worktree = await prepareWorktreeContext({
    repoPath: options.repoPath,
    workspaceId: request.workspaceId,
    runId,
    mode: config?.execution?.mode
  });
  const context = await buildRepoContext({
    repoPath: options.repoPath,
    workspaceId: request.workspaceId,
    runsDir: options.runsDir,
    goal: request.goal,
    selectedPaths: request.selectedPaths ?? []
  });

  const packets = buildInitialPackets({
    runId,
    workspaceId: request.workspaceId,
    repoPath: worktree.repoPath,
    goal: request.goal,
    sprintName: request.sprintName,
    selectedPaths: request.selectedPaths ?? [],
    notes: request.notes,
    preset,
    roleBindings,
    context
  });

  const now = new Date().toISOString();
  const sessionBase: DeliverySessionState = DeliverySessionStateSchema.parse({
    runId,
    workspaceId: request.workspaceId,
    repoPath: options.repoPath,
    goal: request.goal,
    sprintName: request.sprintName,
    notes: request.notes,
    selectedPaths: request.selectedPaths ?? [],
    status: "running",
    preset,
    capabilities: discovered.capabilities,
    roleBindings,
    packets,
    exports: [],
    imports: [],
    findings: [],
    remediations: [],
    evidence: [],
    outputs: {
      completedPacketIds: [],
      openFindingIds: [],
      resolvedFindingIds: [],
      suggestedCommitScope: request.selectedPaths ?? [],
      humanActionItems: []
    },
    worktreePath: worktree.worktreePath,
    createdAt: now,
    updatedAt: now
  });

  const session = appendEvidence(sessionBase, {
    id: crypto.randomUUID(),
    sessionId: runId,
    kind: "session_started",
    actor: "system",
    source: "delivery",
    summary: `Delivery session started for ${request.goal}.`,
    createdAt: now,
    data: {
      workspaceId: request.workspaceId,
      repoPath: options.repoPath
    }
  });
  for (const packet of session.packets) {
    session.evidence.push({
      id: crypto.randomUUID(),
      sessionId: runId,
      packetId: packet.id,
      kind: "packet_created",
      actor: "system",
      roleId: packet.roleId,
      source: "delivery",
      summary: `Created ${packet.roleId} packet ${packet.id}.`,
      createdAt: now,
      data: {
        mode: packet.mode,
        target: packet.target
      }
    });
  }
  applyDerivedSessionState(session);
  await persistDeliverySession(runDir, session);
  await writeRunMeta(runDir, session, {
    repoPath: options.repoPath,
    worktreePath: worktree.worktreePath
  });

  for (const packet of session.packets.filter((item) => item.mode === "auto_cli")) {
    await executeAutoCliPacket({
      repoPath: options.repoPath,
      runDir,
      packetId: packet.id
    });
  }

  const finalSession = (await loadDeliverySession({
    runsDir: options.runsDir,
    runId,
    workspaceId: request.workspaceId
  }))!;

  return {
    ok: true,
    runId,
    runDir,
    session: finalSession
  };
}

export async function runDeliverySession(options: DeliveryRunOptions): Promise<boolean> {
  const result = await runDeliverySessionDetailed(options);
  return result.ok;
}

export async function loadDeliverySession(options: {
  runsDir: string;
  runId: string;
  workspaceId?: string;
}): Promise<DeliverySessionState | null> {
  const runDir = await resolveRunDir(options.runsDir, options.runId, options.workspaceId);
  if (!runDir) return null;
  return loadSessionByRunDir(runDir);
}

export async function listDeliveryPackets(options: {
  runsDir: string;
  runId: string;
  workspaceId?: string;
}): Promise<WorkPacket[]> {
  const session = await loadDeliverySession(options);
  return session?.packets ?? [];
}

export async function loadDeliveryFindings(options: {
  runsDir: string;
  runId: string;
  workspaceId?: string;
}): Promise<ReviewFinding[]> {
  const session = await loadDeliverySession(options);
  return session?.findings ?? [];
}

export async function loadDeliveryRemediations(options: {
  runsDir: string;
  runId: string;
  workspaceId?: string;
}): Promise<RemediationTask[]> {
  const session = await loadDeliverySession(options);
  return session?.remediations ?? [];
}

export async function summarizeDeliverySessions(options: {
  runsDir: string;
  workspaceId?: string;
}): Promise<DeliverySummary> {
  const sessions = await listAllDeliverySessions(options.runsDir, options.workspaceId);
  const summary = createEmptyDeliverySummary(options.workspaceId);
  summary.latestRunId = sessions[0]?.runId ?? null;
  for (const session of sessions) {
    accumulateDeliverySummary(summary, session);
  }

  return summary;
}

export async function exportDeliveryPacket(options: {
  runsDir: string;
  runId: string;
  packetId: string;
  targetTool: DeliveryTargetTool;
  workspaceId?: string;
}): Promise<PacketExport> {
  const runDir = await resolveRunDir(options.runsDir, options.runId, options.workspaceId);
  if (!runDir) throw new Error("Delivery session not found.");
  const session = await loadSessionByRunDir(runDir);
  if (!session) throw new Error("Delivery session is missing.");
  const packet = session.packets.find((item) => item.id === options.packetId);
  if (!packet) throw new Error("Packet not found.");
  const createdAt = new Date().toISOString();
  const renderedText = renderPacketMarkdown(session, packet, options.targetTool);
  const toolProfile = resolveToolProfile(session, options.targetTool);
  const exportRecord: PacketExport = {
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    format: "markdown+json",
    targetTool: options.targetTool,
    textVariant: toolProfile.textVariant,
    renderedText,
    markdown: renderedText,
    sidecar: {
      sessionId: session.runId,
      packetId: packet.id,
      roleId: packet.roleId,
      target: packet.target,
      targetTool: options.targetTool,
      mode: packet.mode,
      goal: session.goal,
      sprintName: session.sprintName,
      acceptanceCriteria: packet.acceptanceCriteria,
      expectedOutput: packet.expectedOutput,
      selectedPaths: packet.selectedPaths,
      contextNotes: packet.contextNotes
    },
    fileNameBase: `${session.runId}-${packet.id}-${options.targetTool}`,
    createdAt
  };
  await writeText(path.join(getDeliveryDir(runDir), "exports", `${exportRecord.fileNameBase}.md`), exportRecord.markdown);
  await writeText(path.join(getDeliveryDir(runDir), "exports", `${exportRecord.fileNameBase}.txt`), exportRecord.renderedText);
  await writeJson(path.join(getDeliveryDir(runDir), "exports", `${exportRecord.fileNameBase}.json`), exportRecord.sidecar);
  session.exports.unshift(exportRecord);
  packet.lastExportId = exportRecord.id;
  packet.updatedAt = createdAt;
  if (packet.mode !== "auto_cli" && packet.status !== "completed") {
    packet.status = "awaiting_import";
  }
  session.updatedAt = createdAt;
  session.evidence.push({
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    kind: "packet_exported",
    actor: "user",
    roleId: packet.roleId,
    source: "delivery",
    summary: `Exported packet ${packet.id} for ${options.targetTool}.`,
    createdAt,
    data: {
      target: packet.target,
      targetTool: options.targetTool,
      mode: packet.mode
    }
  });
  applyDerivedSessionState(session);
  await persistDeliverySession(runDir, session);
  await writeRunMeta(runDir, session, { repoPath: session.repoPath, worktreePath: session.worktreePath ?? null });
  await appendDeliveryEvent(runDir, {
    t: "delivery.packet.exported",
    packetId: packet.id,
    roleId: packet.roleId
  });
  return exportRecord;
}

export async function analyzeDeliveryImport(options: PacketImportOptions & {
  recordAttempt?: boolean;
}): Promise<DeliveryImportAnalysis> {
  const runDir = await resolveRunDir(options.runsDir, options.runId, options.workspaceId);
  if (!runDir) throw new Error("Delivery session not found.");
  const session = await loadSessionByRunDir(runDir);
  if (!session) throw new Error("Delivery session is missing.");
  const rawText = options.text ?? (options.filePath ? await fs.readFile(options.filePath, "utf8") : "");
  if (!rawText.trim()) throw new Error("No import content provided.");
  const match = resolveImportPacket(session, {
    requestedPacketId: options.packetId,
    rawText,
    targetTool: options.targetTool
  });

  if (options.recordAttempt && match.matchStatus !== "matched") {
    const createdAt = new Date().toISOString();
    const importRecord: PacketImport = {
      id: crypto.randomUUID(),
      sessionId: session.runId,
      parsedPacketId: match.parsedPacketId ?? undefined,
      targetTool: options.targetTool,
      matchStatus: match.matchStatus,
      candidatePacketIds: match.candidatePacketIds,
      source: options.source ?? (options.filePath ? "file" : "paste"),
      fileName: options.fileName ?? (options.filePath ? path.basename(options.filePath) : undefined),
      rawText,
      summary: match.summary ?? summarizeImport(rawText),
      confidence: match.confidence,
      matchReasons: match.matchReasons,
      createdAt
    };
    await writeText(path.join(getDeliveryDir(runDir), "imports", `${importRecord.id}.txt`), rawText);
    session.imports.unshift(importRecord);
    session.updatedAt = createdAt;
    await persistDeliverySession(runDir, session);
    await writeRunMeta(runDir, session, { repoPath: session.repoPath, worktreePath: session.worktreePath ?? null });
  }

  return {
    sessionId: session.runId,
    parsedPacketId: match.parsedPacketId ?? undefined,
    matchedPacketId: match.matchedPacketId ?? undefined,
    targetTool: options.targetTool,
    matchStatus: match.matchStatus,
    needsPacketMatch: match.matchStatus !== "matched",
    candidatePacketIds: match.candidatePacketIds,
    confidence: match.confidence,
    matchReasons: match.matchReasons,
    summary: match.summary ?? summarizeImport(rawText)
  };
}

export async function importDeliveryPacketResponse(options: PacketImportOptions): Promise<DeliveryImportResult> {
  const runDir = await resolveRunDir(options.runsDir, options.runId, options.workspaceId);
  if (!runDir) throw new Error("Delivery session not found.");
  const session = await loadSessionByRunDir(runDir);
  if (!session) throw new Error("Delivery session is missing.");
  const rawText = options.text ?? (options.filePath ? await fs.readFile(options.filePath, "utf8") : "");
  if (!rawText.trim()) throw new Error("No import content provided.");
  const analysis = resolveImportPacket(session, {
    requestedPacketId: options.packetId,
    rawText,
    targetTool: options.targetTool
  });
  if (analysis.matchStatus !== "matched" || !analysis.matchedPacketId) {
    throw new Error("Unable to safely match import content to a packet.");
  }
  const packet = session.packets.find((item) => item.id === analysis.matchedPacketId);
  if (!packet) throw new Error("Matched packet not found.");
  const createdAt = new Date().toISOString();
  const importRecord: PacketImport = {
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    matchedPacketId: packet.id,
    parsedPacketId: analysis.parsedPacketId ?? undefined,
    targetTool: options.targetTool,
    matchStatus: "matched",
    candidatePacketIds: [packet.id],
    source: options.source ?? (options.filePath ? "file" : "paste"),
    fileName: options.fileName ?? (options.filePath ? path.basename(options.filePath) : undefined),
    rawText,
    summary: analysis.summary ?? summarizeImport(rawText),
    confidence: analysis.confidence,
    matchReasons: analysis.matchReasons,
    createdAt
  };
  await writeText(path.join(getDeliveryDir(runDir), "imports", `${importRecord.id}.txt`), rawText);
  session.imports.unshift(importRecord);
  packet.lastImportId = importRecord.id;
  packet.updatedAt = createdAt;

  const packetFindings = extractFindingsFromImport({
    session,
    packet,
    importRecord
  });
  session.findings = [...packetFindings, ...session.findings];

  const remediations = packet.remediationForFindingId
    ? []
    : createRemediationTasks(session, packet, packetFindings, createdAt);
  if (remediations.length > 0) {
    const remediationPackets = remediations.map((task) => {
      const remediationPacket = buildRemediationPacket(session, task, createdAt);
      task.packetId = remediationPacket.id;
      return remediationPacket;
    });
    session.remediations = [...remediations, ...session.remediations];
    session.packets = [...session.packets, ...remediationPackets];
  }

  if (packet.remediationForFindingId) {
    const linkedFinding = session.findings.find((item) => item.id === packet.remediationForFindingId);
    const linkedRemediation = session.remediations.find((item) => item.findingId === packet.remediationForFindingId);
    const blockingFindings = packetFindings.filter((item) => item.severity === "critical" || item.category === "delivery_blocker");
    if (linkedFinding && blockingFindings.length === 0) {
      linkedFinding.status = "resolved";
      linkedFinding.updatedAt = createdAt;
      session.evidence.push({
        id: crypto.randomUUID(),
        sessionId: session.runId,
        packetId: packet.id,
        findingId: linkedFinding.id,
        remediationTaskId: linkedRemediation?.id,
        kind: "finding_resolved",
        actor: "system",
        roleId: packet.roleId,
        source: "delivery",
        summary: `Resolved finding ${linkedFinding.title} via packet ${packet.id}.`,
        createdAt
      });
      if (linkedRemediation) {
        linkedRemediation.status = "done";
        linkedRemediation.updatedAt = createdAt;
      }
    }
  }

  const explicitStatus = parseExplicitStatus(rawText);
  packet.status = resolvePacketCompletionStatus(explicitStatus, packetFindings);
  session.evidence.push({
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    kind: "packet_imported",
    actor: "user",
    roleId: packet.roleId,
    source: options.targetTool ?? importRecord.source,
    summary: `Imported response for packet ${packet.id}.`,
    createdAt,
    data: {
      importId: importRecord.id,
      findingCount: packetFindings.length,
      targetTool: options.targetTool
    }
  });
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
      source: options.targetTool ?? packet.target,
      summary: `Captured ${finding.category} finding: ${finding.title}.`,
      createdAt,
      data: {
        severity: finding.severity
      }
    });
  }
  for (const remediation of remediations) {
    session.evidence.push({
      id: crypto.randomUUID(),
      sessionId: session.runId,
      remediationTaskId: remediation.id,
      findingId: remediation.findingId,
      packetId: remediation.packetId,
      kind: "remediation_created",
      actor: "system",
      roleId: remediation.roleId,
      source: "delivery",
      summary: `Created remediation task ${remediation.title}.`,
      createdAt
    });
  }

  session.updatedAt = createdAt;
  applyDerivedSessionState(session);
  await persistDeliverySession(runDir, session);
  await writeRunMeta(runDir, session, { repoPath: session.repoPath, worktreePath: session.worktreePath ?? null });
  await appendDeliveryEvent(runDir, {
    t: "delivery.packet.imported",
    packetId: packet.id,
    roleId: packet.roleId,
    findings: packetFindings.length
  });

  return {
    packet,
    importRecord,
    findings: packetFindings,
    remediations,
    session
  };
}

export async function executeAutoCliPacket(options: {
  repoPath: string;
  runDir: string;
  packetId: string;
}): Promise<WorkPacket | null> {
  const session = await loadSessionByRunDir(options.runDir);
  if (!session) return null;
  const packet = session.packets.find((item) => item.id === options.packetId);
  if (!packet || packet.mode !== "auto_cli") return packet ?? null;
  const createdAt = new Date().toISOString();
  packet.status = "running";
  packet.updatedAt = createdAt;
  await persistDeliverySession(options.runDir, session);
  await appendDeliveryEvent(options.runDir, {
    t: "delivery.packet.running",
    packetId: packet.id,
    roleId: packet.roleId
  });

  const config = await loadConfig(options.repoPath);
  const governance = resolveGovernanceSettings(config, { governance: session.preset.governance_defaults ?? null });
  const commands = packet.commands ?? [];
  if (commands.length === 0) {
    packet.status = "blocked";
    session.updatedAt = new Date().toISOString();
    session.evidence.push({
      id: crypto.randomUUID(),
      sessionId: session.runId,
      packetId: packet.id,
      kind: "packet_auto_executed",
      actor: "system",
      roleId: packet.roleId,
      source: "local-shell",
      summary: `Packet ${packet.id} has no commands to run.`,
      createdAt: session.updatedAt
    });
    applyDerivedSessionState(session);
    await persistDeliverySession(options.runDir, session);
    await writeRunMeta(options.runDir, session, { repoPath: session.repoPath, worktreePath: session.worktreePath ?? null });
    return packet;
  }

  const allowlist = config?.shell_allowlist?.map((item) => item.trim()).filter(Boolean) ?? [];
  const disallowed = allowlist.length > 0
    ? commands.filter((command) => {
        const base = command.trim().split(/\s+/)[0] ?? "";
        return !allowlist.includes(base);
      })
    : [];
  if (disallowed.length > 0) {
    const rawText = [
      `Packet ${packet.id} was blocked by shell_allowlist.`,
      ...disallowed.map((command) => `Blocked command: ${command}`)
    ].join("\n");
    await importDeliveryPacketResponse({
      runsDir: path.dirname(path.dirname(options.runDir)),
      runId: session.runId,
      workspaceId: session.workspaceId,
      packetId: packet.id,
      text: rawText,
      source: "auto_cli"
    });
    return session.packets.find((item) => item.id === packet.id) ?? packet;
  }

  const commandFindings = scanGovernedCommands(commands, governance);
  if (commandFindings.length > 0) {
    for (const finding of commandFindings) {
      await appendGovernanceEvent(options.runDir, {
        runId: session.runId,
        stepId: packet.id,
        category: "command",
        severity: "error",
        summary: finding.message,
        commands
      });
    }
    const rawText = [
      `Packet ${packet.id} was blocked by governance.`,
      ...commandFindings.map((finding) => finding.message)
    ].join("\n");
    await importDeliveryPacketResponse({
      runsDir: path.dirname(path.dirname(options.runDir)),
      runId: session.runId,
      workspaceId: session.workspaceId,
      packetId: packet.id,
      text: rawText,
      source: "auto_cli"
    });
    return session.packets.find((item) => item.id === packet.id) ?? packet;
  }

  const logPath = path.join(getDeliveryDir(options.runDir), "imports", `${packet.id}.auto.log`);
  await writeText(logPath, "");
  const repoPath = session.worktreePath ?? options.repoPath;
  const results = await runCommands({
    commands,
    cwd: repoPath,
    logFile: logPath,
    allowlist,
    onLine: (line) => {
      void appendDeliveryEvent(options.runDir, {
        t: "delivery.packet.log",
        packetId: packet.id,
        line
      });
    }
  });
  const rawText = await fs.readFile(logPath, "utf8").catch(() => "");
  const statusLine = results.every((item) => item.ok) ? "Status: completed" : "Status: blocked";
  const commandSummary = commands.map((command, index) => {
    const result = results[index] ?? { ok: false, exitCode: null };
    return `- ${command} :: ${result.ok ? "ok" : `exit ${result.exitCode ?? -1}`}`;
  }).join("\n");
  await importDeliveryPacketResponse({
    runsDir: path.dirname(path.dirname(options.runDir)),
    runId: session.runId,
    workspaceId: session.workspaceId,
    packetId: packet.id,
    text: `${statusLine}\nSummary: Auto CLI validation finished.\n${commandSummary}\n\n${rawText}`,
    source: "auto_cli"
  });
  const updated = await loadSessionByRunDir(options.runDir);
  return updated?.packets.find((item) => item.id === packet.id) ?? packet;
}

async function loadSessionByRunDir(runDir: string): Promise<DeliverySessionState | null> {
  const raw = await readJsonIfExists<unknown>(path.join(getDeliveryDir(runDir), SESSION_FILE));
  if (!raw) return null;
  return DeliverySessionStateSchema.parse(raw);
}

async function persistDeliverySession(runDir: string, session: DeliverySessionState): Promise<void> {
  session.updatedAt = new Date().toISOString();
  applyDerivedSessionState(session);
  await writeJson(path.join(getDeliveryDir(runDir), SESSION_FILE), DeliverySessionStateSchema.parse(session));
  await writeJson(path.join(getDeliveryDir(runDir), "packets.json"), session.packets);
  await writeJson(path.join(getDeliveryDir(runDir), "findings.json"), session.findings);
  await writeJson(path.join(getDeliveryDir(runDir), "remediations.json"), session.remediations);
  await writeJson(path.join(getDeliveryDir(runDir), "evidence.json"), session.evidence);
}

function getDeliveryDir(runDir: string): string {
  return path.join(runDir, DELIVERY_DIRNAME);
}

async function resolveRunDir(runsDir: string, runId: string, workspaceId?: string): Promise<string | null> {
  if (workspaceId) {
    const candidate = path.join(runsDir, workspaceId, runId);
    if (fsSync.existsSync(path.join(candidate, "run.json"))) return candidate;
  }
  const workspaceDirs = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of workspaceDirs) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name, runId);
    if (fsSync.existsSync(path.join(candidate, "run.json"))) return candidate;
  }
  return null;
}

async function listAllDeliverySessions(runsDir: string, workspaceId?: string): Promise<DeliverySessionState[]> {
  const workspaceDirs = workspaceId
    ? [workspaceId]
    : (await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
  const sessions: DeliverySessionState[] = [];
  for (const workspaceDir of workspaceDirs) {
    const parentDir = path.join(runsDir, workspaceDir);
    const runEntries = await fs.readdir(parentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of runEntries) {
      if (!entry.isDirectory()) continue;
      const session = await loadSessionByRunDir(path.join(parentDir, entry.name)).catch(() => null);
      if (session) sessions.push(session);
    }
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function writeRunMeta(runDir: string, session: DeliverySessionState, options: {
  repoPath: string;
  worktreePath?: string | null;
}): Promise<void> {
  const packetProgress = session.packets.filter((packet) => packet.status === "completed").length;
  const totalPackets = session.packets.filter((packet) => packet.mode !== "disabled").length;
  const runMeta: RunState & { repoPath: string; delivery?: Record<string, unknown> } = {
    runId: session.runId,
    kind: "delivery",
    status:
      session.status === "completed"
        ? "completed"
        : session.status === "failed"
          ? "failed"
          : "running",
    start: session.createdAt,
    end: session.status === "completed" ? session.updatedAt : null,
    goal: session.goal,
    userGoal: session.goal,
    workspaceId: session.workspaceId,
    workspacePath: options.repoPath,
    totalSteps: totalPackets,
    completedSteps: packetProgress,
    tags: ["delivery", session.sprintName ? `sprint:${session.sprintName}` : "goal"],
    worktreePath: options.worktreePath ?? null,
    readiness: {
      score: session.outputs.openFindingIds.length === 0 ? 100 : Math.max(0, 100 - session.outputs.openFindingIds.length * 10),
      blocking: session.outputs.humanActionItems.slice(0, 6),
      updatedAt: session.updatedAt
    },
    repoPath: options.repoPath,
    delivery: {
      sprintName: session.sprintName,
      openFindings: session.outputs.openFindingIds.length,
      resolvedFindings: session.outputs.resolvedFindingIds.length,
      humanActionItems: session.outputs.humanActionItems.length
    }
  };
  await writeJson(path.join(runDir, "run.json"), runMeta);
}

async function appendDeliveryEvent(runDir: string, payload: Record<string, unknown>): Promise<void> {
  await appendLine(path.join(runDir, "events.ndjson"), JSON.stringify({
    ts: Date.now(),
    ...payload
  }));
}

async function buildRepoContext(options: {
  repoPath: string;
  workspaceId: string;
  runsDir: string;
  goal: string;
  selectedPaths: string[];
}): Promise<{
  branch: string | null;
  readiness: string[];
  learnings: string[];
  selectedFileNotes: string[];
  repoScripts: string[];
}> {
  const [branch, learnings, readiness, scripts, selectedFileNotes] = await Promise.all([
    getCurrentBranch(options.repoPath),
    loadRelevantLearnings(options.repoPath, options.goal, 4).then((items) => formatLearningsForContext(items)).catch(() => []),
    computeReleaseReadiness({
      workspacePath: options.repoPath,
      runsDir: options.runsDir,
      workspaceId: options.workspaceId
    }).then((state) => {
      const lines = [`Readiness ${state.score}/100`];
      return [...lines, ...state.blocking.slice(0, 3)];
    }).catch(() => []),
    loadRepoScripts(options.repoPath).then((info) => info.names).catch(() => []),
    loadSelectedPathNotes(options.repoPath, options.selectedPaths)
  ]);
  return {
    branch,
    readiness,
    learnings,
    selectedFileNotes,
    repoScripts: scripts
  };
}

function resolveToolProfile(session: DeliverySessionState, targetTool: DeliveryTargetTool): DeliveryToolProfile {
  const base = BUILTIN_TOOL_PROFILES[targetTool];
  const override = session.preset.tool_profiles?.[targetTool];
  if (!override) return base;
  return {
    ...base,
    label: override.label ?? base.label,
    textVariant: override.text_variant ?? base.textVariant,
    guidance: override.guidance ?? base.guidance,
    responseContract: override.response_contract ?? base.responseContract
  };
}

function renderPacketMarkdown(session: DeliverySessionState, packet: WorkPacket, targetTool: DeliveryTargetTool): string {
  const toolProfile = resolveToolProfile(session, targetTool);
  const lines = [
    `<!-- ORCHESTRUM_PACKET ${JSON.stringify({ sessionId: session.runId, packetId: packet.id, roleId: packet.roleId })} -->`,
    "# Orchestrum Work Packet",
    "",
    `Packet ID: ${packet.id}`,
    `Session ID: ${session.runId}`,
    `Role: ${packet.roleId}`,
    `Mode: ${packet.mode}`,
    `Target: ${packet.target}`,
    `Tool Target: ${targetTool}`,
    `Goal: ${session.goal}`,
    ...(session.sprintName ? [`Sprint: ${session.sprintName}`] : []),
    "",
    "## Objective",
    packet.objective,
    "",
    "## Selected Paths",
    ...(packet.selectedPaths.length > 0 ? packet.selectedPaths.map((item) => `- ${item}`) : ["- No explicit file scope provided."]),
    "",
    "## Context",
    ...(packet.contextNotes.length > 0 ? packet.contextNotes.map((item) => `- ${item}`) : ["- No extra context captured."]),
    "",
    "## Acceptance Criteria",
    ...(packet.acceptanceCriteria.length > 0 ? packet.acceptanceCriteria.map((item) => `- ${item}`) : ["- Produce a scoped response for this packet."]),
    "",
    "## Expected Output",
    ...(packet.expectedOutput.length > 0 ? packet.expectedOutput.map((item) => `- ${item}`) : ["- Summary", "- Findings or completion notes"]),
    "",
    "## Tool Guidance",
    ...toolProfile.guidance.map((item) => `- ${item}`),
    "",
    "## Response Contract",
    "Return a concise response using this structure:",
    ...toolProfile.responseContract
  ];
  if (packet.commands?.length) {
    lines.push("", "## Suggested Commands", ...packet.commands.map((command) => `- ${command}`));
  }
  return lines.join("\n");
}

function appendEvidence(session: DeliverySessionState, evidence: EvidenceRecord): DeliverySessionState {
  session.evidence.push(evidence);
  return session;
}
