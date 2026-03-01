import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJson, readJsonIfExists, ensureDir } from "../runner/fs.js";
import type { OrchestrumConfig } from "../runner/config.js";

const ProfileSchema = z.object({
  risk_tolerance: z.enum(["low", "medium", "high"]).optional(),
  max_cost_per_run: z.number().min(0).optional(),
  default_strategy: z.string().optional(),
  sandbox_mode: z.enum(["docker", "local"]).optional()
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
  return merged;
}
