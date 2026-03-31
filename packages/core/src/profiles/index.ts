import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJson, readJsonIfExists, ensureDir } from "../runner/fs.js";
import type { OrchestrumConfig } from "../runner/config.js";
import type { RepoExecutionProfile } from "../runner/types.js";

const RepoExecutionProfileSchema: z.ZodType<RepoExecutionProfile> = z.object({
  package_manager: z.enum(["npm", "pnpm", "yarn"]).optional(),
  commands: z.object({
    lint: z.string().min(1).optional(),
    typecheck: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
    build: z.string().min(1).optional(),
    smoke: z.string().min(1).optional(),
    dev: z.string().min(1).optional()
  }).optional(),
  protected_paths: z.array(z.string().min(1)).optional(),
  risky_commands: z.array(z.string().min(1)).optional(),
  readiness_requirements: z.array(z.string().min(1)).optional()
});

const ProfileSchema = z.object({
  risk_tolerance: z.enum(["low", "medium", "high"]).optional(),
  max_cost_per_run: z.number().min(0).optional(),
  default_strategy: z.string().optional(),
  sandbox_mode: z.enum(["docker", "local"]).optional(),
  execution_mode: z.enum(["inline", "worktree"]).optional(),
  browser_base_url: z.string().url().optional(),
  governance: z.object({
    enabled: z.boolean().optional(),
    dangerous_command_guard: z.boolean().optional(),
    config_protection: z.boolean().optional(),
    quality_gate: z.boolean().optional()
  }).optional(),
  repo_execution: RepoExecutionProfileSchema.optional()
});

export type WorkspaceProfile = z.infer<typeof ProfileSchema>;

export function getProfilePath(repoPath: string): string {
  return path.join(repoPath, ".orchestrum", "profile.json");
}

export async function loadWorkspaceProfile(repoPath: string): Promise<WorkspaceProfile | null> {
  const primaryPath = getProfilePath(repoPath);
  const raw = await readJsonIfExists<WorkspaceProfile>(primaryPath);
  if (!raw) return null;
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid profile at ${primaryPath}: ${message}`);
  }
  return parsed.data;
}

export async function saveWorkspaceProfile(repoPath: string, profile: WorkspaceProfile): Promise<void> {
  const parsed = ProfileSchema.safeParse(profile);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid profile: ${message}`);
  }
  const filePath = getProfilePath(repoPath);
  await ensureDir(path.dirname(filePath));
  await writeJson(filePath, parsed.data);
}

export function applyProfileToConfig(profile: WorkspaceProfile | null, config: OrchestrumConfig | null): OrchestrumConfig | null {
  if (!profile) return config;
  const merged: OrchestrumConfig = { ...(config ?? {}) };
  if (profile.sandbox_mode === "docker") {
    merged.sandbox = { ...(merged.sandbox ?? {}), enabled: true };
  }
  if (profile.sandbox_mode === "local") {
    merged.sandbox = { ...(merged.sandbox ?? {}), enabled: false };
  }
  if (profile.default_strategy) {
    merged.strategy = { ...(merged.strategy ?? {}), mode: profile.default_strategy };
  }
  if (profile.max_cost_per_run !== undefined) {
    merged.policy = { ...(merged.policy ?? {}), max_cost_usd: profile.max_cost_per_run };
  }
  if (profile.risk_tolerance) {
    merged.policy = {
      ...(merged.policy ?? {}),
      risk_tolerance: profile.risk_tolerance
    };
  }
  if (profile.execution_mode) {
    merged.execution = {
      ...(merged.execution ?? {}),
      mode: profile.execution_mode
    };
  }
  if (profile.browser_base_url) {
    merged.browser = {
      ...(merged.browser ?? {}),
      base_url: profile.browser_base_url
    };
  }
  if (profile.governance) {
    merged.governance = {
      ...(merged.governance ?? {}),
      ...profile.governance
    };
  }
  if (profile.repo_execution) {
    merged.repo_execution = {
      ...(merged.repo_execution ?? {}),
      ...profile.repo_execution,
      commands: {
        ...(merged.repo_execution?.commands ?? {}),
        ...(profile.repo_execution.commands ?? {})
      }
    };
  }
  return merged;
}
