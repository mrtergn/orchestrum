import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OrchestrumConfig } from "./config.js";
import type { RunState, StepState } from "./types.js";
import type { LicenseTier } from "../licensing/index.js";
import { loadEnabledPlugins, loadPluginModule } from "../plugins/registry.js";

export interface OrchestrumPlugin {
  name: string;
  onRunStart?: (runState: RunState) => void | Promise<void>;
  onStepStart?: (stepState: StepState) => void | Promise<void>;
  onStepFinish?: (stepState: StepState) => void | Promise<void>;
  onRunFinish?: (runState: RunState) => void | Promise<void>;
}

export async function loadPlugins(repoPath: string, config: OrchestrumConfig | null, tier: LicenseTier): Promise<OrchestrumPlugin[]> {
  const plugins: OrchestrumPlugin[] = [];
  const configured = config?.plugins ?? [];

  for (const entry of configured) {
    if (!entry) continue;
    if (entry.startsWith("registry:")) {
      const name = entry.replace("registry:", "");
      const enabled = await loadEnabledPlugins(tier);
      const match = enabled.find((p) => p.name === name);
      if (!match) continue;
      const plugin = await loadPluginModule(match);
      if (plugin) plugins.push(plugin);
      continue;
    }
    const resolved = path.isAbsolute(entry)
      ? entry
      : path.resolve(repoPath, entry);
    const mod = await import(pathToFileURL(resolved).toString());
    const plugin: OrchestrumPlugin | undefined = mod.default ?? mod.plugin;
    if (plugin) plugins.push(plugin);
  }

  const registryPlugins = await loadEnabledPlugins(tier);
  for (const pluginEntry of registryPlugins) {
    if (configured.some((entry) => entry.endsWith(pluginEntry.name) || entry.includes(pluginEntry.name))) continue;
    const plugin = await loadPluginModule(pluginEntry);
    if (plugin) plugins.push(plugin);
  }

  return plugins;
}

export async function runPluginHook(
  plugins: OrchestrumPlugin[],
  hook: keyof OrchestrumPlugin,
  payload: RunState | StepState
): Promise<void> {
  for (const plugin of plugins) {
    const fn = plugin[hook];
    if (typeof fn === "function") {
      try {
        await (fn as (arg: RunState | StepState) => void | Promise<void>)(payload);
      } catch {
        // ignore plugin errors
      }
    }
  }
}

export function buildStepState(input: {
  stepId: string;
  status: StepState["status"];
  agentId?: string | null;
  ok?: boolean;
  error?: string | null;
  cached?: boolean;
  commitSha?: string | null;
  parentStepId?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  costUsd?: number | null;
  riskScore?: number | null;
  provider?: string | null;
  model?: string | null;
  behavior?: {
    reasoningSummary?: string | null;
    confidence?: number | null;
    decisionPath?: string[] | null;
  } | null;
}): StepState {
  return {
    stepId: input.stepId,
    status: input.status,
    ok: input.ok,
    error: input.error ?? null,
    cached: input.cached,
    commitSha: input.commitSha ?? null,
    parentStepId: input.parentStepId,
    agentId: input.agentId ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    usage: input.usage ?? null,
    costUsd: input.costUsd ?? null,
    riskScore: input.riskScore ?? null,
    behavior: input.behavior ?? null,
    start: undefined,
    end: undefined
  };
}
