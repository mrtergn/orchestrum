import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import crypto from "node:crypto";
import { runWorkflowDetailed } from "../runner/run.js";
import { loadWorkflow, Workflow, StepDefinition } from "../runner/workflow.js";
import { loadPromptHistory } from "../evolution/promptEvolution.js";
import { loadStrategy } from "../evolution/strategy.js";
import { loadConfig } from "../runner/config.js";
import { EventWriter } from "../runner/events.js";
import { nowTs } from "../runner/utils.js";
import { writeJson, writeText } from "../runner/fs.js";

export type TournamentResult = {
  id: string;
  createdAt: string;
  results: Array<{
    label: string;
    runId: string | null;
    ok: boolean;
    totalCost?: number;
    totalTokens?: number;
    maxRisk?: number;
    loopCount?: number;
    strategy?: string;
    promptVariant?: string;
    modelVariant?: string;
  }>;
};

export async function runTournament(options: {
  workflowPath: string;
  repoPath: string;
  runsDir: string;
  workspaceId?: string;
  goal?: string;
}): Promise<TournamentResult> {
  const workflow = await loadWorkflow(options.workflowPath);
  const config = await loadConfig(options.repoPath).catch(() => null);
  const strategyConfig = await loadStrategy(options.repoPath).catch(() => null);
  const strategyModes = strategyConfig?.available_modes ?? ["aggressive", "balanced", "conservative"];

  const promptVariants = await buildPromptVariants(options.repoPath, workflow);
  const modelVariants = buildModelVariants(config);
  if (promptVariants.length === 0) {
    promptVariants.push({ id: "current", overrides: {} });
  }
  if (modelVariants.length === 0) {
    modelVariants.push({ id: "default", models: {} });
  }

  const combinations: Array<{ strategy: string; prompt: string; model: string }> = [];
  for (const strategy of strategyModes) {
    for (const prompt of promptVariants.map((p) => p.id)) {
      for (const model of modelVariants.map((m) => m.id)) {
        combinations.push({ strategy, prompt, model });
      }
    }
  }

  const maxRuns = Math.min(6, combinations.length || 1);
  const selectedCombos = combinations.slice(0, maxRuns);

  const tournamentId = `tournament-${Date.now()}`;
  const results: TournamentResult["results"] = [];

  for (const combo of selectedCombos) {
    const promptVariant = promptVariants.find((p) => p.id === combo.prompt) ?? promptVariants[0]!;
    const modelVariant = modelVariants.find((m) => m.id === combo.model) ?? modelVariants[0]!;
    const variantPath = await writeWorkflowVariant(
      options.repoPath,
      tournamentId,
      combo,
      workflow,
      promptVariant,
      modelVariant
    );

    try {
      const runResult = await runWorkflowDetailed({
        workflowPath: variantPath,
        repoPath: options.repoPath,
        runsDir: options.runsDir,
        goal: options.goal ?? "",
        workspaceId: options.workspaceId,
        strategyMode: combo.strategy
      });
      results.push({
        label: `${combo.strategy}/${combo.prompt}/${combo.model}`,
        runId: runResult.runId,
        ok: runResult.ok,
        strategy: combo.strategy,
        promptVariant: combo.prompt,
        modelVariant: combo.model
      });
    } catch {
      results.push({
        label: `${combo.strategy}/${combo.prompt}/${combo.model}`,
        runId: null,
        ok: false,
        strategy: combo.strategy,
        promptVariant: combo.prompt,
        modelVariant: combo.model
      });
    }
  }

  const tournament: TournamentResult = {
    id: tournamentId,
    createdAt: new Date().toISOString(),
    results
  };

  await appendTournament(options.repoPath, tournament);
  await emitTournamentEvent(options.repoPath, {
    id: tournamentId,
    totalRuns: results.length,
    okRuns: results.filter((r) => r.ok).length
  });
  return tournament;
}

async function buildPromptVariants(repoPath: string, workflow: Workflow): Promise<Array<{ id: string; overrides: Record<string, string> }>> {
  const history = await loadPromptHistory(repoPath).catch(() => ({ prompts: {} }));
  const current: Record<string, string> = {};
  const previous: Record<string, string> = {};

  for (const step of workflow.steps) {
    collectPromptOverrides(step, history.prompts, current, previous);
  }

  const variants = [{ id: "current", overrides: current }];
  if (Object.keys(previous).length > 0) {
    variants.push({ id: "previous", overrides: previous });
  }
  return variants;
}

function collectPromptOverrides(
  step: StepDefinition,
  history: Record<string, { versions: Array<{ id: string; content: string }> }>,
  current: Record<string, string>,
  previous: Record<string, string>
) {
  if (step.prompt) {
    const record = history[step.prompt];
    if (record?.versions?.length) {
      const latest = record.versions[record.versions.length - 1];
      if (!latest) return;
      current[step.prompt] = latest.content;
      if (record.versions.length > 1) {
        const prev = record.versions[record.versions.length - 2];
        if (prev) {
          previous[step.prompt] = prev.content;
        }
      }
    }
  }
  if (step.substeps) {
    for (const sub of step.substeps) {
      collectPromptOverrides(sub, history, current, previous);
    }
  }
}

function buildModelVariants(config: Awaited<ReturnType<typeof loadConfig>> | null) {
  const variants: Array<{ id: string; models: Record<string, string> }> = [{ id: "default", models: {} }];
  if (config?.models && Object.keys(config.models).length > 0) {
    variants.push({ id: "config", models: config.models });
  }
  return variants;
}

async function writeWorkflowVariant(
  repoPath: string,
  tournamentId: string,
  combo: { strategy: string; prompt: string; model: string },
  workflow: Workflow,
  promptVariant: { overrides: Record<string, string> },
  modelVariant: { models: Record<string, string> }
): Promise<string> {
  const dir = path.join(repoPath, ".memory", "tournaments", tournamentId);
  const promptDir = path.join(dir, "prompts");
  await fs.mkdir(promptDir, { recursive: true });

  const clone: Workflow = JSON.parse(JSON.stringify(workflow));
  for (const [agentId, model] of Object.entries(modelVariant.models)) {
    if (clone.agents[agentId]) {
      clone.agents[agentId].model = model;
    }
  }

  clone.steps = await Promise.all(clone.steps.map((step) => applyPromptOverrides(step, promptVariant.overrides, promptDir)));

  const filePath = path.join(dir, `workflow-${combo.strategy}-${combo.prompt}-${combo.model}.yaml`);
  const yamlText = yaml.stringify({
    name: clone.name,
    agents: clone.agents,
    enable_auto_tests: clone.enable_auto_tests,
    arbitration: clone.arbitration,
    security: clone.security,
    capabilities: clone.capabilities,
    concurrency: clone.concurrency,
    loop: clone.loop,
    steps: clone.steps
  });
  await writeText(filePath, yamlText);
  return filePath;
}

async function applyPromptOverrides(
  step: StepDefinition,
  overrides: Record<string, string>,
  promptDir: string
): Promise<StepDefinition> {
  const next: StepDefinition = { ...step };
  if (next.prompt && overrides[next.prompt]) {
    const content = overrides[next.prompt];
    if (content) {
      const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
      const filePath = path.join(promptDir, `${hash}.md`);
      await writeText(filePath, content);
      next.prompt = filePath;
    }
  }
  if (next.substeps) {
    next.substeps = await Promise.all(next.substeps.map((sub) => applyPromptOverrides(sub, overrides, promptDir)));
  }
  return next;
}

async function appendTournament(repoPath: string, tournament: TournamentResult): Promise<void> {
  const memoryDir = path.join(repoPath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const filePath = path.join(memoryDir, "tournaments.json");
  let entries: TournamentResult[] = [];
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  entries.push(tournament);
  entries = entries.slice(-20);
  await writeJson(filePath, entries);
}

async function emitTournamentEvent(
  repoPath: string,
  payload: { id: string; totalRuns: number; okRuns: number }
): Promise<void> {
  const memoryDir = path.join(repoPath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const eventsPath = path.join(memoryDir, "events.ndjson");
  const events = new EventWriter(eventsPath);
  events.emit({
    t: "tournament.finished",
    tournamentId: payload.id,
    totalRuns: payload.totalRuns,
    okRuns: payload.okRuns,
    ts: nowTs()
  });
}
