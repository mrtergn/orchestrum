import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runBinary } from "../runner/bin.js";
import { readJsonIfExists } from "../runner/fs.js";
import { createDefaultTeamPreset } from "./types.js";
import type {
  DeliverySessionState,
  MachineCapability,
  RemediationTask,
  RoleBinding,
  RoleDefinition,
  TeamPreset,
  WorkPacket
} from "./types.js";

export type DeliveryRepoContext = {
  branch: string | null;
  readiness: string[];
  learnings: string[];
  selectedFileNotes: string[];
  repoScripts: string[];
};

export function buildInitialPackets(options: {
  runId: string;
  workspaceId: string;
  repoPath: string;
  goal: string;
  sprintName?: string;
  selectedPaths: string[];
  notes?: string;
  preset: TeamPreset;
  roleBindings: RoleBinding[];
  context: DeliveryRepoContext;
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

export function buildRemediationPacket(session: DeliverySessionState, remediation: RemediationTask, createdAt: string): WorkPacket {
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
      `Generated from finding ${remediation.findingId}.`,
      `Priority: ${remediation.priority}`
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

export function buildAutoCliCommands(repoPath: string, repoScripts: string[]): string[] {
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

export async function loadRepoScripts(repoPath: string): Promise<{
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

export async function loadSelectedPathNotes(repoPath: string, selectedPaths: string[]): Promise<string[]> {
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

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const result = await runBinary("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export function createScaffoldTeamPreset(capabilities: MachineCapability[]): TeamPreset {
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
