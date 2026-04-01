import type { OrchestrumConfig } from "./config.js";
import type { RunState, StepState } from "./types.js";
import { appendWorkspaceSignal } from "./signals.js";
import { loadEnabledPlugins, loadPluginModule } from "../plugins/registry.js";

export interface OrchestrumPlugin {
  name: string;
  onRunStart?: (runState: RunState) => void | Promise<void>;
  onStepStart?: (stepState: StepState) => void | Promise<void>;
  onStepFinish?: (stepState: StepState) => void | Promise<void>;
  onRunFinish?: (runState: RunState) => void | Promise<void>;
}

type PluginHookContext = {
  repoPath?: string;
  workspaceId?: string;
  entityId?: string;
};

export async function loadPlugins(repoPath: string, config: OrchestrumConfig | null): Promise<OrchestrumPlugin[]> {
  const plugins: OrchestrumPlugin[] = [];
  const configured = (config?.plugins ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const registryPlugins = await loadEnabledPlugins(repoPath);
  const registryByName = new Map(registryPlugins.map((plugin) => [plugin.name, plugin]));
  const selectedNames = configured.length === 0
    ? registryPlugins.map((plugin) => plugin.name)
    : configured.map((entry) => {
        if (entry.includes("/") || entry.includes("\\") || entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".ts")) {
          throw new Error(`Direct path plugins are no longer supported: ${entry}`);
        }
        return entry.startsWith("registry:") ? entry.slice("registry:".length) : entry;
      });

  for (const name of selectedNames) {
    const pluginEntry = registryByName.get(name);
    if (!pluginEntry) continue;
    const plugin = await loadPluginModule(pluginEntry);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

export async function runPluginHook(
  plugins: OrchestrumPlugin[],
  hook: keyof OrchestrumPlugin,
  payload: RunState | StepState,
  context: PluginHookContext = {}
): Promise<void> {
  for (const plugin of plugins) {
    const fn = plugin[hook];
    if (typeof fn === "function") {
      try {
        await (fn as (arg: RunState | StepState) => void | Promise<void>)(payload);
      } catch (error) {
        if (context.repoPath && context.workspaceId) {
          await appendWorkspaceSignal(context.repoPath, {
            workspaceId: context.workspaceId,
            source: "plugin",
            type: "plugin.hook.failed",
            entityId: context.entityId ?? plugin.name,
            status: "warning",
            summary: `${plugin.name} failed during ${String(hook)}`,
            payload: {
              plugin: plugin.name,
              hook,
              error: error instanceof Error ? error.message : String(error)
            }
          }).catch(() => undefined);
        }
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
