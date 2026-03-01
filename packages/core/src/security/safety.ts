export type SafetyFinding = {
  level: "low" | "medium" | "high";
  message: string;
};

const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bchmod\s+777\b/i,
  /\bchown\s+root\b/i,
  /\/\.ssh\b/i,
  /\bid_rsa\b/i,
  /\bauthorized_keys\b/i,
  /\bssh-keygen\b/i,
  /\bscp\b/i,
  /\brsync\b/i
];

const SECRET_PATTERNS = [/OPENAI_API_KEY/i, /AWS_SECRET_ACCESS_KEY/i, /BEGIN PRIVATE KEY/i, /API_KEY=/i];

export function scanCommands(commands: string[]): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const cmd of commands) {
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(cmd)) {
        findings.push({ level: "high", message: `High-risk command detected: ${cmd}` });
      }
    }
  }
  return findings;
}

export function scanDiff(diffText: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(diffText)) {
      findings.push({ level: "high", message: "Potential secret exposure detected in diff." });
      break;
    }
  }
  if (/migration/i.test(diffText) && /drop/i.test(diffText)) {
    findings.push({ level: "medium", message: "Destructive migration keywords found in diff." });
  }
  return findings;
}

export function requiresApproval(findings: SafetyFinding[]): boolean {
  return findings.some((f) => f.level === "high");
}

export function summarizeFindings(findings: SafetyFinding[]): string {
  if (findings.length === 0) return "";
  return findings.map((f) => f.message).join(" ");
}
