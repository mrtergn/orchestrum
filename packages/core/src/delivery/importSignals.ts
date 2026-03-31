export type ParsedImportSignals = {
  parsedPacketId?: string;
  summary: string;
  roleHints: string[];
  fileHints: string[];
  changedFiles: string[];
  verificationLines: string[];
  verificationFailures: string[];
  blockerLines: string[];
  findingLines: string[];
};

type SectionName =
  | "summary"
  | "files"
  | "changed_files"
  | "verification"
  | "blocked_by"
  | "findings"
  | "follow_up"
  | "other";

const SECTION_ALIASES: Record<string, SectionName> = {
  summary: "summary",
  files: "files",
  "changed files": "changed_files",
  "files changed": "changed_files",
  "file scope": "files",
  verification: "verification",
  validations: "verification",
  checks: "verification",
  "next checks": "verification",
  findings: "findings",
  "follow up": "follow_up",
  followup: "follow_up",
  "blocked by": "blocked_by"
};

export function parsePacketId(input: string): string | null {
  const commentMatch = input.match(/ORCHESTRUM_PACKET\s+(\{[\s\S]+?\})/);
  const packetPayload = commentMatch?.[1];
  if (packetPayload) {
    try {
      const parsed = JSON.parse(packetPayload) as { packetId?: string };
      if (parsed.packetId) return parsed.packetId;
    } catch {
      // ignore malformed embedded JSON
    }
  }
  const lineMatch = input.match(/^\s*Packet ID\s*:\s*([A-Za-z0-9._-]+)\s*$/im);
  return lineMatch?.[1] ?? null;
}

export function summarizeImport(input: string): string {
  const summaryLine = input.match(/^\s*summary\s*:\s*(.+)$/im)?.[1]?.trim();
  if (summaryLine) return summaryLine;
  return input.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240) ?? "Imported response";
}

export function parseImportSignals(input: string): ParsedImportSignals {
  const lines = input.split(/\r?\n/);
  const sections = new Map<SectionName, string[]>();
  let currentSection: SectionName = "other";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentSection !== "summary") {
        currentSection = "other";
      }
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s*(.+?)\s*$/);
    const colonHeadingMatch = line.match(/^([A-Za-z][A-Za-z\s]+):\s*(.*)$/);
    const headingValue = headingMatch?.[1]?.trim().toLowerCase() ?? colonHeadingMatch?.[1]?.trim().toLowerCase();
    const aliasedSection = headingValue ? SECTION_ALIASES[headingValue] : undefined;
    if (aliasedSection) {
      currentSection = aliasedSection;
      const remainder = colonHeadingMatch?.[2]?.trim();
      if (remainder) {
        appendSectionLine(sections, aliasedSection, remainder);
      }
      continue;
    }

    appendSectionLine(sections, currentSection, line);
  }

  const fileHints = Array.from(new Set([
    ...extractListedFiles(input),
    ...collectPathLikeLines(sections.get("files") ?? []),
    ...collectPathLikeLines(sections.get("changed_files") ?? [])
  ]));
  const verificationLines = sections.get("verification") ?? [];
  const verificationFailures = verificationLines.filter((line) => /\b(fail|failed|error|blocked|not run|skipped|timeout|timed out)\b/i.test(line));
  const blockerLines = [
    ...(sections.get("blocked_by") ?? []),
    ...lines.map((line) => line.trim()).filter((line) => /\bblocked by\b/i.test(line))
  ];
  const changedFiles = Array.from(new Set([
    ...collectPathLikeLines(sections.get("changed_files") ?? []),
    ...collectPathLikeLines(sections.get("files") ?? [])
  ]));
  const findingLines = sections.get("findings") ?? [];

  return {
    parsedPacketId: parsePacketId(input) ?? undefined,
    summary: summarizeImport(input),
    roleHints: inferRoleHints({ changedFiles, verificationLines, findingLines, blockerLines }),
    fileHints,
    changedFiles,
    verificationLines,
    verificationFailures,
    blockerLines,
    findingLines
  };
}

function appendSectionLine(target: Map<SectionName, string[]>, section: SectionName, line: string): void {
  const lines = target.get(section) ?? [];
  lines.push(line);
  target.set(section, lines);
}

function collectPathLikeLines(lines: string[]): string[] {
  const files = new Set<string>();
  for (const line of lines) {
    const bulletMatch = line.match(/^[-*]\s+`?([^`]+?)`?\s*$/);
    if (bulletMatch?.[1]) {
      const value = bulletMatch[1].trim();
      if (looksLikePath(value)) files.add(value);
      continue;
    }
    const inlineMatch = line.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g);
    for (const match of inlineMatch ?? []) {
      if (looksLikePath(match)) files.add(match.trim());
    }
  }
  return Array.from(files);
}

function looksLikePath(value: string): boolean {
  return /[./]/.test(value) && /\.[A-Za-z0-9]+$/.test(value);
}

function inferRoleHints(signals: {
  changedFiles: string[];
  verificationLines: string[];
  findingLines: string[];
  blockerLines: string[];
}): string[] {
  const hints = new Set<string>();
  if (signals.changedFiles.length > 0) {
    hints.add("developer");
  }
  if (signals.verificationLines.length > 0) {
    hints.add("tester");
    if (signals.changedFiles.length > 0) hints.add("developer");
  }
  if (signals.findingLines.length > 0) {
    hints.add("auditor");
  }
  if (signals.blockerLines.length > 0 && signals.changedFiles.length === 0 && signals.verificationLines.length === 0) {
    hints.add("planner");
  }
  return Array.from(hints);
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
