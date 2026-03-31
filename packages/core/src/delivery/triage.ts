import crypto from "node:crypto";
import { parseImportSignals, summarizeImport } from "./importSignals.js";
import { buildAutoCliCommands } from "./workPackets.js";
import type {
  DeliverySessionState,
  PacketImport,
  RemediationPriority,
  RemediationTask,
  ReviewFinding,
  WorkPacket
} from "./types.js";

export function createRemediationTasks(
  session: DeliverySessionState,
  packet: WorkPacket,
  findings: ReviewFinding[],
  createdAt: string
): RemediationTask[] {
  return findings
    .filter((finding) => finding.status === "open" && finding.category !== "follow_up")
    .map((finding) => {
      const roleId = remediationRoleForFinding(finding.category);
      const priority = remediationPriorityForSeverity(finding.severity);
      const task: RemediationTask = {
        id: crypto.randomUUID(),
        sessionId: session.runId,
        findingId: finding.id,
        roleId,
        title: `Resolve: ${finding.title}`,
        summary: `Address ${finding.severity} ${finding.category} from ${packet.roleId}: ${finding.summary}`,
        priority,
        acceptanceCriteria: [
          "Resolve the specific finding without widening scope unnecessarily.",
          "Call out verification steps for the fix.",
          ...(priority === "high" || priority === "critical" ? ["Treat this as a priority remediation and surface residual risk explicitly."] : []),
          ...(finding.category === "security_risk" ? ["Preserve security invariants and call out any remaining exposure."] : []),
          ...(finding.category === "test_gap" ? ["Name the exact validation that now covers the gap."] : [])
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

export function extractFindingsFromImport(options: {
  session: DeliverySessionState;
  packet: WorkPacket;
  importRecord: PacketImport;
}): ReviewFinding[] {
  const signals = parseImportSignals(options.importRecord.rawText);
  const listedFiles = signals.fileHints;
  const explicit = extractExplicitFindings(options.importRecord.rawText);
  if (explicit.length > 0) {
    return explicit.map((entry) => createFinding(options.session, options.packet, options.importRecord, {
      ...entry,
      files: entry.files?.length ? entry.files : listedFiles
    }));
  }
  const heuristics = inferHeuristicFindings(options.importRecord.rawText, signals);
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

export function parseExplicitStatus(input: string): "completed" | "blocked" | null {
  const match = input.match(/^\s*status\s*:\s*(completed|blocked)\s*$/im);
  if (!match) return null;
  const status = match[1];
  return status ? status.toLowerCase() as "completed" | "blocked" : null;
}

export function resolvePacketCompletionStatus(
  explicitStatus: "completed" | "blocked" | null,
  findings: ReviewFinding[]
): WorkPacket["status"] {
  if (explicitStatus === "completed") return "completed";
  if (explicitStatus === "blocked") return "blocked";
  if (findings.some((finding) => finding.category === "delivery_blocker" || finding.severity === "critical")) {
    return "blocked";
  }
  return "completed";
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
    const match = line.match(/^\s*[-*]\s*\[([a-z_]+)\|([a-z]+)\]\s*(.+?)\s*::\s*(.+?)\s*(?:[@#]\s*(.+))?$/i);
    if (!match) continue;
    const [, rawCategory, rawSeverity, rawTitle, rawSummary, rawFiles] = match;
    if (!rawCategory || !rawSeverity || !rawTitle || !rawSummary) continue;
    findings.push({
      category: normalizeFindingCategory(rawCategory),
      severity: normalizeFindingSeverity(rawSeverity),
      title: rawTitle.trim(),
      summary: rawSummary.trim(),
      files: rawFiles ? splitFindingFiles(rawFiles) : undefined
    });
  }
  return findings;
}

function inferHeuristicFindings(
  input: string,
  signals?: ReturnType<typeof parseImportSignals>
): Array<{
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
  const hasStructuredTestGap = (signals?.verificationFailures.length ?? 0) > 0;
  const hasStructuredBlocker = (signals?.blockerLines.length ?? 0) > 0;
  if (hasStructuredTestGap) {
    findings.push({
      category: "test_gap",
      severity: "high",
      title: "Verification failure detected",
      summary: signals?.verificationFailures[0] ?? "Verification failed or was skipped."
    });
  }
  if (hasStructuredBlocker) {
    findings.push({
      category: "delivery_blocker",
      severity: "high",
      title: "External blocker detected",
      summary: signals?.blockerLines[0] ?? "The import reported a delivery blocker."
    });
  }
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
  if (!hasStructuredTestGap && /\b(test|coverage|typecheck|lint|build failed|failing)\b/.test(lower)) {
    findings.push({
      category: "test_gap",
      severity: /\bblocker|failed|failing\b/.test(lower) ? "high" : "medium",
      title: "Validation gap detected",
      summary: summarizeSentence(input, /(test|coverage|typecheck|lint|build failed|failing)/i)
    });
  }
  if (!hasStructuredBlocker && /\b(blocker|unable to|cannot|missing required|not possible)\b/.test(lower)) {
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

function splitFindingFiles(rawFiles: string): string[] {
  return rawFiles
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => /[./]/.test(value));
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

function remediationPriorityForSeverity(severity: ReviewFinding["severity"]): RemediationPriority {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "medium";
  }
}
