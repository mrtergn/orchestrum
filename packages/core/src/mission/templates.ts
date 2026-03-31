import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MissionTemplate } from "./types.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.resolve(currentDir, "..", "..", "prompts");

function promptPath(name: string): string {
  return path.join(promptsDir, name);
}

const BUILTIN_TEMPLATES: MissionTemplate[] = [
  {
    id: "feature-dev",
    name: "Feature Dev Loop",
    description: "PM spec -> DEV implement -> AUDIT",
    nodes: [
      {
        id: "spec",
        title: "Plan implementation",
        role: "pm",
        executor: "prompt",
        promptPath: promptPath("spec.md"),
        inputs: ["goal", "repo_context"]
      },
      {
        id: "implement",
        title: "Implement patch",
        role: "dev",
        executor: "patch",
        dependsOn: ["spec"],
        promptPath: promptPath("implement.md"),
        inputs: ["artifact:spec:output.md", "repo_context"],
        approvalOnDiff: true
      },
      {
        id: "audit",
        title: "Audit implementation",
        role: "audit",
        executor: "audit",
        dependsOn: ["implement"],
        promptPath: promptPath("audit.md"),
        inputs: ["artifact:spec:output.md", "git_diff"]
      }
    ]
  },
  {
    id: "refactor-loop",
    name: "Refactor Loop",
    description: "PM spec -> DEV refactor -> AUDIT",
    nodes: [
      {
        id: "spec",
        title: "Plan refactor",
        role: "pm",
        executor: "prompt",
        promptPath: promptPath("spec.md"),
        inputs: ["goal", "repo_context"]
      },
      {
        id: "refactor",
        title: "Apply refactor",
        role: "dev",
        executor: "patch",
        dependsOn: ["spec"],
        promptPath: promptPath("implement.md"),
        inputs: ["artifact:spec:output.md", "repo_context"],
        approvalOnDiff: true
      },
      {
        id: "audit",
        title: "Audit refactor",
        role: "audit",
        executor: "audit",
        dependsOn: ["refactor"],
        promptPath: promptPath("audit.md"),
        inputs: ["artifact:spec:output.md", "git_diff"]
      }
    ]
  },
  {
    id: "test-hardening",
    name: "Test Hardening",
    description: "PM spec -> DEV implement -> DEV tests -> AUDIT",
    nodes: [
      {
        id: "spec",
        title: "Plan test hardening",
        role: "pm",
        executor: "prompt",
        promptPath: promptPath("spec.md"),
        inputs: ["goal", "repo_context"]
      },
      {
        id: "implement",
        title: "Implement base patch",
        role: "dev",
        executor: "patch",
        dependsOn: ["spec"],
        promptPath: promptPath("implement.md"),
        inputs: ["artifact:spec:output.md", "repo_context"],
        approvalOnDiff: true
      },
      {
        id: "test_generation",
        title: "Add tests",
        role: "dev",
        executor: "patch",
        dependsOn: ["implement"],
        promptPath: promptPath("implement.md"),
        inputs: ["artifact:spec:output.md", "git_diff"],
        approvalOnDiff: true
      },
      {
        id: "audit",
        title: "Audit test hardening",
        role: "audit",
        executor: "audit",
        dependsOn: ["test_generation"],
        promptPath: promptPath("audit.md"),
        inputs: ["artifact:spec:output.md", "git_diff"]
      }
    ]
  },
  {
    id: "security-audit",
    name: "Security Audit",
    description: "PM spec -> DEV implement -> AUDIT -> security red team",
    nodes: [
      {
        id: "spec",
        title: "Plan security work",
        role: "pm",
        executor: "prompt",
        promptPath: promptPath("spec.md"),
        inputs: ["goal", "repo_context"]
      },
      {
        id: "implement",
        title: "Implement patch",
        role: "dev",
        executor: "patch",
        dependsOn: ["spec"],
        promptPath: promptPath("implement.md"),
        inputs: ["artifact:spec:output.md", "repo_context"],
        approvalOnDiff: true
      },
      {
        id: "audit",
        title: "Audit patch",
        role: "audit",
        executor: "audit",
        dependsOn: ["implement"],
        promptPath: promptPath("audit.md"),
        inputs: ["artifact:spec:output.md", "git_diff"]
      },
      {
        id: "red_team",
        title: "Red team review",
        role: "security",
        executor: "audit",
        dependsOn: ["implement"],
        promptPath: promptPath("audit.md"),
        inputs: ["artifact:spec:output.md", "git_diff"]
      }
    ]
  },
  {
    id: "delivery-sprint",
    name: "Delivery Sprint",
    description: "PM plans -> packet export -> waits for handoff import -> audit",
    nodes: [
      {
        id: "plan",
        title: "Create sprint brief",
        role: "pm",
        executor: "prompt",
        promptPath: promptPath("spec.md"),
        inputs: ["goal", "repo_context"]
      },
      {
        id: "handoff_export",
        title: "Export delivery packet",
        role: "pm",
        executor: "delivery.export",
        dependsOn: ["plan"],
        inputs: ["artifact:plan:output.md", "repo_context"],
        targetTool: "claude"
      },
      {
        id: "handoff_wait",
        title: "Wait for delivery import",
        role: "pm",
        executor: "delivery.wait",
        dependsOn: ["handoff_export"],
        targetTool: "claude"
      },
      {
        id: "audit",
        title: "Audit imported handoff",
        role: "audit",
        executor: "audit",
        dependsOn: ["handoff_wait"],
        promptPath: promptPath("audit.md"),
        inputs: ["artifact:plan:output.md", "artifact:handoff_wait:response.md", "git_diff"]
      }
    ]
  }
];

export function listMissionTemplates(): Array<{ name: string; title: string; description: string; source?: string }> {
  return BUILTIN_TEMPLATES.map((template) => ({
    name: template.id,
    title: template.name,
    description: template.description,
    source: "builtin"
  }));
}

export function loadMissionTemplate(templateId: string): MissionTemplate {
  const normalized = templateId.trim().replace(/\.ya?ml$/i, "");
  const template = BUILTIN_TEMPLATES.find((entry) => entry.id === normalized);
  if (!template) {
    throw new Error(`Mission template not found: ${templateId}`);
  }
  return JSON.parse(JSON.stringify(template)) as MissionTemplate;
}
