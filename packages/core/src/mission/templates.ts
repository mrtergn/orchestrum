import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditNode,
  createTemplate,
  handoffExportNode,
  handoffWaitNode,
  patchNode,
  planNode,
  validationNode
} from "./templateHelpers.js";
import type { MissionTemplate } from "./types.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.resolve(currentDir, "..", "..", "prompts");

function promptPath(name: string): string {
  return path.join(promptsDir, name);
}

const promptPaths = {
  spec: promptPath("spec.md"),
  implement: promptPath("implement.md"),
  audit: promptPath("audit.md")
};

const BUILTIN_TEMPLATES: MissionTemplate[] = [
  createTemplate({
    id: "spec-only",
    name: "Spec Only",
    description: "Produce a scoped, repo-aware plan without mutating the repository.",
    category: "implementation",
    defaultGoalHint: "Describe the feature, bug, or audit scope that needs a concrete execution plan.",
    recommendedRoles: ["pm"],
    outcomes: ["Implementation plan artifact"],
    nodes: [
      planNode({
        id: "spec",
        title: "Plan work",
        role: "pm",
        promptPath: promptPaths.spec
      })
    ]
  }),
  createTemplate({
    id: "implement-only",
    name: "Implement Only",
    description: "Apply a focused code change without adding extra planning or audit stages.",
    category: "implementation",
    defaultGoalHint: "Describe the specific implementation scope, constraints, and files or surfaces involved.",
    recommendedRoles: ["dev"],
    outcomes: ["Scoped patch artifact"],
    nodes: [
      patchNode({
        id: "implement",
        title: "Implement assigned scope",
        role: "dev",
        promptPath: promptPaths.implement,
        inputs: ["goal", "repo_context"]
      })
    ]
  }),
  createTemplate({
    id: "validation-only",
    name: "Validation Only",
    description: "Run workspace validation for an already-scoped change and capture the actual result.",
    category: "hardening",
    defaultGoalHint: "Describe what changed and what needs to be verified before review.",
    recommendedRoles: ["dev"],
    outcomes: ["Validation summary artifact"],
    nodes: [
      validationNode({
        id: "validate",
        title: "Run validation",
        role: "dev",
        inputs: ["goal", "git_diff"]
      })
    ]
  }),
  createTemplate({
    id: "audit-only",
    name: "Audit Only",
    description: "Audit the current repo state or diff without producing code changes.",
    category: "hardening",
    defaultGoalHint: "Describe what should be audited and which risks or regressions should be prioritized.",
    recommendedRoles: ["audit"],
    outcomes: ["Audit findings artifact"],
    nodes: [
      auditNode({
        id: "audit",
        title: "Audit work",
        role: "audit",
        promptPath: promptPaths.audit,
        inputs: ["goal", "repo_context", "git_diff"]
      })
    ]
  }),
  createTemplate({
    id: "feature-dev",
    name: "Feature Dev Loop",
    description: "Plan, implement, and audit a scoped feature change.",
    category: "implementation",
    defaultGoalHint: "Describe the feature change, target files, and any constraints.",
    recommendedRoles: ["pm", "dev", "audit"],
    outcomes: [
      "Implementation plan artifact",
      "Scoped patch artifact",
      "Audit findings or approval"
    ],
    nodes: [
      planNode({
        id: "spec",
        title: "Plan implementation",
        role: "pm",
        promptPath: promptPaths.spec
      }),
      patchNode({
        id: "implement",
        title: "Implement patch",
        role: "dev",
        dependsOn: ["spec"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:spec:output.md", "repo_context"]
      }),
      validationNode({
        id: "validate",
        title: "Run validation",
        role: "dev",
        dependsOn: ["implement"],
        inputs: ["artifact:spec:output.md", "git_diff"]
      }),
      auditNode({
        id: "audit",
        title: "Audit implementation",
        role: "audit",
        dependsOn: ["validate"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:spec:output.md", "git_diff", "artifact:validate:validation/summary.json"]
      })
    ]
  }),
  createTemplate({
    id: "bugfix-hotpatch",
    name: "Bugfix Hotpatch",
    description: "Diagnose a production bug, apply a minimal hotfix, and audit the regression surface.",
    category: "bugfix",
    defaultGoalHint: "Describe the bug, expected behavior, repro signal, and the smallest acceptable fix.",
    recommendedRoles: ["pm", "dev", "audit"],
    outcomes: [
      "Bug diagnosis brief",
      "Minimal hotfix patch",
      "Regression-focused audit summary"
    ],
    nodes: [
      planNode({
        id: "diagnose",
        title: "Diagnose the bug",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: [
          "Summarize current vs expected behavior and likely failure surface.",
          "Keep the fix scope minimal and explicit."
        ]
      }),
      patchNode({
        id: "hotpatch",
        title: "Apply hotfix",
        role: "dev",
        dependsOn: ["diagnose"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:diagnose:output.md", "repo_context"],
        acceptanceCriteria: [
          "Fix the defect without broad refactors.",
          "Call out any unresolved edge cases explicitly."
        ]
      }),
      validationNode({
        id: "validate",
        title: "Run hotfix validation",
        role: "dev",
        dependsOn: ["hotpatch"],
        inputs: ["artifact:diagnose:output.md", "git_diff"]
      }),
      auditNode({
        id: "regression_audit",
        title: "Audit regression surface",
        role: "audit",
        dependsOn: ["validate"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:diagnose:output.md", "git_diff", "artifact:validate:validation/summary.json"],
        acceptanceCriteria: [
          "Prioritize regressions, unsafe shortcuts, and missing validation."
        ]
      })
    ]
  }),
  createTemplate({
    id: "refactor-loop",
    name: "Refactor Loop",
    description: "Plan a refactor, apply it carefully, and audit for regressions.",
    category: "refactor",
    defaultGoalHint: "Describe the refactor target, invariants to preserve, and scope limits.",
    recommendedRoles: ["pm", "dev", "audit"],
    outcomes: [
      "Refactor plan with constraints",
      "Focused refactor patch",
      "Regression-oriented audit notes"
    ],
    nodes: [
      planNode({
        id: "spec",
        title: "Plan refactor",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: ["Name the invariants that must not regress during the refactor."]
      }),
      patchNode({
        id: "refactor",
        title: "Apply refactor",
        role: "dev",
        dependsOn: ["spec"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:spec:output.md", "repo_context"],
        acceptanceCriteria: ["Keep the refactor behavior-preserving unless the plan explicitly says otherwise."]
      }),
      validationNode({
        id: "validate",
        title: "Run refactor validation",
        role: "dev",
        dependsOn: ["refactor"],
        inputs: ["artifact:spec:output.md", "git_diff"]
      }),
      auditNode({
        id: "audit",
        title: "Audit refactor",
        role: "audit",
        dependsOn: ["validate"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:spec:output.md", "git_diff", "artifact:validate:validation/summary.json"],
        acceptanceCriteria: ["Focus on architectural regressions, hidden coupling, and missing validation."]
      })
    ]
  }),
  createTemplate({
    id: "release-hardening",
    name: "Release Hardening",
    description: "Prepare a change for release by tightening validation and auditing release risk.",
    category: "release",
    defaultGoalHint: "Describe what is about to ship, the risky surfaces, and what must be verified before release.",
    recommendedRoles: ["pm", "dev", "audit"],
    outcomes: [
      "Release readiness plan",
      "Hardening patch",
      "Verification pass",
      "Release audit notes"
    ],
    nodes: [
      planNode({
        id: "readiness_plan",
        title: "Plan release hardening",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: [
          "List release blockers, risky surfaces, and required validation."
        ]
      }),
      patchNode({
        id: "hardening_patch",
        title: "Apply hardening patch",
        role: "dev",
        dependsOn: ["readiness_plan"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:readiness_plan:output.md", "repo_context"],
        acceptanceCriteria: [
          "Reduce release risk without widening scope into new features."
        ]
      }),
      validationNode({
        id: "validation_pass",
        title: "Run release validation",
        role: "dev",
        dependsOn: ["hardening_patch"],
        inputs: ["artifact:readiness_plan:output.md", "git_diff"],
        acceptanceCriteria: [
          "Run the configured readiness checks and capture the actual result."
        ]
      }),
      auditNode({
        id: "release_audit",
        title: "Audit release readiness",
        role: "audit",
        dependsOn: ["validation_pass"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:readiness_plan:output.md", "git_diff", "artifact:validation_pass:validation/summary.json"],
        acceptanceCriteria: [
          "Call out remaining blockers, missing checks, and rollback risks."
        ]
      })
    ]
  }),
  createTemplate({
    id: "test-hardening",
    name: "Test Hardening",
    description: "Plan risk coverage, patch the code, add tests, then audit the result.",
    category: "hardening",
    defaultGoalHint: "Describe the weak behavior, missing coverage, and desired validation depth.",
    recommendedRoles: ["pm", "dev", "audit"],
    outcomes: [
      "Coverage plan",
      "Implementation patch",
      "Additional verification patch",
      "Audit summary"
    ],
    nodes: [
      planNode({
        id: "spec",
        title: "Plan test hardening",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: ["Call out the exact behavior that needs stronger validation."]
      }),
      patchNode({
        id: "implement",
        title: "Implement base patch",
        role: "dev",
        dependsOn: ["spec"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:spec:output.md", "repo_context"]
      }),
      patchNode({
        id: "test_generation",
        title: "Add tests",
        role: "dev",
        phase: "verify",
        dependsOn: ["implement"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:spec:output.md", "git_diff"],
        acceptanceCriteria: ["Add or update validation that proves the intended behavior." ]
      }),
      validationNode({
        id: "validation_pass",
        title: "Run hardening validation",
        role: "dev",
        dependsOn: ["test_generation"],
        inputs: ["artifact:spec:output.md", "git_diff"]
      }),
      auditNode({
        id: "audit",
        title: "Audit test hardening",
        role: "audit",
        dependsOn: ["validation_pass"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:spec:output.md", "git_diff", "artifact:validation_pass:validation/summary.json"],
        acceptanceCriteria: ["Confirm the added validation covers the planned risk area."]
      })
    ]
  }),
  createTemplate({
    id: "docs-sync",
    name: "Docs Sync",
    description: "Map product or code changes to docs drift, update the documentation, and audit clarity gaps.",
    category: "documentation",
    defaultGoalHint: "Describe what changed in the product or API and which docs or help surfaces may now be stale.",
    recommendedRoles: ["pm", "dev", "audit"],
    outcomes: [
      "Documentation drift brief",
      "Updated docs patch",
      "Clarity and completeness audit"
    ],
    nodes: [
      planNode({
        id: "drift_review",
        title: "Review documentation drift",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: [
          "Identify stale docs, missing examples, and unclear user-facing behavior."
        ]
      }),
      patchNode({
        id: "docs_patch",
        title: "Update documentation",
        role: "dev",
        dependsOn: ["drift_review"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:drift_review:output.md", "repo_context"],
        acceptanceCriteria: [
          "Update only the docs needed to reflect the current behavior.",
          "Keep wording concrete and user-facing."
        ]
      }),
      auditNode({
        id: "docs_audit",
        title: "Audit docs clarity",
        role: "audit",
        dependsOn: ["docs_patch"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:drift_review:output.md", "git_diff"],
        acceptanceCriteria: [
          "Check for missing examples, unclear terminology, and stale claims."
        ]
      })
    ]
  }),
  createTemplate({
    id: "security-audit",
    name: "Security Audit",
    description: "Plan security work, patch the repo, then review it with audit and red-team passes.",
    category: "security",
    defaultGoalHint: "Describe the security concern, threat model, and any sensitive surfaces involved.",
    recommendedRoles: ["pm", "dev", "audit", "security"],
    outcomes: [
      "Security-aware plan",
      "Scoped remediation patch",
      "Audit findings",
      "Red-team findings"
    ],
    nodes: [
      planNode({
        id: "spec",
        title: "Plan security work",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: ["Call out attack surface, trust boundaries, and residual risks to check."]
      }),
      patchNode({
        id: "implement",
        title: "Implement patch",
        role: "dev",
        dependsOn: ["spec"],
        promptPath: promptPaths.implement,
        inputs: ["artifact:spec:output.md", "repo_context"],
        acceptanceCriteria: ["Preserve security invariants and avoid widening scope unnecessarily."]
      }),
      validationNode({
        id: "validate",
        title: "Run security validation",
        role: "dev",
        dependsOn: ["implement"],
        inputs: ["artifact:spec:output.md", "git_diff"]
      }),
      auditNode({
        id: "audit",
        title: "Audit patch",
        role: "audit",
        dependsOn: ["validate"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:spec:output.md", "git_diff", "artifact:validate:validation/summary.json"],
        acceptanceCriteria: ["Check for regressions, unsafe assumptions, and missing tests."]
      }),
      auditNode({
        id: "red_team",
        title: "Red team review",
        role: "security",
        dependsOn: ["validate"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:spec:output.md", "git_diff", "artifact:validate:validation/summary.json"],
        acceptanceCriteria: ["Actively look for exploit paths, bypasses, and residual exposure."]
      })
    ]
  }),
  createTemplate({
    id: "delivery-sprint",
    name: "Delivery Sprint",
    description: "Plan the sprint brief, export a handoff packet, wait for import, then audit the delivery response.",
    category: "delivery",
    defaultGoalHint: "Describe the sprint objective, selected repo scope, and which handoff tool should do the work.",
    recommendedRoles: ["pm", "audit"],
    outcomes: [
      "Sprint brief",
      "External handoff packet",
      "Imported response artifacts",
      "Audit findings"
    ],
    nodes: [
      planNode({
        id: "plan",
        title: "Create sprint brief",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: ["Produce a handoff-ready brief with repo context and acceptance checks."]
      }),
      handoffExportNode({
        id: "handoff_export",
        title: "Export delivery packet",
        role: "pm",
        dependsOn: ["plan"],
        inputs: ["artifact:plan:output.md", "repo_context"],
        targetTool: "claude"
      }),
      handoffWaitNode({
        id: "handoff_wait",
        title: "Wait for delivery import",
        role: "pm",
        dependsOn: ["handoff_export"],
        targetTool: "claude"
      }),
      auditNode({
        id: "audit",
        title: "Audit imported handoff",
        role: "audit",
        dependsOn: ["handoff_wait"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:plan:output.md", "artifact:handoff_wait:response.md", "git_diff"],
        acceptanceCriteria: ["Compare imported delivery output against the sprint brief and call out gaps."]
      })
    ]
  }),
  createTemplate({
    id: "delivery-remediation-loop",
    name: "Delivery Remediation Loop",
    description: "Prepare a remediation brief, export it for external execution, import the fix response, and audit the result.",
    category: "delivery",
    defaultGoalHint: "Describe the existing delivery finding, affected files, and the exact remediation that needs to be implemented.",
    recommendedRoles: ["pm", "audit"],
    outcomes: [
      "Remediation brief",
      "External remediation packet",
      "Imported fix response",
      "Audit on the proposed remediation"
    ],
    nodes: [
      planNode({
        id: "remediation_brief",
        title: "Create remediation brief",
        role: "pm",
        promptPath: promptPaths.spec,
        acceptanceCriteria: [
          "Tie the remediation brief directly to the delivery finding and affected files."
        ]
      }),
      handoffExportNode({
        id: "remediation_export",
        title: "Export remediation packet",
        role: "pm",
        dependsOn: ["remediation_brief"],
        inputs: ["artifact:remediation_brief:output.md", "repo_context"],
        targetTool: "codex"
      }),
      handoffWaitNode({
        id: "remediation_wait",
        title: "Wait for remediation import",
        role: "pm",
        dependsOn: ["remediation_export"],
        targetTool: "codex"
      }),
      auditNode({
        id: "remediation_audit",
        title: "Audit remediation response",
        role: "audit",
        dependsOn: ["remediation_wait"],
        promptPath: promptPaths.audit,
        inputs: ["artifact:remediation_brief:output.md", "artifact:remediation_wait:response.md", "git_diff"],
        acceptanceCriteria: [
          "Verify the remediation actually closes the original delivery gap."
        ]
      })
    ]
  })
];

export function listMissionTemplates(): Array<{
  name: string;
  title: string;
  description: string;
  source?: string;
  category: MissionTemplate["category"];
  defaultGoalHint?: string;
  recommendedRoles?: string[];
  outcomes?: string[];
  nodeCount: number;
}> {
  return BUILTIN_TEMPLATES.map((template) => ({
    name: template.id,
    title: template.name,
    description: template.description,
    source: "builtin",
    category: template.category,
    defaultGoalHint: template.defaultGoalHint,
    recommendedRoles: template.recommendedRoles,
    outcomes: template.outcomes,
    nodeCount: template.nodes.length
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
