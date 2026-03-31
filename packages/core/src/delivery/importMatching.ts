import { parseImportSignals, type ParsedImportSignals } from "./importSignals.js";
import type {
  DeliveryImportAnalysis,
  DeliverySessionState,
  DeliveryTargetTool,
  WorkPacket
} from "./types.js";

export type ImportMatchResult = DeliveryImportAnalysis & {
  candidates: WorkPacket[];
  signals: ParsedImportSignals;
};

type PacketScore = {
  packet: WorkPacket;
  score: number;
  fileOverlap: number;
  keywordOverlap: number;
  strongRoleMatch: boolean;
  reasons: string[];
};

export function resolveImportPacket(
  session: DeliverySessionState,
  options: {
    requestedPacketId?: string;
    rawText: string;
    targetTool?: DeliveryTargetTool;
  }
): ImportMatchResult {
  const signals = parseImportSignals(options.rawText);
  const importablePackets = getImportablePackets(session);
  const parsedPacketId = signals.parsedPacketId;
  const candidatePacketIds = importablePackets.map((packet) => packet.id);

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
        confidence: "low",
        matchReasons: [`Requested packet ${options.requestedPacketId} was not found.`],
        summary: `Requested packet ${options.requestedPacketId} was not found.`,
        candidates: importablePackets,
        signals
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
      confidence: "high",
      matchReasons: [`Requested packet ${requested.id} was provided explicitly.`],
      summary: `Matched import to requested packet ${requested.id}.`,
      candidates: [requested],
      signals
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
        confidence: "high",
        matchReasons: [`Embedded packet id ${parsed.id} matched directly.`],
        summary: `Matched import to packet ${parsed.id} via embedded packet id.`,
        candidates: [parsed],
        signals
      };
    }
    return {
      sessionId: session.runId,
      parsedPacketId,
      targetTool: options.targetTool,
      matchStatus: candidatePacketIds.length > 0 ? "ambiguous" : "unmatched",
      needsPacketMatch: true,
      candidatePacketIds,
      confidence: "low",
      matchReasons: [`Embedded packet id ${parsedPacketId} did not match an active packet.`],
      summary: `Embedded packet id ${parsedPacketId} did not match an active packet.`,
      candidates: importablePackets,
      signals
    };
  }

  const scoredPackets = importablePackets
    .map((packet) => scorePacketMatch(session, packet, signals, options.targetTool))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  const top = scoredPackets[0];
  const second = scoredPackets[1];
  const candidateScores = scoredPackets.filter((entry) => top && entry.score >= top.score - 8).slice(0, 4);
  const candidatePackets = candidateScores.map((entry) => entry.packet);

  if (top) {
    const confidence = top.score >= 42 && (!second || top.score - second.score >= 12)
      ? "high"
      : top.score >= 28 && (!second || top.score - second.score >= 8)
        ? "medium"
        : "low";
    const canAutoMatch = confidence !== "low" && (
      top.fileOverlap > 0 ||
      top.keywordOverlap > 0 ||
      top.strongRoleMatch ||
      candidatePackets.length === 1
    );
    if (canAutoMatch) {
      return {
        sessionId: session.runId,
        parsedPacketId,
        matchedPacketId: top.packet.id,
        targetTool: options.targetTool,
        matchStatus: "matched",
        needsPacketMatch: false,
        candidatePacketIds: [top.packet.id],
        confidence,
        matchReasons: top.reasons,
        summary: `Matched import to ${top.packet.id} via ${top.reasons.join(", ")}.`,
        candidates: [top.packet],
        signals
      };
    }
    return {
      sessionId: session.runId,
      parsedPacketId,
      targetTool: options.targetTool,
      matchStatus: "ambiguous",
      needsPacketMatch: true,
      candidatePacketIds: candidatePackets.map((packet) => packet.id),
      confidence,
      matchReasons: top.reasons,
      summary: `Multiple packets remain plausible. Top signal: ${top.reasons[0] ?? "insufficient evidence"}.`,
      candidates: candidatePackets,
      signals
    };
  }

  const toolMatched = options.targetTool ? getToolMatchedPackets(session, importablePackets, options.targetTool) : [];
  if (toolMatched.length === 1) {
    return {
      sessionId: session.runId,
      parsedPacketId,
      matchedPacketId: toolMatched[0]?.id,
      targetTool: options.targetTool,
      matchStatus: "matched",
      needsPacketMatch: false,
      candidatePacketIds: [toolMatched[0]!.id],
      confidence: "medium",
      matchReasons: [`Only one pending packet was exported to ${options.targetTool}.`],
      summary: `Matched import to ${toolMatched[0]!.id} via tool target ${options.targetTool}.`,
      candidates: toolMatched,
      signals
    };
  }
  if (toolMatched.length > 1) {
    return {
      sessionId: session.runId,
      parsedPacketId,
      targetTool: options.targetTool,
      matchStatus: "ambiguous",
      needsPacketMatch: true,
      candidatePacketIds: toolMatched.map((packet) => packet.id),
      confidence: "low",
      matchReasons: [`Multiple packets are waiting for ${options.targetTool} imports.`],
      summary: `Multiple packets are waiting for ${options.targetTool} imports.`,
      candidates: toolMatched,
      signals
    };
  }
  if (importablePackets.length === 1) {
    return {
      sessionId: session.runId,
      parsedPacketId,
      targetTool: options.targetTool,
      matchedPacketId: importablePackets[0]?.id,
      matchStatus: "matched",
      needsPacketMatch: false,
      candidatePacketIds: [importablePackets[0]!.id],
      confidence: "medium",
      matchReasons: ["Only one pending manual packet remains."],
      summary: `Matched import to the only pending manual packet ${importablePackets[0]!.id}.`,
      candidates: importablePackets,
      signals
    };
  }
  return {
    sessionId: session.runId,
    parsedPacketId,
    targetTool: options.targetTool,
    matchStatus: importablePackets.length > 0 ? "ambiguous" : "unmatched",
    needsPacketMatch: true,
    candidatePacketIds,
    confidence: "low",
    matchReasons: [importablePackets.length > 0 ? "Multiple manual packets are awaiting imports." : "No manual packets are awaiting imports."],
    summary: importablePackets.length > 0 ? "Multiple manual packets are awaiting imports." : "No manual packets are awaiting imports.",
    candidates: importablePackets,
    signals
  };
}

export function getImportablePackets(session: DeliverySessionState): WorkPacket[] {
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

function scorePacketMatch(
  session: DeliverySessionState,
  packet: WorkPacket,
  signals: ParsedImportSignals,
  targetTool?: DeliveryTargetTool
): PacketScore {
  let score = 0;
  const reasons: string[] = [];
  const lastExport = packet.lastExportId
    ? session.exports.find((entry) => entry.id === packet.lastExportId)
    : null;
  if (targetTool && (lastExport?.targetTool === targetTool || packet.target === targetTool)) {
    score += 14;
    reasons.push(`tool target ${targetTool}`);
  }
  if (packet.status === "awaiting_import") {
    score += 8;
  } else if (packet.status === "pending") {
    score += 3;
  }

  const fileOverlap = intersectionCount(signals.fileHints, packet.selectedPaths);
  if (fileOverlap > 0) {
    score += 22 + fileOverlap * 4;
    reasons.push(`${fileOverlap} file hint${fileOverlap === 1 ? "" : "s"}`);
  }

  const keywordOverlap = keywordIntersectionCount(signals.summary, `${packet.title} ${packet.objective}`);
  if (keywordOverlap > 0) {
    score += Math.min(12, keywordOverlap * 4);
    reasons.push("summary keywords");
  }

  const strongRoleMatch = isStrongRoleMatch(packet.roleId, signals);
  if (strongRoleMatch) {
    score += 24;
    reasons.push(`${packet.roleId} response shape`);
  } else if (signals.roleHints.includes(packet.roleId)) {
    score += 6;
    reasons.push(`${packet.roleId} hint`);
  }

  return {
    packet,
    score,
    fileOverlap,
    keywordOverlap,
    strongRoleMatch,
    reasons
  };
}

function isStrongRoleMatch(roleId: string, signals: ParsedImportSignals): boolean {
  if (roleId === "developer") {
    return signals.changedFiles.length > 0;
  }
  if (roleId === "tester") {
    return signals.verificationLines.length > 0 && signals.changedFiles.length === 0;
  }
  if (roleId === "planner") {
    return signals.blockerLines.length > 0 && signals.changedFiles.length === 0 && signals.verificationLines.length === 0;
  }
  return false;
}

function intersectionCount(left: string[], right: string[]): number {
  const leftSet = new Set(left.map(normalizePathToken));
  let count = 0;
  for (const value of right) {
    if (leftSet.has(normalizePathToken(value))) {
      count += 1;
    }
  }
  return count;
}

function normalizePathToken(value: string): string {
  return value.trim().replace(/^\.\//, "").toLowerCase();
}

function keywordIntersectionCount(leftText: string, rightText: string): number {
  const left = extractKeywords(leftText);
  const right = new Set(extractKeywords(rightText));
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function extractKeywords(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "into",
  "after",
  "before",
  "your",
  "what",
  "when",
  "where",
  "which",
  "were",
  "will",
  "packet",
  "summary",
  "scope",
  "notes",
  "goal",
  "work",
  "response"
]);
