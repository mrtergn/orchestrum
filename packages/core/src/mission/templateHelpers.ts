import type {
  MissionInputRef,
  MissionNodePhase,
  MissionNodeTemplate,
  MissionTemplate,
  MissionTemplateCategory
} from "./types.js";

type NodeBaseOptions = {
  id: string;
  title: string;
  role: string;
  dependsOn?: string[];
  inputs?: MissionInputRef[];
  acceptanceCriteria?: string[];
};

type PromptNodeOptions = NodeBaseOptions & {
  promptPath: string;
};

type HandoffNodeOptions = NodeBaseOptions & {
  targetTool: "chatgpt" | "claude" | "cursor" | "codex" | "copilot";
};

type TemplateOptions = {
  id: string;
  name: string;
  description: string;
  category: MissionTemplateCategory;
  defaultGoalHint: string;
  recommendedRoles: string[];
  outcomes: string[];
  nodes: MissionNodeTemplate[];
};

function mergeAcceptanceCriteria(defaults: string[], extra?: string[]): string[] {
  return [...defaults, ...(extra ?? [])];
}

function createNode(options: Omit<MissionNodeTemplate, "dependsOn"> & { dependsOn?: string[] }): MissionNodeTemplate {
  return {
    ...options,
    dependsOn: options.dependsOn ?? []
  };
}

export function createTemplate(options: TemplateOptions): MissionTemplate {
  return { ...options };
}

export function planNode(options: PromptNodeOptions): MissionNodeTemplate {
  return createNode({
    id: options.id,
    title: options.title,
    role: options.role,
    executor: "prompt",
    phase: "plan",
    promptPath: options.promptPath,
    dependsOn: options.dependsOn,
    inputs: options.inputs ?? ["goal", "repo_context"],
    acceptanceCriteria: mergeAcceptanceCriteria([
      "Produce a concrete, repo-aware plan before implementation starts.",
      "Call out constraints, assumptions, and likely risk areas."
    ], options.acceptanceCriteria)
  });
}

export function patchNode(options: PromptNodeOptions & { phase?: Extract<MissionNodePhase, "implement" | "verify"> }): MissionNodeTemplate {
  return createNode({
    id: options.id,
    title: options.title,
    role: options.role,
    executor: "patch",
    phase: options.phase ?? "implement",
    promptPath: options.promptPath,
    dependsOn: options.dependsOn,
    inputs: options.inputs,
    approvalOnDiff: true,
    acceptanceCriteria: mergeAcceptanceCriteria([
      "Apply the smallest defensible patch that satisfies the assigned scope.",
      "Preserve existing behavior outside the requested change.",
      "Name verification performed or clearly state what remains unverified."
    ], options.acceptanceCriteria)
  });
}

export function auditNode(options: PromptNodeOptions): MissionNodeTemplate {
  return createNode({
    id: options.id,
    title: options.title,
    role: options.role,
    executor: "audit",
    phase: "review",
    promptPath: options.promptPath,
    dependsOn: options.dependsOn,
    inputs: options.inputs,
    acceptanceCriteria: mergeAcceptanceCriteria([
      "Review for correctness, regressions, and missing validation.",
      "Lead with concrete findings ordered by severity."
    ], options.acceptanceCriteria)
  });
}

export function handoffExportNode(options: HandoffNodeOptions): MissionNodeTemplate {
  return createNode({
    id: options.id,
    title: options.title,
    role: options.role,
    executor: "delivery.export",
    phase: "handoff",
    dependsOn: options.dependsOn,
    inputs: options.inputs,
    targetTool: options.targetTool,
    acceptanceCriteria: mergeAcceptanceCriteria([
      "Export a packet with clear scope, context, and expected output.",
      "Choose the target tool that best matches the packet type."
    ], options.acceptanceCriteria)
  });
}

export function handoffWaitNode(options: HandoffNodeOptions): MissionNodeTemplate {
  return createNode({
    id: options.id,
    title: options.title,
    role: options.role,
    executor: "delivery.wait",
    phase: "handoff",
    dependsOn: options.dependsOn,
    targetTool: options.targetTool,
    inputs: options.inputs,
    acceptanceCriteria: mergeAcceptanceCriteria([
      "Pause until the external handoff response is imported.",
      "Preserve packet identity so imports can be matched safely."
    ], options.acceptanceCriteria)
  });
}
