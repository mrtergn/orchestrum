import type {
  DeliverySessionState,
  DeliverySummary,
  DeliverySummaryLatestImport,
  PacketImport,
  RemediationTask,
  ReviewFinding,
  WorkPacket
} from "./types.js";

function increment(target: Record<string, number>, key: string | undefined | null): void {
  if (!key) return;
  target[key] = (target[key] ?? 0) + 1;
}

export function countFindingCategoryCounts(findings: ReviewFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    increment(counts, finding.category);
  }
  return counts;
}

export function countFindingSeverityCounts(findings: ReviewFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    increment(counts, finding.severity);
  }
  return counts;
}

export function countRemediationPriorityCounts(remediations: RemediationTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of remediations) {
    increment(counts, task.priority);
  }
  return counts;
}

export function createEmptyDeliverySummary(workspaceId?: string): DeliverySummary {
  return {
    workspaceId,
    sessions: 0,
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
    findingCategoryCounts: {},
    findingSeverityCounts: {},
    remediationPriorityCounts: {},
    latestRunId: null,
    latestImport: null
  };
}

export function accumulateDeliverySummary(summary: DeliverySummary, session: DeliverySessionState): DeliverySummary {
  summary.sessions += 1;
  if (!summary.latestRunId) {
    summary.latestRunId = session.runId;
  }
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
    increment(summary.packetStatusCounts, packet.status);
  }
  for (const exported of session.exports) {
    increment(summary.toolUsage, exported.targetTool);
  }
  for (const [category, count] of Object.entries(countFindingCategoryCounts(session.findings))) {
    summary.findingCategoryCounts[category] = (summary.findingCategoryCounts[category] ?? 0) + count;
  }
  for (const [severity, count] of Object.entries(countFindingSeverityCounts(session.findings))) {
    summary.findingSeverityCounts[severity] = (summary.findingSeverityCounts[severity] ?? 0) + count;
  }
  for (const [priority, count] of Object.entries(countRemediationPriorityCounts(session.remediations))) {
    summary.remediationPriorityCounts[priority] = (summary.remediationPriorityCounts[priority] ?? 0) + count;
  }
  const latestImport = toDeliverySummaryLatestImport(session.imports[0], session.runId);
  if (latestImport && shouldReplaceLatestImport(summary.latestImport, latestImport)) {
    summary.latestImport = latestImport;
  }

  return summary;
}

export function toDeliverySummaryLatestImport(
  importRecord: PacketImport | null | undefined,
  runId: string
): DeliverySummaryLatestImport | null {
  if (!importRecord) return null;
  return {
    runId,
    importId: importRecord.id,
    createdAt: importRecord.createdAt,
    source: importRecord.source,
    fileName: importRecord.fileName,
    targetTool: importRecord.targetTool,
    matchStatus: importRecord.matchStatus,
    matchedPacketId: importRecord.matchedPacketId,
    summary: importRecord.summary,
    confidence: importRecord.confidence,
    matchReasons: importRecord.matchReasons ?? []
  };
}

export function shouldReplaceLatestImport(
  current: DeliverySummaryLatestImport | null | undefined,
  candidate: DeliverySummaryLatestImport | null | undefined
): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return candidate.createdAt.localeCompare(current.createdAt) > 0;
}

export function applyDerivedSessionState(session: DeliverySessionState): DeliverySessionState {
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

  const hasBlockedPacket = session.packets.some((packet) => packet.status === "failed" || packet.status === "blocked");
  const hasBlockingFinding = session.findings.some(
    (finding) => finding.status === "open" && (finding.category === "delivery_blocker" || finding.severity === "critical")
  );
  const allPacketsComplete = session.packets.every((packet) => packet.status === "completed" || packet.mode === "disabled");

  if (session.outputs.openFindingIds.length === 0 && allPacketsComplete) {
    session.status = "completed";
  } else if (hasBlockedPacket || hasBlockingFinding) {
    session.status = "blocked";
  } else {
    session.status = "running";
  }
  session.summary = buildSessionSummary(session);
  return session;
}

export function buildSessionSummary(session: DeliverySessionState): string {
  const openFindings = session.outputs.openFindingIds.length;
  const criticalFindings = session.findings.filter((finding) => finding.status === "open" && finding.severity === "critical").length;
  const highPriorityRemediations = session.remediations.filter(
    (task) => task.status !== "done" && (task.priority === "high" || task.priority === "critical")
  ).length;
  const completedPackets = session.outputs.completedPacketIds.length;
  const totalPackets = session.packets.length;

  if (session.status === "completed") {
    return `Completed ${completedPackets}/${totalPackets} packets with no open findings.`;
  }
  if (criticalFindings > 0) {
    return `Blocked with ${openFindings} open finding(s), including ${criticalFindings} critical item(s).`;
  }
  if (highPriorityRemediations > 0) {
    return `Completed ${completedPackets}/${totalPackets} packets with ${openFindings} open finding(s) and ${highPriorityRemediations} high-priority remediation task(s).`;
  }
  if (openFindings > 0) {
    return `Completed ${completedPackets}/${totalPackets} packets with ${openFindings} open finding(s).`;
  }
  return `Completed ${completedPackets}/${totalPackets} packets.`;
}

export function countPacketStatuses(packets: WorkPacket[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const packet of packets) {
    increment(counts, packet.status);
  }
  return counts;
}
