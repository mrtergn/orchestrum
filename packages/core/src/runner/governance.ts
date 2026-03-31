import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { SafetyFinding } from "../security/safety.js";
import type { GovernanceProfile } from "./types.js";
import type { OrchestrumConfig } from "./config.js";
import { runCommands } from "./commands.js";
import { appendLine, readJsonIfExists, writeJson } from "./fs.js";

export type GovernanceSettings = Required<GovernanceProfile> & {
  enabled: boolean;
};

export type GovernanceEvent = {
  id: string;
  ts: string;
  category: "command" | "diff" | "quality_gate" | "config_protection" | "alert";
  severity: "info" | "warn" | "error";
  runId: string;
  stepId: string;
  summary: string;
  files?: string[];
  commands?: string[];
};

const CRITICAL_FILE_PATTERNS = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^\.github\/workflows\//i,
  /^orchestrum\.config\.json$/i,
  /^\.orchestrum\/config\.json$/i,
  /^\.env/i,
  /^docker-compose/i,
  /^Dockerfile/i
];

export function resolveGovernanceSettings(
  config: OrchestrumConfig | null,
  profile: { governance?: GovernanceProfile | null } | null
): GovernanceSettings {
  return {
    enabled: profile?.governance?.enabled ?? config?.governance?.enabled ?? false,
    dangerous_command_guard:
      profile?.governance?.dangerous_command_guard ?? config?.governance?.dangerous_command_guard ?? true,
    config_protection: profile?.governance?.config_protection ?? config?.governance?.config_protection ?? true,
    quality_gate: profile?.governance?.quality_gate ?? config?.governance?.quality_gate ?? false
  };
}

export function scanGovernedCommands(commands: string[], settings: GovernanceSettings): SafetyFinding[] {
  if (!settings.enabled || !settings.dangerous_command_guard) return [];
  const findings: SafetyFinding[] = [];
  for (const command of commands) {
    if (/\b(git\s+reset\s+--hard|git\s+clean\s+-fd|chmod\s+777|rm\s+-rf|sudo\s+)/i.test(command)) {
      findings.push({
        level: "high",
        message: `Governance blocked a dangerous command: ${command}`
      });
    }
  }
  return findings;
}

export function scanGovernedDiff(diffText: string, changedFiles: string[], settings: GovernanceSettings): SafetyFinding[] {
  if (!settings.enabled || !settings.config_protection) return [];
  const protectedFiles = changedFiles.filter((file) => CRITICAL_FILE_PATTERNS.some((pattern) => pattern.test(file)));
  if (protectedFiles.length === 0) return [];
  return [{
    level: "high",
    message: `Critical project files changed: ${protectedFiles.join(", ")}`
  }];
}

export async function runQualityGate(options: {
  repoPath: string;
  stepDir: string;
  stepId: string;
  runId: string;
  settings: GovernanceSettings;
  emit?: (event: Record<string, unknown>) => void;
}): Promise<{ ok: boolean; commands: string[]; logPath?: string; findings: SafetyFinding[] }> {
  if (!options.settings.enabled || !options.settings.quality_gate) {
    return { ok: true, commands: [], findings: [] };
  }

  const commands = await discoverQualityGateCommands(options.repoPath);
  if (commands.length === 0) {
    return { ok: true, commands: [], findings: [] };
  }

  const logPath = path.join(options.stepDir, "quality-gate.log");
  await fs.mkdir(options.stepDir, { recursive: true });
  await fs.writeFile(logPath, "", "utf8");
  const results = await runCommands({
    commands,
    cwd: options.repoPath,
    logFile: logPath,
    onLine: (line) => {
      options.emit?.({
        t: "step.log",
        stepId: options.stepId,
        line: `[quality-gate] ${line}`,
        ts: Date.now()
      });
    }
  });
  const ok = results.every((result) => result.ok);
  return {
    ok,
    commands,
    logPath,
    findings: ok
      ? []
      : [{
          level: "high",
          message: `Quality gate failed for ${options.stepId}.`
        }]
  };
}

export async function appendGovernanceEvent(runDir: string, event: Omit<GovernanceEvent, "id" | "ts"> & { id?: string; ts?: string }): Promise<GovernanceEvent> {
  const normalized: GovernanceEvent = {
    id: event.id ?? crypto.randomUUID(),
    ts: event.ts ?? new Date().toISOString(),
    category: event.category,
    severity: event.severity,
    runId: event.runId,
    stepId: event.stepId,
    summary: event.summary,
    files: event.files,
    commands: event.commands
  };
  await appendLine(path.join(runDir, "governance.ndjson"), JSON.stringify(normalized));
  return normalized;
}

export async function loadGovernanceEvents(runDir: string): Promise<GovernanceEvent[]> {
  const filePath = path.join(runDir, "governance.ndjson");
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as GovernanceEvent;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is GovernanceEvent => Boolean(entry));
}

export async function loadDocsSyncState(repoPath: string): Promise<{
  syncedAt?: string;
  changedFiles?: string[];
  updatedFiles?: string[];
} | null> {
  return readJsonIfExists(path.join(repoPath, ".orchestrum", "docs-sync.json"));
}

async function discoverQualityGateCommands(repoPath: string): Promise<string[]> {
  const packageJson = await readJsonIfExists<{ scripts?: Record<string, string> }>(path.join(repoPath, "package.json"));
  const scripts = packageJson?.scripts ?? {};
  const order = ["typecheck", "test", "lint", "build"];
  const selected = order.filter((name) => typeof scripts[name] === "string" && scripts[name]?.trim()).slice(0, 2);
  return selected.map((name) => `npm run ${name}`);
}
