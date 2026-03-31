import { z } from "zod";
import type { GovernanceProfile } from "../runner/types.js";

const GovernanceProfileSchema: z.ZodType<GovernanceProfile> = z.object({
  enabled: z.boolean().optional(),
  dangerous_command_guard: z.boolean().optional(),
  config_protection: z.boolean().optional(),
  quality_gate: z.boolean().optional()
});

export const ROLE_EXECUTION_MODES = ["auto_cli", "manual_browser", "manual_ide", "disabled"] as const;
export type RoleExecutionMode = typeof ROLE_EXECUTION_MODES[number];

export const DELIVERY_RUN_MODES = ["max_auto_supervised_hybrid", "manual_supervised"] as const;
export type DeliveryRunMode = typeof DELIVERY_RUN_MODES[number];

export const DELIVERY_TARGET_TOOLS = ["chatgpt", "cursor", "codex", "copilot", "claude"] as const;
export type DeliveryTargetTool = typeof DELIVERY_TARGET_TOOLS[number];

export const DELIVERY_TEXT_VARIANTS = ["browser_prompt", "ide_task", "patch_brief", "review_prompt"] as const;
export type DeliveryTextVariant = typeof DELIVERY_TEXT_VARIANTS[number];

export const MACHINE_CAPABILITY_KINDS = ["binary", "repo_script", "browser_handoff", "ide_handoff"] as const;
export type MachineCapabilityKind = typeof MACHINE_CAPABILITY_KINDS[number];

export const PACKET_STATUSES = [
  "pending",
  "blocked",
  "awaiting_import",
  "running",
  "completed",
  "failed"
] as const;
export type WorkPacketStatus = typeof PACKET_STATUSES[number];

export const FINDING_CATEGORIES = [
  "code_issue",
  "test_gap",
  "architecture_risk",
  "security_risk",
  "delivery_blocker",
  "follow_up"
] as const;
export type ReviewFindingCategory = typeof FINDING_CATEGORIES[number];

export const FINDING_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ReviewFindingSeverity = typeof FINDING_SEVERITIES[number];

export const FINDING_STATUSES = ["open", "accepted", "resolved", "dismissed"] as const;
export type ReviewFindingStatus = typeof FINDING_STATUSES[number];

export const REMEDIATION_STATUSES = ["open", "in_progress", "done", "blocked"] as const;
export type RemediationStatus = typeof REMEDIATION_STATUSES[number];

export const REMEDIATION_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type RemediationPriority = typeof REMEDIATION_PRIORITIES[number];

export const IMPORT_MATCH_STATUSES = ["matched", "ambiguous", "unmatched"] as const;
export type DeliveryImportMatchStatus = typeof IMPORT_MATCH_STATUSES[number];

export const EVIDENCE_KINDS = [
  "session_started",
  "packet_created",
  "packet_exported",
  "packet_imported",
  "packet_auto_executed",
  "finding_created",
  "finding_resolved",
  "remediation_created",
  "session_completed"
] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export const RoleDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  mode: z.enum(ROLE_EXECUTION_MODES),
  preferred_targets: z.array(z.string().min(1)).optional(),
  objective: z.string().optional(),
  acceptance_criteria: z.array(z.string().min(1)).optional(),
  expected_output: z.array(z.string().min(1)).optional()
});
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export const DeliveryToolProfileOverrideSchema = z.object({
  label: z.string().min(1).optional(),
  guidance: z.array(z.string().min(1)).optional(),
  response_contract: z.array(z.string().min(1)).optional(),
  text_variant: z.enum(DELIVERY_TEXT_VARIANTS).optional()
});
export type DeliveryToolProfileOverride = z.infer<typeof DeliveryToolProfileOverrideSchema>;

export const TeamPresetSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  default_run_mode: z.enum(DELIVERY_RUN_MODES).default("max_auto_supervised_hybrid"),
  roles: z.array(RoleDefinitionSchema).min(1),
  tool_preferences: z.record(z.array(z.string().min(1))).optional(),
  tool_profiles: z.record(z.string(), DeliveryToolProfileOverrideSchema).optional(),
  governance_defaults: GovernanceProfileSchema.optional(),
  packet_templates: z
    .record(
      z.object({
        objective_prefix: z.string().optional(),
        acceptance_criteria: z.array(z.string().min(1)).optional(),
        expected_output: z.array(z.string().min(1)).optional()
      })
    )
    .optional()
});
export type TeamPreset = z.infer<typeof TeamPresetSchema>;

export const MachineCapabilitySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(MACHINE_CAPABILITY_KINDS),
  label: z.string().min(1),
  available: z.boolean(),
  command: z.string().optional(),
  details: z.string().optional(),
  version: z.string().optional(),
  source: z.enum(["path", "repo", "builtin"]).optional(),
  detectedAt: z.string().optional()
});
export type MachineCapability = z.infer<typeof MachineCapabilitySchema>;

export const RoleBindingSchema = z.object({
  roleId: z.string().min(1),
  mode: z.enum(ROLE_EXECUTION_MODES),
  target: z.string().min(1),
  capabilityIds: z.array(z.string()),
  available: z.boolean(),
  reason: z.string(),
  confirmed: z.boolean().optional()
});
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const DeliverySessionRequestSchema = z.object({
  workspaceId: z.string().min(1),
  goal: z.string().min(1),
  sprintName: z.string().optional(),
  notes: z.string().optional(),
  selectedPaths: z.array(z.string().min(1)).optional(),
  runId: z.string().optional()
});
export type DeliverySessionRequest = z.infer<typeof DeliverySessionRequestSchema>;

export const WorkPacketSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  roleId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  summary: z.string().optional(),
  mode: z.enum(ROLE_EXECUTION_MODES),
  status: z.enum(PACKET_STATUSES),
  target: z.string().min(1),
  repoPath: z.string().min(1),
  workspaceId: z.string().min(1),
  goal: z.string().min(1),
  sprintName: z.string().optional(),
  selectedPaths: z.array(z.string()).default([]),
  contextNotes: z.array(z.string()).default([]),
  repoScripts: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  expectedOutput: z.array(z.string()).default([]),
  commands: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).default([]),
  remediationForFindingId: z.string().optional(),
  lastExportId: z.string().optional(),
  lastImportId: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});
export type WorkPacket = z.infer<typeof WorkPacketSchema>;

export const PacketExportSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  packetId: z.string().min(1),
  format: z.literal("markdown+json"),
  targetTool: z.enum(DELIVERY_TARGET_TOOLS),
  textVariant: z.enum(DELIVERY_TEXT_VARIANTS),
  renderedText: z.string(),
  markdown: z.string(),
  sidecar: z.record(z.unknown()),
  fileNameBase: z.string().min(1),
  createdAt: z.string().min(1)
});
export type PacketExport = z.infer<typeof PacketExportSchema>;

export const PacketImportSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  packetId: z.string().optional(),
  matchedPacketId: z.string().optional(),
  parsedPacketId: z.string().optional(),
  targetTool: z.enum(DELIVERY_TARGET_TOOLS).optional(),
  matchStatus: z.enum(IMPORT_MATCH_STATUSES).default("matched"),
  candidatePacketIds: z.array(z.string()).default([]),
  source: z.enum(["paste", "file", "auto_cli"]),
  fileName: z.string().optional(),
  rawText: z.string(),
  summary: z.string().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  matchReasons: z.array(z.string()).default([]),
  createdAt: z.string().min(1)
});
export type PacketImport = z.infer<typeof PacketImportSchema>;

export const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  packetId: z.string().optional(),
  importId: z.string().optional(),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  status: z.enum(FINDING_STATUSES),
  title: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  source: z.string().min(1),
  remediationTaskId: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const RemediationTaskSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  findingId: z.string().min(1),
  packetId: z.string().optional(),
  roleId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  priority: z.enum(REMEDIATION_PRIORITIES),
  acceptanceCriteria: z.array(z.string()).default([]),
  suggestedCommands: z.array(z.string()).optional(),
  status: z.enum(REMEDIATION_STATUSES),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});
export type RemediationTask = z.infer<typeof RemediationTaskSchema>;

export const EvidenceRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  packetId: z.string().optional(),
  findingId: z.string().optional(),
  remediationTaskId: z.string().optional(),
  kind: z.enum(EVIDENCE_KINDS),
  actor: z.enum(["system", "user", "tool"]),
  roleId: z.string().optional(),
  source: z.string().optional(),
  summary: z.string().min(1),
  createdAt: z.string().min(1),
  data: z.record(z.unknown()).optional()
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const DeliveryOutputsSchema = z.object({
  completedPacketIds: z.array(z.string()).default([]),
  openFindingIds: z.array(z.string()).default([]),
  resolvedFindingIds: z.array(z.string()).default([]),
  suggestedCommitScope: z.array(z.string()).default([]),
  humanActionItems: z.array(z.string()).default([])
});
export type DeliveryOutputs = z.infer<typeof DeliveryOutputsSchema>;

export const DeliverySessionStateSchema = z.object({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  repoPath: z.string().min(1),
  goal: z.string().min(1),
  sprintName: z.string().optional(),
  notes: z.string().optional(),
  selectedPaths: z.array(z.string()).default([]),
  status: z.enum(["running", "completed", "blocked", "failed"]),
  preset: TeamPresetSchema,
  capabilities: z.array(MachineCapabilitySchema).default([]),
  roleBindings: z.array(RoleBindingSchema).default([]),
  packets: z.array(WorkPacketSchema).default([]),
  exports: z.array(PacketExportSchema).default([]),
  imports: z.array(PacketImportSchema).default([]),
  findings: z.array(ReviewFindingSchema).default([]),
  remediations: z.array(RemediationTaskSchema).default([]),
  evidence: z.array(EvidenceRecordSchema).default([]),
  outputs: DeliveryOutputsSchema.default({
    completedPacketIds: [],
    openFindingIds: [],
    resolvedFindingIds: [],
    suggestedCommitScope: [],
    humanActionItems: []
  }),
  summary: z.string().optional(),
  worktreePath: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});
export type DeliverySessionState = z.infer<typeof DeliverySessionStateSchema>;

export const CapabilityDiscoveryResultSchema = z.object({
  workspaceId: z.string().optional(),
  repoPath: z.string().optional(),
  preset: TeamPresetSchema.nullable(),
  scaffoldPreset: TeamPresetSchema,
  capabilities: z.array(MachineCapabilitySchema),
  suggestedBindings: z.array(RoleBindingSchema)
});
export type CapabilityDiscoveryResult = z.infer<typeof CapabilityDiscoveryResultSchema>;

export const TeamPresetResponseSchema = z.object({
  workspaceId: z.string().optional(),
  repoPath: z.string().optional(),
  path: z.string().optional(),
  preset: TeamPresetSchema.nullable(),
  scaffoldPreset: TeamPresetSchema,
  capabilities: z.array(MachineCapabilitySchema),
  suggestedBindings: z.array(RoleBindingSchema)
});
export type TeamPresetResponse = z.infer<typeof TeamPresetResponseSchema>;

export const DeliveryImportAnalysisSchema = z.object({
  sessionId: z.string().min(1),
  parsedPacketId: z.string().optional(),
  matchedPacketId: z.string().optional(),
  targetTool: z.enum(DELIVERY_TARGET_TOOLS).optional(),
  matchStatus: z.enum(IMPORT_MATCH_STATUSES),
  needsPacketMatch: z.boolean().default(false),
  candidatePacketIds: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  matchReasons: z.array(z.string()).default([]),
  summary: z.string().optional()
});
export type DeliveryImportAnalysis = z.infer<typeof DeliveryImportAnalysisSchema>;

export const DeliverySummaryLatestImportSchema = z.object({
  runId: z.string().min(1),
  importId: z.string().min(1),
  createdAt: z.string().min(1),
  source: z.enum(["paste", "file", "auto_cli"]),
  fileName: z.string().optional(),
  targetTool: z.enum(DELIVERY_TARGET_TOOLS).optional(),
  matchStatus: z.enum(IMPORT_MATCH_STATUSES),
  matchedPacketId: z.string().optional(),
  summary: z.string().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  matchReasons: z.array(z.string()).default([])
});
export type DeliverySummaryLatestImport = z.infer<typeof DeliverySummaryLatestImportSchema>;

export const DeliverySummarySchema = z.object({
  workspaceId: z.string().optional(),
  sessions: z.number().int().nonnegative(),
  activeSessions: z.number().int().nonnegative(),
  blockedSessions: z.number().int().nonnegative(),
  completedSessions: z.number().int().nonnegative(),
  openFindings: z.number().int().nonnegative(),
  resolvedFindings: z.number().int().nonnegative(),
  remediationsOpen: z.number().int().nonnegative(),
  remediationsDone: z.number().int().nonnegative(),
  unresolvedManualPackets: z.number().int().nonnegative(),
  unmatchedImportAttempts: z.number().int().nonnegative(),
  packetStatusCounts: z.record(z.string(), z.number().int().nonnegative()),
  toolUsage: z.record(z.string(), z.number().int().nonnegative()),
  importConfidenceCounts: z.record(z.string(), z.number().int().nonnegative()),
  findingCategoryCounts: z.record(z.string(), z.number().int().nonnegative()),
  findingSeverityCounts: z.record(z.string(), z.number().int().nonnegative()),
  remediationPriorityCounts: z.record(z.string(), z.number().int().nonnegative()),
  latestRunId: z.string().nullable().optional(),
  latestImport: DeliverySummaryLatestImportSchema.nullable().optional()
});
export type DeliverySummary = z.infer<typeof DeliverySummarySchema>;

export function defaultRoleDefinitions(): RoleDefinition[] {
  return [
    {
      id: "planner",
      label: "Planner",
      description: "Break goals into execution packets, surface risks, and propose sequencing.",
      mode: "manual_browser",
      preferred_targets: ["chatgpt", "claude", "browser"],
      acceptance_criteria: [
        "Create a phased sprint plan with dependencies.",
        "List key risks and open questions.",
        "Call out files or subsystems that likely need changes."
      ],
      expected_output: [
        "Prioritized task list",
        "Risk register",
        "Implementation notes with file or subsystem references"
      ]
    },
    {
      id: "developer",
      label: "Developer",
      description: "Implement scoped changes and document the exact code impact.",
      mode: "manual_ide",
      preferred_targets: ["cursor", "codex", "copilot", "ide"],
      acceptance_criteria: [
        "Stay within the scoped files and constraints.",
        "Explain what changed and why.",
        "Call out tests that should be run locally."
      ],
      expected_output: [
        "Patch or implementation notes",
        "Changed files list",
        "Verification guidance"
      ]
    },
    {
      id: "auditor",
      label: "Auditor",
      description: "Review the proposed or completed work for correctness, risk, and regressions.",
      mode: "manual_browser",
      preferred_targets: ["chatgpt", "claude", "browser"],
      acceptance_criteria: [
        "List concrete findings ordered by severity.",
        "Highlight missing tests, risks, and behavioural regressions.",
        "Distinguish blockers from follow-up items."
      ],
      expected_output: [
        "Findings list with severity and category",
        "Residual risk summary",
        "Recommended remediation tasks"
      ]
    },
    {
      id: "tester",
      label: "Tester",
      description: "Run local repo validation commands and report concrete failures.",
      mode: "auto_cli",
      preferred_targets: ["local-shell", "npm", "pnpm", "yarn"],
      acceptance_criteria: [
        "Run the best available validation commands safely.",
        "Capture failures with enough evidence to remediate.",
        "Report what was not run."
      ],
      expected_output: [
        "Validation command results",
        "Failures and skipped checks",
        "Recommended next steps"
      ]
    }
  ];
}

export function createDefaultTeamPreset(): TeamPreset {
  return {
    version: 1,
    name: "Team Default",
    default_run_mode: "max_auto_supervised_hybrid",
    roles: defaultRoleDefinitions(),
    tool_preferences: {
      planner: ["chatgpt", "claude"],
      developer: ["cursor", "codex", "copilot"],
      auditor: ["chatgpt", "claude"],
      tester: ["local-shell"]
    },
    governance_defaults: {
      enabled: true,
      dangerous_command_guard: true,
      config_protection: true,
      quality_gate: false
    },
    packet_templates: {
      planner: {
        objective_prefix: "Plan the goal before implementation begins.",
        acceptance_criteria: [
          "Keep the plan grounded in the current repo context.",
          "Separate blockers from optional follow-ups."
        ]
      },
      developer: {
        objective_prefix: "Implement only the scoped work packet.",
        acceptance_criteria: [
          "Preserve existing patterns unless the packet explicitly calls for change.",
          "Surface risks instead of guessing."
        ]
      },
      auditor: {
        objective_prefix: "Review the current change set and packet outputs critically.",
        acceptance_criteria: [
          "Lead with concrete findings.",
          "Name exact regressions or missing validation."
        ]
      },
      tester: {
        objective_prefix: "Validate the branch with the safest available local commands.",
        acceptance_criteria: [
          "Prefer deterministic repo scripts.",
          "Record failures with command-level evidence."
        ]
      }
    }
  };
}
