import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensureDir, writeJson } from "./fs.js";
import { applyProfileToConfig, loadWorkspaceProfile } from "../profiles/index.js";
import { getOperatorControlDir, getWorkspaceConfigPath, getWorkspacePoliciesPath } from "./control.js";
import { migrateOrchestrumConfig } from "../migrations/index.js";
import type { RepoExecutionProfile } from "./types.js";

const ConcurrencySchema = z.union([
  z.number().int().min(1),
  z.object({
    max_agents: z.number().int().min(1)
  })
]);

const PricingSchema = z.record(
  z.object({
    prompt_per_1k: z.number().min(0),
    completion_per_1k: z.number().min(0)
  })
);

const PolicySchema = z.object({
  max_files_changed: z.number().int().min(1).optional(),
  forbidden_paths: z.array(z.string()).optional(),
  max_cost_usd: z.number().min(0).optional(),
  risk_tolerance: z.enum(["low", "medium", "high"]).optional(),
  protected_paths: z.array(z.string()).optional(),
  blocked_commands: z.array(z.string()).optional(),
  approval_paths: z.array(z.string()).optional(),
  approval_commands: z.array(z.string()).optional(),
  approval_providers: z.array(z.string()).optional(),
  validation_commands: z.array(z.string()).optional(),
  quality_gate_commands: z.array(z.string()).optional()
});

const RepoExecutionSchema: z.ZodType<RepoExecutionProfile> = z.object({
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

const ConfigSchema = z.object({
  version: z.literal(1).optional(),
  concurrency: ConcurrencySchema.optional(),
  models: z.record(z.string()).optional(),
  arbitration: z
    .object({
      mode: z.enum(["vote", "score", "fastest"]).optional(),
      min_models: z.number().int().min(1).optional()
    })
    .optional(),
  local_llm: z
    .object({
      provider: z.string(),
      endpoint: z.string(),
      model: z.string().optional()
    })
    .optional(),
  reward: z
    .object({
      success_weight: z.number().optional(),
      cost_weight: z.number().optional(),
      loop_penalty: z.number().optional(),
      risk_penalty: z.number().optional()
    })
    .optional(),
  sandbox: z
    .object({
      enabled: z.boolean().optional(),
      image: z.string().optional(),
      network: z.boolean().optional(),
      user: z.string().optional(),
      cpu_limit: z.number().positive().optional(),
      memory_limit_mb: z.number().positive().optional()
    })
    .optional(),
  execution: z
    .object({
      mode: z.enum(["inline", "worktree"]).optional()
    })
    .optional(),
  browser: z
    .object({
      base_url: z.string().url().optional(),
      headless: z.boolean().optional()
    })
    .optional(),
  governance: z
    .object({
      enabled: z.boolean().optional(),
      dangerous_command_guard: z.boolean().optional(),
      config_protection: z.boolean().optional(),
      quality_gate: z.boolean().optional()
    })
    .optional(),
  strategy: z
    .object({
      mode: z.string().optional()
    })
    .optional(),
  policy: PolicySchema.optional(),
  repo_execution: RepoExecutionSchema.optional(),
  plugins: z.array(z.string()).optional(),
  pricing: PricingSchema.optional(),
  shell_allowlist: z.array(z.string()).optional(),
  telemetry: z
    .object({
      enabled: z.boolean().optional(),
      endpoint: z.string().optional()
    })
    .optional(),
  updates: z
    .object({
      channel: z.enum(["stable", "beta"]).optional()
    })
    .optional(),
  service: z
    .object({
      port: z.number().int().min(1).optional(),
      runs_dir: z.string().optional()
    })
    .optional()
});

export type OrchestrumConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(repoPath: string, overrides?: Partial<OrchestrumConfig>): Promise<OrchestrumConfig | null> {
  const global = await loadGlobalConfig().catch(() => null);
  const workspace = await loadWorkspaceConfig(repoPath).catch(() => null);
  const workspacePolicies = await loadWorkspacePolicies(repoPath).catch(() => null);
  const profile = await loadWorkspaceProfile(repoPath).catch(() => null);
  const profileConfig = applyProfileToConfig(profile, null);
  return mergeConfigs(global, workspace, workspacePolicies ? { policy: workspacePolicies } : null, profileConfig, overrides);
}

export async function loadGlobalConfig(): Promise<OrchestrumConfig | null> {
  const configPath = getGlobalConfigPath();
  return loadConfigFile(configPath);
}

export async function loadWorkspaceConfig(repoPath: string): Promise<OrchestrumConfig | null> {
  const rootPath = path.join(repoPath, "orchestrum.config.json");
  const workspacePath = getWorkspaceConfigPath(repoPath);
  const rootConfig = await loadConfigFile(rootPath).catch(() => null);
  const workspaceConfig = await loadConfigFile(workspacePath).catch(() => null);
  return mergeConfigs(rootConfig, workspaceConfig);
}

export async function saveGlobalConfig(config: OrchestrumConfig): Promise<void> {
  const configPath = getGlobalConfigPath();
  await ensureDir(path.dirname(configPath));
  await writeJson(configPath, config);
}

export async function saveWorkspaceConfig(repoPath: string, config: OrchestrumConfig): Promise<void> {
  const configPath = getWorkspaceConfigPath(repoPath);
  await ensureDir(path.dirname(configPath));
  await writeJson(configPath, config);
}

export async function loadWorkspacePolicies(repoPath: string): Promise<OrchestrumConfig["policy"] | null> {
  try {
    const raw = await fs.readFile(getWorkspacePoliciesPath(repoPath), "utf8");
    const parsed = PolicySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join("; ");
      throw new Error(`Invalid policy config: ${message}`);
    }
    return parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function saveWorkspacePolicies(repoPath: string, policy: OrchestrumConfig["policy"]): Promise<void> {
  const filePath = getWorkspacePoliciesPath(repoPath);
  await ensureDir(path.dirname(filePath));
  await writeJson(filePath, policy ?? {});
}

export function resolveConcurrency(config?: OrchestrumConfig | null): number | undefined {
  if (!config?.concurrency) return undefined;
  if (typeof config.concurrency === "number") return config.concurrency;
  return config.concurrency.max_agents;
}

export function getGlobalConfigPath(): string {
  return path.join(getOperatorControlDir(process.cwd()), "config.json");
}

async function loadConfigFile(filePath: string): Promise<OrchestrumConfig | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = migrateOrchestrumConfig(JSON.parse(raw));
    const parsed = ConfigSchema.safeParse(data);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Invalid config at ${filePath}: ${message}`);
    }
    return parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function mergeConfigs(...configs: Array<OrchestrumConfig | null | undefined>): OrchestrumConfig | null {
  const filtered = configs.filter(Boolean) as OrchestrumConfig[];
  if (filtered.length === 0) return null;
  return filtered.reduce((acc, current) => deepMerge(acc, current), {}) as OrchestrumConfig;
}

function deepMerge<T extends Record<string, any>>(base: T, override: T): T {
  const merged: T = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key as keyof T] = deepMerge(
        (merged[key as keyof T] as Record<string, any>) ?? {},
        value as Record<string, any>
      ) as T[keyof T];
    } else if (value !== undefined) {
      merged[key as keyof T] = value as T[keyof T];
    }
  }
  return merged;
}
