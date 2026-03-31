import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ensureDir, appendLine, readJsonIfExists, safeRunId, writeJson, writeText } from "../runner/fs.js";
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
  createDefaultTeamPreset,
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
  type RoleDefinition,
  type TeamPreset,
  type TeamPresetResponse,
  type WorkPacket
} from "./types.js";

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

type ImportMatchResult = DeliveryImportAnalysis & {
  candidates: WorkPacket[];
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
  const summary: DeliverySummary = {
    workspaceId: options.workspaceId,
    sessions: sessions.length,
    activeSessions: 0,
    blockedSessions: 0,
    completedSessions: 0,
    openFindings: 0,
    resolvedFindings: 0,
    remediationsOpen: 0,
    remediationsDone: 0,
    unresolvedManualPackets: 0,
    unmatchedImportAttempts: 0,
    packetStatusCounts: {},
    toolUsage: {},
    latestRunId: sessions[0]?.runId ?? null
  };

  for (const session of sessions) {
    if (session.status === "running") summary.activeSessions += 1;
    if (session.status === "blocked" || session.status === "failed") summary.blockedSessions += 1;
    if (session.status === "completed") summary.completedSessions += 1;
    summary.openFindings += session.findings.filter((finding) => finding.status === "open").length;
    summary.resolvedFindings += session.findings.filter((finding) => finding.status === "resolved").length;
    summary.remediationsOpen += session.remediations.filter((task) => task.status !== "done").length;
    summary.remediationsDone += session.remediations.filter((task) => task.status === "done").length;
    summary.unresolvedManualPackets += session.packets.filter((packet) => packet.mode !== "auto_cli" && packet.status !== "completed").length;
    summary.unmatchedImportAttempts += session.imports.filter((item) => item.matchStatus !== "matched").length;
    for (const packet of session.packets) {
      summary.packetStatusCounts[packet.status] = (summary.packetStatusCounts[packet.status] ?? 0) + 1;
    }
    for (const exported of session.exports) {
      summary.toolUsage[exported.targetTool] = (summary.toolUsage[exported.targetTool] ?? 0) + 1;
    }
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
    parsedPacketId: parsePacketId(rawText),
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
      summary: summarizeImport(rawText),
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
    summary: summarizeImport(rawText)
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
    parsedPacketId: parsePacketId(rawText),
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
    summary: summarizeImport(rawText),
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
  const legacy = path.join(runsDir, runId);
  if (fsSync.existsSync(path.join(legacy, "run.json"))) return legacy;
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
        ? "finished"
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

function buildInitialPackets(options: {
  runId: string;
  workspaceId: string;
  repoPath: string;
  goal: string;
  sprintName?: string;
  selectedPaths: string[];
  notes?: string;
  preset: TeamPreset;
  roleBindings: RoleBinding[];
  context: {
    branch: string | null;
    readiness: string[];
    learnings: string[];
    selectedFileNotes: string[];
    repoScripts: string[];
  };
}): WorkPacket[] {
  const roleMap = new Map(options.preset.roles.map((role) => [role.id, role]));
  return options.roleBindings
    .filter((binding) => binding.mode !== "disabled")
    .map((binding) => {
      const role = roleMap.get(binding.roleId) ?? fallbackRole(binding.roleId, binding.mode);
      const now = new Date().toISOString();
      const template = options.preset.packet_templates?.[binding.roleId];
      const acceptanceCriteria = [
        ...(role.acceptance_criteria ?? []),
        ...(template?.acceptance_criteria ?? [])
      ];
      const expectedOutput = [
        ...(role.expected_output ?? []),
        ...(template?.expected_output ?? [])
      ];
      const contextNotes = [
        options.notes ? `Session notes: ${options.notes}` : null,
        options.context.branch ? `Current branch: ${options.context.branch}` : null,
        ...options.context.readiness.map((item) => `Readiness: ${item}`),
        ...options.context.learnings.map((item) => `Learning: ${item}`),
        ...options.context.selectedFileNotes
      ].filter((item): item is string => Boolean(item));
      const commands = binding.mode === "auto_cli"
        ? buildAutoCliCommands(options.repoPath, options.context.repoScripts)
        : undefined;
      const status = !binding.available
        ? "blocked"
        : binding.mode === "auto_cli" && (!commands || commands.length === 0)
          ? "blocked"
          : "pending";
      return {
        id: `${binding.roleId}-${crypto.randomUUID().slice(0, 8)}`,
        sessionId: options.runId,
        roleId: binding.roleId,
        title: buildPacketTitle(binding.roleId, options.goal, options.sprintName),
        objective: [
          template?.objective_prefix,
          role.objective,
          `Goal: ${options.goal}`
        ].filter(Boolean).join(" "),
        summary: binding.reason,
        mode: binding.mode,
        status,
        target: binding.target,
        repoPath: options.repoPath,
        workspaceId: options.workspaceId,
        goal: options.goal,
        sprintName: options.sprintName,
        selectedPaths: options.selectedPaths,
        contextNotes,
        repoScripts: options.context.repoScripts,
        acceptanceCriteria,
        expectedOutput,
        commands,
        dependsOn: [],
        createdAt: now,
        updatedAt: now
      } satisfies WorkPacket;
    });
}

function buildRemediationPacket(session: DeliverySessionState, remediation: RemediationTask, createdAt: string): WorkPacket {
  const binding = session.roleBindings.find((item) => item.roleId === remediation.roleId);
  const mode = binding?.mode ?? "manual_ide";
  const target = binding?.target ?? "manual";
  return {
    id: `remediation-${crypto.randomUUID().slice(0, 8)}`,
    sessionId: session.runId,
    roleId: remediation.roleId,
    title: remediation.title,
    objective: remediation.summary,
    summary: `Remediation generated from finding ${remediation.findingId}.`,
    mode,
    status: mode === "auto_cli" && !(remediation.suggestedCommands?.length) ? "blocked" : "pending",
    target,
    repoPath: session.repoPath,
    workspaceId: session.workspaceId,
    goal: session.goal,
    sprintName: session.sprintName,
    selectedPaths: session.selectedPaths,
    contextNotes: [
      `Generated from finding ${remediation.findingId}.`
    ],
    repoScripts: session.packets.flatMap((packet) => packet.repoScripts ?? []),
    acceptanceCriteria: remediation.acceptanceCriteria,
    expectedOutput: [
      "Resolution summary",
      "Changed files",
      "Verification notes"
    ],
    commands: remediation.suggestedCommands,
    dependsOn: [],
    remediationForFindingId: remediation.findingId,
    createdAt,
    updatedAt: createdAt
  };
}

function createRemediationTasks(
  session: DeliverySessionState,
  packet: WorkPacket,
  findings: ReviewFinding[],
  createdAt: string
): RemediationTask[] {
  return findings
    .filter((finding) => finding.status === "open" && finding.category !== "follow_up")
    .map((finding) => {
      const roleId = remediationRoleForFinding(finding.category);
      const task: RemediationTask = {
        id: crypto.randomUUID(),
        sessionId: session.runId,
        findingId: finding.id,
        roleId,
        title: `Resolve: ${finding.title}`,
        summary: `Address finding from ${packet.roleId}: ${finding.summary}`,
        acceptanceCriteria: [
          "Resolve the specific finding without widening scope unnecessarily.",
          "Call out verification steps for the fix."
        ],
        suggestedCommands: roleId === "tester" ? buildAutoCliCommands(session.repoPath, packet.repoScripts) : undefined,
        status: "open",
        createdAt,
        updatedAt: createdAt
      };
      finding.remediationTaskId = task.id;
      return task;
    });
}

function extractFindingsFromImport(options: {
  session: DeliverySessionState;
  packet: WorkPacket;
  importRecord: PacketImport;
}): ReviewFinding[] {
  const listedFiles = extractListedFiles(options.importRecord.rawText);
  const explicit = extractExplicitFindings(options.importRecord.rawText);
  if (explicit.length > 0) {
    return explicit.map((entry) => createFinding(options.session, options.packet, options.importRecord, {
      ...entry,
      files: entry.files?.length ? entry.files : listedFiles
    }));
  }
  const heuristics = inferHeuristicFindings(options.importRecord.rawText);
  if (heuristics.length > 0) {
    return heuristics.map((entry) => createFinding(options.session, options.packet, options.importRecord, {
      ...entry,
      files: listedFiles
    }));
  }
  const status = parseExplicitStatus(options.importRecord.rawText);
  if (status === "completed") {
    return [];
  }
  return [
    createFinding(options.session, options.packet, options.importRecord, {
      category: "follow_up",
      severity: "medium",
      title: `${options.packet.roleId} response needs review`,
      summary: summarizeImport(options.importRecord.rawText),
      files: listedFiles
    })
  ];
}

function createFinding(
  session: DeliverySessionState,
  packet: WorkPacket,
  importRecord: PacketImport,
  input: {
    category: ReviewFinding["category"];
    severity: ReviewFinding["severity"];
    title: string;
    summary: string;
    evidence?: string[];
    files?: string[];
  }
): ReviewFinding {
  const createdAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: session.runId,
    packetId: packet.id,
    importId: importRecord.id,
    category: input.category,
    severity: input.severity,
    status: "open",
    title: input.title,
    summary: input.summary,
    evidence: input.evidence ?? [input.summary],
    files: input.files ?? [],
    source: packet.target,
    createdAt,
    updatedAt: createdAt
  };
}

function parseExplicitStatus(input: string): "completed" | "blocked" | null {
  const match = input.match(/^\s*status\s*:\s*(completed|blocked)\s*$/im);
  if (!match) return null;
  const status = match[1];
  return status ? status.toLowerCase() as "completed" | "blocked" : null;
}

function resolvePacketCompletionStatus(
  explicitStatus: "completed" | "blocked" | null,
  findings: ReviewFinding[]
): WorkPacket["status"] {
  if (explicitStatus === "completed") return "completed";
  if (explicitStatus === "blocked") return "blocked";
  if (findings.some((finding) => finding.category === "delivery_blocker" || finding.severity === "critical")) {
    return "blocked";
  }
  if (findings.length === 0) return "completed";
  return "completed";
}

function parsePacketId(input: string): string | null {
  const commentMatch = input.match(/ORCHESTRUM_PACKET\s+(\{[\s\S]+?\})/);
  const packetPayload = commentMatch?.[1];
  if (packetPayload) {
    try {
      const parsed = JSON.parse(packetPayload) as { packetId?: string };
      if (parsed.packetId) return parsed.packetId;
    } catch {
      // ignore
    }
  }
  const lineMatch = input.match(/^\s*Packet ID\s*:\s*([A-Za-z0-9._-]+)\s*$/im);
  return lineMatch?.[1] ?? null;
}

function resolveImportPacket(
  session: DeliverySessionState,
  options: {
    requestedPacketId?: string;
    parsedPacketId?: string | null;
    targetTool?: DeliveryTargetTool;
  }
): ImportMatchResult {
  const importablePackets = getImportablePackets(session);
  const candidatePacketIds = importablePackets.map((packet) => packet.id);
  const parsedPacketId = options.parsedPacketId ?? undefined;

  if (options.requestedPacketId) {
    const requested = session.packets.find((packet) => packet.id === options.requestedPacketId) ?? null;
    if (!requested) {
      return {
        sessionId: session.runId,
        parsedPacketId,
        targetTool: options.targetTool,
        matchStatus: candidatePacketIds.length > 0 ? "ambiguous" : "unmatched",
        needsPacketMatch: true,
        candidatePacketIds,
        summary: `Requested packet ${options.requestedPacketId} was not found.`,
        candidates: importablePackets
      };
    }
    return {
      sessionId: session.runId,
      parsedPacketId,
      matchedPacketId: requested.id,
      targetTool: options.targetTool,
      matchStatus: "matched",
      needsPacketMatch: false,
      candidatePacketIds: [requested.id],
      summary: `Matched import to requested packet ${requested.id}.`,
      candidates: [requested]
    };
  }

  if (parsedPacketId) {
    const parsed = session.packets.find((packet) => packet.id === parsedPacketId) ?? null;
    if (parsed) {
      return {
        sessionId: session.runId,
        parsedPacketId,
        matchedPacketId: parsed.id,
        targetTool: options.targetTool,
        matchStatus: "matched",
        needsPacketMatch: false,
        candidatePacketIds: [parsed.id],
        summary: `Matched import to packet ${parsed.id} via embedded packet id.`,
        candidates: [parsed]
      };
    }
    return {
      sessionId: session.runId,
      parsedPacketId,
      targetTool: options.targetTool,
      matchStatus: candidatePacketIds.length > 0 ? "ambiguous" : "unmatched",
      needsPacketMatch: true,
      candidatePacketIds,
      summary: `Embedded packet id ${parsedPacketId} did not match an active packet.`,
      candidates: importablePackets
    };
  }

  const toolMatched = options.targetTool ? getToolMatchedPackets(session, importablePackets, options.targetTool) : [];
  if (toolMatched.length === 1) {
    return {
      sessionId: session.runId,
      targetTool: options.targetTool,
      matchedPacketId: toolMatched[0]?.id,
      matchStatus: "matched",
      needsPacketMatch: false,
      candidatePacketIds: [toolMatched[0]!.id],
      summary: `Matched import to ${toolMatched[0]!.id} via tool target ${options.targetTool}.`,
      candidates: toolMatched
    };
  }
  if (toolMatched.length > 1) {
    return {
      sessionId: session.runId,
      targetTool: options.targetTool,
      matchStatus: "ambiguous",
      needsPacketMatch: true,
      candidatePacketIds: toolMatched.map((packet) => packet.id),
      summary: `Multiple packets are waiting for ${options.targetTool} imports.`,
      candidates: toolMatched
    };
  }
  if (importablePackets.length === 1) {
    return {
      sessionId: session.runId,
      targetTool: options.targetTool,
      matchedPacketId: importablePackets[0]?.id,
      matchStatus: "matched",
      needsPacketMatch: false,
      candidatePacketIds: [importablePackets[0]!.id],
      summary: `Matched import to the only pending manual packet ${importablePackets[0]!.id}.`,
      candidates: importablePackets
    };
  }
  return {
    sessionId: session.runId,
    targetTool: options.targetTool,
    matchStatus: importablePackets.length > 0 ? "ambiguous" : "unmatched",
    needsPacketMatch: true,
    candidatePacketIds,
    summary: importablePackets.length > 0 ? "Multiple manual packets are awaiting imports." : "No manual packets are awaiting imports.",
    candidates: importablePackets
  };
}

function getImportablePackets(session: DeliverySessionState): WorkPacket[] {
  return session.packets.filter((packet) => packet.mode !== "auto_cli" && packet.status !== "completed" && packet.status !== "failed");
}

function getToolMatchedPackets(
  session: DeliverySessionState,
  packets: WorkPacket[],
  targetTool: DeliveryTargetTool
): WorkPacket[] {
  return packets.filter((packet) => {
    const lastExport = packet.lastExportId
      ? session.exports.find((entry) => entry.id === packet.lastExportId)
      : null;
    return lastExport?.targetTool === targetTool || packet.target === targetTool;
  });
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

function summarizeImport(input: string): string {
  const summaryLine = input.match(/^\s*summary\s*:\s*(.+)$/im)?.[1]?.trim();
  if (summaryLine) return summaryLine;
  return input.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240) ?? "Imported response";
}

function extractExplicitFindings(input: string): Array<{
  category: ReviewFinding["category"];
  severity: ReviewFinding["severity"];
  title: string;
  summary: string;
  files?: string[];
}> {
  const findings: Array<{
    category: ReviewFinding["category"];
    severity: ReviewFinding["severity"];
    title: string;
    summary: string;
    files?: string[];
  }> = [];
  const lines = input.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s*\[([a-z_]+)\|([a-z]+)\]\s*(.+?)\s*::\s*(.+)\s*$/i);
    if (!match) continue;
    const [, rawCategory, rawSeverity, rawTitle, rawSummary] = match;
    if (!rawCategory || !rawSeverity || !rawTitle || !rawSummary) continue;
    const category = normalizeFindingCategory(rawCategory);
    const severity = normalizeFindingSeverity(rawSeverity);
    findings.push({
      category,
      severity,
      title: rawTitle.trim(),
      summary: rawSummary.trim()
    });
  }
  return findings;
}

function extractListedFiles(input: string): string[] {
  const lines = input.split(/\r?\n/);
  const files = new Set<string>();
  let inFilesSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inFilesSection) break;
      continue;
    }
    if (/^#{1,6}\s*(files|changed files|file scope|files changed)\s*$/i.test(line) || /^(files|changed files|file scope|files changed)\s*:\s*$/i.test(line)) {
      inFilesSection = true;
      continue;
    }
    if (inFilesSection) {
      const bulletMatch = line.match(/^[-*]\s+`?([^`]+?)`?\s*$/);
      if (bulletMatch?.[1]) {
        files.add(bulletMatch[1].trim());
        continue;
      }
      if (/^#{1,6}\s+/.test(line)) break;
    }
    const inlinePath = line.match(/(?:^|\s)([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:\s|$)/);
    if (inlinePath?.[1] && (line.toLowerCase().includes("file") || line.toLowerCase().includes("path"))) {
      files.add(inlinePath[1].trim());
    }
  }
  return Array.from(files);
}

function inferHeuristicFindings(input: string): Array<{
  category: ReviewFinding["category"];
  severity: ReviewFinding["severity"];
  title: string;
  summary: string;
}> {
  const lower = input.toLowerCase();
  const findings: Array<{
    category: ReviewFinding["category"];
    severity: ReviewFinding["severity"];
    title: string;
    summary: string;
  }> = [];
  if (/\b(security|vulnerability|secret|token|xss|csrf|sql injection)\b/.test(lower)) {
    findings.push({
      category: "security_risk",
      severity: /\bcritical|high\b/.test(lower) ? "high" : "medium",
      title: "Security risk flagged",
      summary: summarizeSentence(input, /(security|vulnerability|secret|token|xss|csrf|sql injection)/i)
    });
  }
  if (/\b(architecture|design|coupling|maintainability|scalability)\b/.test(lower)) {
    findings.push({
      category: "architecture_risk",
      severity: /\bcritical|high\b/.test(lower) ? "high" : "medium",
      title: "Architecture risk flagged",
      summary: summarizeSentence(input, /(architecture|design|coupling|maintainability|scalability)/i)
    });
  }
  if (/\b(test|coverage|typecheck|lint|build failed|failing)\b/.test(lower)) {
    findings.push({
      category: "test_gap",
      severity: /\bblocker|failed|failing\b/.test(lower) ? "high" : "medium",
      title: "Validation gap detected",
      summary: summarizeSentence(input, /(test|coverage|typecheck|lint|build failed|failing)/i)
    });
  }
  if (/\b(blocker|unable to|cannot|missing required|not possible)\b/.test(lower)) {
    findings.push({
      category: "delivery_blocker",
      severity: "high",
      title: "Delivery blocker detected",
      summary: summarizeSentence(input, /(blocker|unable to|cannot|missing required|not possible)/i)
    });
  }
  if (/\b(todo|follow up|next step|later)\b/.test(lower)) {
    findings.push({
      category: "follow_up",
      severity: "low",
      title: "Follow-up work suggested",
      summary: summarizeSentence(input, /(todo|follow up|next step|later)/i)
    });
  }
  if (findings.length === 0 && /\b(error|warning|regression|bug|issue|failed)\b/.test(lower)) {
    findings.push({
      category: "code_issue",
      severity: /\bhigh|critical\b/.test(lower) ? "high" : "medium",
      title: "Code issue detected",
      summary: summarizeSentence(input, /(error|warning|regression|bug|issue|failed)/i)
    });
  }
  return dedupeFindings(findings);
}

function normalizeFindingCategory(input: string): ReviewFinding["category"] {
  const normalized = input.trim().toLowerCase();
  switch (normalized) {
    case "test_gap":
    case "architecture_risk":
    case "security_risk":
    case "delivery_blocker":
    case "follow_up":
    case "code_issue":
      return normalized;
    default:
      return "code_issue";
  }
}

function normalizeFindingSeverity(input: string): ReviewFinding["severity"] {
  const normalized = input.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "critical":
      return normalized;
    default:
      return "medium";
  }
}

function dedupeFindings<T extends { category: string; title: string; summary: string }>(findings: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const finding of findings) {
    const key = `${finding.category}:${finding.title}:${finding.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function summarizeSentence(input: string, pattern: RegExp): string {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => pattern.test(line)) ?? lines[0] ?? "Imported finding";
}

function remediationRoleForFinding(category: ReviewFinding["category"]): string {
  switch (category) {
    case "architecture_risk":
    case "security_risk":
      return "auditor";
    case "test_gap":
      return "tester";
    case "follow_up":
      return "planner";
    default:
      return "developer";
  }
}

function buildPacketTitle(roleId: string, goal: string, sprintName?: string): string {
  const prefix = sprintName ? `${sprintName}: ` : "";
  switch (roleId) {
    case "planner":
      return `${prefix}Plan ${goal}`;
    case "developer":
      return `${prefix}Implement ${goal}`;
    case "auditor":
      return `${prefix}Audit ${goal}`;
    case "tester":
      return `${prefix}Validate ${goal}`;
    default:
      return `${prefix}${roleId} packet`;
  }
}

function fallbackRole(roleId: string, mode: WorkPacket["mode"]): RoleDefinition {
  return {
    id: roleId,
    label: roleId,
    description: roleId,
    mode
  };
}

function buildAutoCliCommands(repoPath: string, repoScripts: string[]): string[] {
  const packageManager = detectPackageManager(repoPath);
  const preferred = ["typecheck", "test", "lint", "build"];
  return preferred
    .filter((name) => repoScripts.includes(name))
    .slice(0, 3)
    .map((name) => `${packageManager} run ${name}`);
}

function detectPackageManager(repoPath: string): "pnpm" | "yarn" | "npm" {
  if (fsSync.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fsSync.existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
  return "npm";
}

async function loadRepoScripts(repoPath: string): Promise<{
  names: string[];
  packageManagerCommand: (scriptName: string) => string;
}> {
  const pkg = await readJsonIfExists<{ scripts?: Record<string, string> }>(path.join(repoPath, "package.json"));
  const scripts = Object.keys(pkg?.scripts ?? {});
  const packageManager = detectPackageManager(repoPath);
  return {
    names: scripts,
    packageManagerCommand: (scriptName: string) => `${packageManager} run ${scriptName}`
  };
}

async function loadSelectedPathNotes(repoPath: string, selectedPaths: string[]): Promise<string[]> {
  const notes: string[] = [];
  for (const relativePath of selectedPaths.slice(0, 6)) {
    const fullPath = path.join(repoPath, relativePath);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) {
      notes.push(`Selected path missing: ${relativePath}`);
      continue;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
      notes.push(`Directory ${relativePath} contains ${entries.length} entries.`);
      continue;
    }
    const raw = await fs.readFile(fullPath, "utf8").catch(() => "");
    const preview = raw.split(/\r?\n/).slice(0, 12).join(" ").replace(/\s+/g, " ").slice(0, 260);
    notes.push(`File ${relativePath}: ${preview || "empty file"}`);
  }
  return notes;
}

async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const result = await runBinary("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function lookupBinary(name: string): Promise<{ available: boolean; path?: string }> {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const result = await runBinary(command, [name]);
    const resolved = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return resolved ? { available: true, path: resolved } : { available: false };
  } catch {
    return { available: false };
  }
}

function runBinary(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed`));
      }
    });
  });
}

function createScaffoldTeamPreset(capabilities: MachineCapability[]): TeamPreset {
  const preset = createDefaultTeamPreset();
  const capMap = new Map(capabilities.map((cap) => [cap.id, cap]));
  preset.roles = preset.roles.map((role) => {
    if (role.id === "developer") {
      const preferred = ["cursor", "codex", "code"].filter((target) => capMap.get(`binary:${target}`)?.available);
      return {
        ...role,
        preferred_targets: preferred.length > 0 ? preferred : role.preferred_targets
      };
    }
    if (role.id === "tester" && !capabilities.some((cap) => cap.kind === "repo_script")) {
      return {
        ...role,
        mode: "manual_ide"
      };
    }
    return role;
  });
  return preset;
}

function applyDerivedSessionState(session: DeliverySessionState): DeliverySessionState {
  session.outputs.completedPacketIds = session.packets.filter((packet) => packet.status === "completed").map((packet) => packet.id);
  session.outputs.openFindingIds = session.findings.filter((finding) => finding.status === "open").map((finding) => finding.id);
  session.outputs.resolvedFindingIds = session.findings.filter((finding) => finding.status === "resolved").map((finding) => finding.id);
  session.outputs.suggestedCommitScope = Array.from(new Set([
    ...session.selectedPaths,
    ...session.findings.flatMap((finding) => finding.files)
  ])).filter(Boolean);
  session.outputs.humanActionItems = [
    ...session.packets
      .filter((packet) => packet.mode !== "auto_cli" && packet.status !== "completed")
      .map((packet) => `Import a response for ${packet.roleId} packet ${packet.id}.`),
    ...session.findings
      .filter((finding) => finding.status === "open")
      .map((finding) => `Resolve ${finding.severity} ${finding.category}: ${finding.title}.`)
  ];
  if (session.outputs.openFindingIds.length === 0 && session.packets.every((packet) => packet.status === "completed" || packet.mode === "disabled")) {
    session.status = "completed";
  } else if (session.packets.some((packet) => packet.status === "failed" || packet.status === "blocked") || session.findings.some((finding) => finding.category === "delivery_blocker" && finding.status === "open")) {
    session.status = "blocked";
  } else {
    session.status = "running";
  }
  session.summary = buildSessionSummary(session);
  return session;
}

function buildSessionSummary(session: DeliverySessionState): string {
  const openFindings = session.outputs.openFindingIds.length;
  const completedPackets = session.outputs.completedPacketIds.length;
  const totalPackets = session.packets.length;
  if (session.status === "completed") {
    return `Completed ${completedPackets}/${totalPackets} packets with no open findings.`;
  }
  if (openFindings > 0) {
    return `Completed ${completedPackets}/${totalPackets} packets with ${openFindings} open finding(s).`;
  }
  return `Completed ${completedPackets}/${totalPackets} packets.`;
}

function appendEvidence(session: DeliverySessionState, evidence: EvidenceRecord): DeliverySessionState {
  session.evidence.push(evidence);
  return session;
}
