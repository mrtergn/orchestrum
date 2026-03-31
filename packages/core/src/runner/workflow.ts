import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { z } from "zod";

const AgentSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  providers: z.array(z.string()).optional(),
  role: z.string().optional()
}).superRefine((val, ctx) => {
  if (!val.providers && (!val.provider || !val.model)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agent requires provider/model or providers list" });
  }
});

const StepBaseSchema = z.object({
  id: z.string(),
  agent: z.string().optional(),
  providers: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  apply_patch: z.boolean().optional(),
  run: z.array(z.string()).optional(),
  continue_on_error: z.boolean().optional(),
  phase: z.string().optional(),
  type: z.enum(["test_generation", "red_team"]).optional()
});

const SubstepSchema = StepBaseSchema.extend({
  id: z.string()
});

const StepSchema = StepBaseSchema.extend({
  parallel: z.boolean().optional(),
  substeps: z.array(SubstepSchema).optional()
}).superRefine((val, ctx) => {
  if (val.parallel) {
    if (!val.substeps || val.substeps.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "parallel step requires substeps" });
    }
  }
  if (!val.parallel && val.substeps && val.substeps.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "substeps only allowed when parallel=true" });
  }
  if (!val.parallel) {
    if (!val.agent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "step.agent is required" });
    }
    if (!val.prompt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "step.prompt is required" });
    }
  }
  if (val.parallel && val.substeps) {
    for (const sub of val.substeps) {
      if (!sub.agent) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `substep ${sub.id} missing agent` });
      }
      if (!sub.prompt && !val.prompt) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `substep ${sub.id} missing prompt` });
      }
    }
  }
});

const WorkflowSchema = z.object({
  extends: z.string().optional(),
  name: z.string(),
  agents: z.record(AgentSchema),
  enable_auto_tests: z.boolean().optional(),
  arbitration: z
    .object({
      mode: z.enum(["vote", "score", "fastest"]).optional(),
      min_models: z.number().int().min(1).optional()
    })
    .optional(),
  security: z
    .object({
      threshold: z.number().min(0).max(1).optional()
    })
    .optional(),
  capabilities: z
    .record(
      z.object({
        filesystem: z.enum(["read", "read_write"]).optional(),
        network: z.boolean().optional(),
        shell: z.union([z.enum(["false", "limited", "true", "none", "full"]), z.boolean()]).optional()
      })
    )
    .optional(),
  concurrency: z
    .object({
      max_agents: z.number().int().min(1)
    })
    .optional(),
  loop: z
    .object({
      max_rounds: z.number().int().min(1).default(1),
      max_loop_per_step: z.number().int().min(1).default(1),
      audit_step_id: z.string().default("audit"),
      fix_step_id: z.string().default("fix")
    })
    .optional(),
  steps: z.array(StepSchema)
});

export type AgentConfig = z.infer<typeof AgentSchema>;
export type StepDefinition = z.infer<typeof StepSchema> & {
  substeps?: StepDefinition[];
};

export type Workflow = z.infer<typeof WorkflowSchema> & {
  steps: StepDefinition[];
  __path: string;
};

export async function loadWorkflow(filePath: string): Promise<Workflow> {
  const data = await loadWorkflowSource(filePath);
  const parsed = WorkflowSchema.safeParse(data);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid workflow YAML: ${message}`);
  }

  const workflowDir = path.dirname(filePath);
  const steps = parsed.data.steps.map((step) => normalizeStep(step, workflowDir));

  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new Error(`Duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
    if (step.agent && !parsed.data.agents[step.agent]) {
      throw new Error(`Unknown agent ${step.agent} for step ${step.id}`);
    }
    if (step.substeps) {
      const subIds = new Set<string>();
      for (const sub of step.substeps) {
        if (subIds.has(sub.id)) {
          throw new Error(`Duplicate substep id: ${step.id}.${sub.id}`);
        }
        subIds.add(sub.id);
        if (sub.agent && !parsed.data.agents[sub.agent]) {
          throw new Error(`Unknown agent ${sub.agent} for substep ${step.id}.${sub.id}`);
        }
      }
    }
  }

  const loop = parsed.data.loop;
  if (loop?.audit_step_id && !ids.has(loop.audit_step_id)) {
    throw new Error(`Loop audit_step_id not found: ${loop.audit_step_id}`);
  }
  if (loop?.fix_step_id && !ids.has(loop.fix_step_id)) {
    throw new Error(`Loop fix_step_id not found: ${loop.fix_step_id}`);
  }

  return {
    ...parsed.data,
    steps,
    __path: filePath
  };
}

async function loadWorkflowSource(filePath: string, seen = new Set<string>()): Promise<unknown> {
  const absolute = path.resolve(filePath);
  if (seen.has(absolute)) {
    throw new Error(`Circular workflow extends detected: ${absolute}`);
  }
  seen.add(absolute);
  const raw = await fs.readFile(absolute, "utf8");
  const parsed = yaml.parse(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  const baseRef = typeof parsed.extends === "string" ? parsed.extends : null;
  if (!baseRef) {
    return parsed;
  }
  const basePath = path.resolve(path.dirname(absolute), baseRef);
  const base = await loadWorkflowSource(basePath, seen);
  const merged = mergeWorkflow(base as Record<string, unknown>, parsed);
  delete (merged as Record<string, unknown>).extends;
  return merged;
}

function mergeWorkflow(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "extends") continue;
    const current = merged[key];
    if (Array.isArray(value)) {
      merged[key] = value;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = mergeWorkflow(
        (current && typeof current === "object" && !Array.isArray(current)) ? (current as Record<string, unknown>) : {},
        value as Record<string, unknown>
      );
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function normalizeStep(step: StepDefinition, workflowDir: string): StepDefinition {
  const normalized: StepDefinition = {
    ...step,
    prompt: step.prompt ? path.resolve(workflowDir, step.prompt) : undefined
  };

  if (step.substeps && step.substeps.length > 0) {
    normalized.substeps = step.substeps.map((sub) => {
      const promptPath = sub.prompt
        ? path.resolve(workflowDir, sub.prompt)
        : normalized.prompt;
      return {
        ...sub,
        prompt: promptPath,
        inputs: sub.inputs ?? normalized.inputs,
        outputs: sub.outputs ?? normalized.outputs,
        apply_patch: sub.apply_patch ?? normalized.apply_patch,
        run: sub.run ?? normalized.run,
        continue_on_error: sub.continue_on_error ?? normalized.continue_on_error,
        phase: sub.phase ?? normalized.phase,
        type: sub.type ?? normalized.type
      };
    });
  }

  return normalized;
}
