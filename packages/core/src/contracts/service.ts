import type {
  GovernanceProfile,
  RepoExecutionProfile,
  RunKind,
  RunReadiness,
  RunState,
  StepState
} from "../runner/types.js";
import type { ChangeStatus, PauseReason, RunVerdict, ValidationStatus } from "../types/status.js";
import type {
  CapabilityDiscoveryResult,
  DeliveryImportAnalysis,
  DeliverySessionRequest,
  DeliverySessionState,
  DeliverySummary,
  DeliveryTargetTool,
  EvidenceRecord,
  MachineCapability,
  PacketExport,
  PacketImport,
  RemediationTask,
  ReviewFinding,
  RoleBinding,
  RoleDefinition,
  TeamPreset,
  TeamPresetResponse,
  WorkPacket
} from "../delivery/types.js";
import type { MissionGraph, MissionNode } from "../mission/types.js";

export const TASK_RUNTIME_STATUSES = [
  "queued",
  "running",
  "paused",
  "blocked",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export type TaskRuntimeStatus = typeof TASK_RUNTIME_STATUSES[number];

export type AgentRuntimeState = "active" | "idle" | "sleeping" | "error";

export const WORK_ITEM_SOURCE_TYPES = [
  "feature",
  "pbi",
  "bug",
  "pr_hardening"
] as const;

export type WorkItemSourceType = typeof WORK_ITEM_SOURCE_TYPES[number];

export const WORK_ITEM_STATUSES = [
  "draft",
  "running",
  "blocked",
  "ready_for_review",
  "completed",
  "failed"
] as const;

export type WorkItemStatus = typeof WORK_ITEM_STATUSES[number];

export const WORK_ITEM_EXECUTION_MODES = ["mission", "task_graph"] as const;

export type WorkItemExecutionMode = typeof WORK_ITEM_EXECUTION_MODES[number];

export const WORK_ITEM_REVIEW_STATUSES = [
  "pending",
  "approved",
  "changes_requested"
] as const;

export type WorkItemReviewStatus = typeof WORK_ITEM_REVIEW_STATUSES[number];

export const WORK_ITEM_REVIEW_ACTIONS = ["approve", "send_back"] as const;

export type WorkItemReviewAction = typeof WORK_ITEM_REVIEW_ACTIONS[number];

export const WORK_ITEM_REVIEW_GATES = [
  "not_ready",
  "ready",
  "approved",
  "changes_requested"
] as const;

export type WorkItemReviewGate = typeof WORK_ITEM_REVIEW_GATES[number];

export const WORK_ITEM_REVIEW_SIGNAL_STATUSES = [
  "passed",
  "failed",
  "blocked",
  "pending",
  "missing"
] as const;

export type WorkItemReviewSignalStatus = typeof WORK_ITEM_REVIEW_SIGNAL_STATUSES[number];

export const WORK_ITEM_CYCLE_KINDS = ["initial", "remediation"] as const;

export type WorkItemCycleKind = typeof WORK_ITEM_CYCLE_KINDS[number];

export const WORK_ITEM_CYCLE_STATUSES = [
  "running",
  "blocked",
  "review_ready",
  "changes_requested",
  "approved",
  "failed"
] as const;

export type WorkItemCycleStatus = typeof WORK_ITEM_CYCLE_STATUSES[number];

export const WORK_ITEM_REMEDIATION_PLAN_STATUSES = [
  "suggested",
  "launched",
  "resolved"
] as const;

export type WorkItemRemediationPlanStatus = typeof WORK_ITEM_REMEDIATION_PLAN_STATUSES[number];

export const WORK_ITEM_WORKSTREAM_TYPES = [
  "plan",
  "implement",
  "integrate",
  "validate",
  "qa_smoke",
  "qa_scenario",
  "audit"
] as const;

export type WorkItemWorkstreamType = typeof WORK_ITEM_WORKSTREAM_TYPES[number];

export const WORK_ITEM_WORKSTREAM_STATUSES = [
  "planned",
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export type WorkItemWorkstreamStatus = typeof WORK_ITEM_WORKSTREAM_STATUSES[number];

export const WORK_ITEM_GATE_TYPES = [
  "validation",
  "qa_scenario",
  "audit",
  "delivery"
] as const;

export type WorkItemGateType = typeof WORK_ITEM_GATE_TYPES[number];

export const WORK_ITEM_GATE_STATUSES = [
  "pending",
  "passed",
  "failed",
  "blocked",
  "skipped"
] as const;

export type WorkItemGateStatus = typeof WORK_ITEM_GATE_STATUSES[number];

export const WORK_ITEM_OPTIMIZATION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "converted"
] as const;

export type WorkItemOptimizationStatus = typeof WORK_ITEM_OPTIMIZATION_STATUSES[number];

export type WorkItemBrief = {
  workspaceId: string;
  sourceType: WorkItemSourceType;
  title: string;
  request: string;
  sourceRef?: string | null;
  acceptanceCriteria: string[];
  constraints: string[];
};

export type WorkItemRecord = {
  id: string;
  workspaceId: string;
  brief: WorkItemBrief;
  status: WorkItemStatus;
  recommendedTemplateId: string;
  executionMode?: WorkItemExecutionMode | null;
  linkedRunId?: string | null;
  linkedRunStatus?: string | null;
  linkedRunVerdict?: RunVerdict | null;
  linkedTaskIds?: string[];
  linkedTaskStatus?: string | null;
  reviewStatus?: WorkItemReviewStatus | null;
  reviewNote?: string | null;
  reviewedAt?: string | null;
  currentCycleId?: string | null;
  cycles?: WorkItemCycleRecord[];
  remediationPlan?: WorkItemRemediationPlan | null;
  optimization?: WorkItemOptimizationSummary | null;
  createdAt: string;
  updatedAt: string;
  lastStartedAt?: string | null;
};

export type WorkItemsResponse = {
  workItems: WorkItemRecord[];
};

export type WorkItemCreateRequest = {
  workspaceId: string;
  sourceType: WorkItemSourceType;
  title: string;
  request: string;
  sourceRef?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
};

export type WorkItemStartRequest = {
  workspaceId?: string;
  options?: RunStartOptions;
};

export type WorkItemStartResponse = RunStartResponse & {
  workItem?: WorkItemRecord;
};

export type WorkItemReviewRequest = {
  workspaceId?: string;
  decision: WorkItemReviewAction;
  note?: string;
};

export type WorkItemReviewSignal = {
  label: string;
  status: WorkItemReviewSignalStatus;
  summary: string;
};

export type WorkItemReviewSummary = {
  gate: WorkItemReviewGate;
  headline: string;
  executionMode?: WorkItemExecutionMode | null;
  operatorDecision?: WorkItemReviewStatus | null;
  operatorNote?: string | null;
  reviewedAt?: string | null;
  totals: {
    total: number;
    queued: number;
    running: number;
    blocked: number;
    failed: number;
    succeeded: number;
  };
  signals: WorkItemReviewSignal[];
  openRisks: string[];
};

export type WorkItemReviewResponse = {
  ok: boolean;
  workItem?: WorkItemRecord;
  review?: WorkItemReviewSummary;
  error?: string;
};

export type WorkItemCycleRecord = {
  id: string;
  sequence: number;
  kind: WorkItemCycleKind;
  status: WorkItemCycleStatus;
  trigger: "launch" | "review_send_back";
  executionMode?: WorkItemExecutionMode | null;
  linkedRunId?: string | null;
  linkedTaskIds?: string[];
  summary?: string | null;
  operatorNote?: string | null;
  plan?: WorkItemCyclePlan | null;
  startedAt: string;
  endedAt?: string | null;
};

export type WorkItemRemediationPlan = {
  id: string;
  status: WorkItemRemediationPlanStatus;
  createdAt: string;
  launchedAt?: string | null;
  resolvedAt?: string | null;
  sourceCycleId?: string | null;
  note?: string | null;
  summary: string;
  rationale: string[];
  laneIds: string[];
  acceptanceDelta: string[];
  constraintDelta: string[];
  taskIds: string[];
  tasks: WorkPlanTask[];
  executionSteps: WorkItemExecutionStep[];
  cyclePlan: WorkItemCyclePlan;
};

export type WorkPlanTaskKind = "planning" | "implementation" | "validation" | "qa" | "review";

export type WorkPlanLane = {
  id: string;
  label: string;
  description?: string;
};

export type WorkPlanTask = {
  id: string;
  title: string;
  description?: string | null;
  laneId: string;
  laneLabel: string;
  roleHint?: string | null;
  kind: WorkPlanTaskKind;
  source: "pbi" | "template";
  dependsOn: string[];
  sourceLine?: number | null;
  workstreamId?: string | null;
  workstreamType?: WorkItemWorkstreamType | null;
  gateIds?: string[];
  qaMode?: "smoke" | "scenario" | null;
};

export type WorkItemWorkstream = {
  id: string;
  type: WorkItemWorkstreamType;
  title: string;
  description?: string | null;
  laneId: string;
  laneLabel: string;
  taskIds: string[];
  dependsOn: string[];
  gateIds: string[];
  preferredAgentId?: string | null;
  preferredAgentName?: string | null;
};

export type WorkItemGate = {
  id: string;
  type: WorkItemGateType;
  label: string;
  required: boolean;
  workstreamIds: string[];
};

export type WorkItemGateRuntime = WorkItemGate & {
  status: WorkItemGateStatus;
  summary: string;
};

export type WorkItemSourceSnapshot = {
  kind: "pbi_markdown" | "mission_template";
  label: string;
  sourcePath?: string | null;
  sprintName?: string | null;
  pbiId?: string | null;
  pbiTitle?: string | null;
  summary?: string | null;
  warnings: string[];
};

export type WorkItemExecutionStep = {
  id: string;
  title: string;
  role: string;
  executor: string;
  phase?: string | null;
  dependsOn: string[];
  acceptanceCriteria: string[];
};

export type WorkPlanLaneMatch = {
  id: string;
  name: string;
  role: string;
  specialization: string;
  seniority: string;
  maxParallelWork: number;
  state: string;
  score: number;
};

export type WorkPlanLaneAssignment = {
  laneId: string;
  laneLabel: string;
  preferredRole: string;
  preferredSpecializations: string[];
  coverage: "strong" | "fallback" | "missing";
  note?: string | null;
  matches: WorkPlanLaneMatch[];
};

export type WorkItemCyclePlan = {
  summary: string;
  headline?: string | null;
  source: "baseline" | "remediation";
  sourceCycleId?: string | null;
  sourceRemediationPlanId?: string | null;
  acceptanceCriteria: string[];
  constraints: string[];
  lanes: WorkPlanLane[];
  tasks: WorkPlanTask[];
  workstreams: WorkItemWorkstream[];
  gates: WorkItemGate[];
  teamAssignments: WorkPlanLaneAssignment[];
  executionSteps: WorkItemExecutionStep[];
};

export type WorkItemPlanningDetail = {
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  lanes: WorkPlanLane[];
  tasks: WorkPlanTask[];
  workstreams: WorkItemWorkstream[];
  gates: WorkItemGate[];
  qaCoverage: "none" | "scenario";
  teamAssignments: WorkPlanLaneAssignment[];
  executionSteps: WorkItemExecutionStep[];
  template: {
    id: string;
    name: string;
    description: string;
    recommendedRoles: string[];
    outcomes: string[];
  };
  sourceSnapshot: WorkItemSourceSnapshot;
};

export type WorkItemTeamRuntimeLane = {
  laneId: string;
  laneLabel: string;
  workstreamIds: string[];
  activeWorkstreamId?: string | null;
  status: WorkItemWorkstreamStatus | "missing";
  ownerAgentId?: string | null;
  ownerAgentName?: string | null;
  summary: string;
};

export type WorkItemTeamRuntime = {
  headline: string;
  currentStage: string;
  nextHandoff?: string | null;
  activeAgents: number;
  blockedLanes: number;
  completedLanes: number;
  missingCoverage: number;
  lanes: WorkItemTeamRuntimeLane[];
};

export type WorkItemOptimizationPromptSuggestion = {
  id: string;
  promptPath: string;
  label: string;
  status: WorkItemOptimizationStatus;
  createdAt: string;
  score: number;
  rationale: string[];
  suggestionId?: string | null;
};

export type WorkItemOptimizationStrategyRecommendation = {
  id: string;
  mode: string;
  status: WorkItemOptimizationStatus;
  createdAt: string;
  rationale: string[];
};

export type WorkItemOptimizationOpportunity = {
  id: string;
  title: string;
  description: string;
  status: WorkItemOptimizationStatus;
  createdAt: string;
  rationale: string[];
  riskScore: number;
  convertedWorkItemId?: string | null;
};

export type WorkItemOptimizationCycle = {
  id: string;
  cycleId: string;
  sequence: number;
  sourceStatus: "approved" | "changes_requested" | "failed";
  createdAt: string;
  promptSuggestions: WorkItemOptimizationPromptSuggestion[];
  strategyRecommendation?: WorkItemOptimizationStrategyRecommendation | null;
  opportunities: WorkItemOptimizationOpportunity[];
};

export type WorkItemOptimizationSummary = {
  cycles: WorkItemOptimizationCycle[];
};

export type WorkWorkspaceOptimizationSummary = {
  pendingPromptSuggestions: number;
  pendingStrategies: number;
  pendingOpportunities: number;
  recentCycles: Array<{
    workItemId: string;
    title: string;
    cycleId: string;
    sequence: number;
    sourceStatus: "approved" | "changes_requested" | "failed";
    createdAt: string;
  }>;
};

export type WorkItemDetailResponse = {
  workItem: WorkItemRecord;
  detail: WorkItemPlanningDetail;
  currentPlan?: WorkItemCyclePlan | null;
  review: WorkItemReviewSummary;
  optimization?: WorkItemOptimizationSummary | null;
  teamRuntime?: WorkItemTeamRuntime | null;
};

export type WorkItemPbiPreviewResponse = {
  ok: boolean;
  preview?: WorkItemPlanningDetail;
  error?: string;
};

export type WorkSprintBacklogItem = {
  pbiId: string;
  pbiTitle: string;
  summary?: string | null;
  sourceRef: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  taskCount: number;
  warnings: string[];
};

export type WorkSprintPreview = {
  sourcePath: string;
  sprintName?: string | null;
  warnings: string[];
  pbis: WorkSprintBacklogItem[];
};

export type WorkSprintPreviewResponse = {
  ok: boolean;
  preview?: WorkSprintPreview;
  error?: string;
};

export type WorkItemSprintImportRequest = {
  workspaceId: string;
  sourcePath: string;
  pbiIds?: string[];
};

export type WorkItemImportSkip = {
  pbiId: string;
  reason: string;
};

export type WorkItemSprintImportResponse = {
  ok: boolean;
  created: WorkItemRecord[];
  skipped: WorkItemImportSkip[];
  error?: string;
};

export type WorkSprintControlPbiState =
  | "unimported"
  | "ready"
  | "running"
  | "review"
  | "blocked"
  | "completed";

export type WorkSprintControlRecommendation = {
  action: "import" | "launch" | "review";
  pbiId: string;
  title: string;
  rationale: string;
  workItemId?: string | null;
};

export type WorkSprintGovernance = {
  targetWip: number;
  maxAutoLaunchPerAction: number;
  blockLaunchWhenReviewPending: boolean;
  allowImportDuringAutoLaunch: boolean;
};

export type WorkSprintLaunchCandidateDisposition = "selected" | "deferred" | "blocked";

export type WorkSprintLaunchCandidate = {
  pbiId: string;
  title: string;
  state: WorkSprintControlPbiState;
  workItemId?: string | null;
  score: number;
  disposition: WorkSprintLaunchCandidateDisposition;
  reasons: string[];
};

export type WorkSprintControlTimelineEntry = {
  id: string;
  at: string;
  type: "imported" | "cycle_started" | "review_decision";
  pbiId: string;
  title: string;
  summary: string;
  workItemId?: string | null;
  cycleSequence?: number | null;
  cycleStatus?: WorkItemCycleStatus | null;
};

export type WorkSprintBurndownPoint = {
  at: string;
  label: string;
  completed: number;
  remaining: number;
  active: number;
};

export type WorkSprintControlAction = "launch_next_ready" | "fill_wip";

export type WorkSprintControlActionRequest = {
  workspaceId: string;
  sourcePath: string;
  action: WorkSprintControlAction;
  targetWip?: number;
  maxAutoLaunchPerAction?: number;
  blockLaunchWhenReviewPending?: boolean;
  allowImportDuringAutoLaunch?: boolean;
};

export type WorkSprintControlActionReport = {
  action: WorkSprintControlAction;
  slotsRequested: number;
  slotsFilled: number;
  governance: WorkSprintGovernance;
  candidates: WorkSprintLaunchCandidate[];
};

export type WorkSprintSupervisorState = "idle" | "running" | "paused" | "error";

export type WorkSprintSupervisor = {
  sourcePath: string;
  enabled: boolean;
  state: WorkSprintSupervisorState;
  tickIntervalSeconds: number;
  governance: WorkSprintGovernance;
  lastTickAt?: string | null;
  lastActionAt?: string | null;
  lastError?: string | null;
  lastReport?: WorkSprintControlActionReport | null;
};

export type WorkSprintSupervisorRequest = {
  workspaceId: string;
  sourcePath: string;
  enabled: boolean;
  tickIntervalSeconds?: number;
  targetWip?: number;
  maxAutoLaunchPerAction?: number;
  blockLaunchWhenReviewPending?: boolean;
  allowImportDuringAutoLaunch?: boolean;
};

export type WorkSprintSupervisorResponse = {
  ok: boolean;
  supervisor?: WorkSprintSupervisor;
  control?: WorkSprintControl;
  error?: string;
};

export type WorkSprintControlPbi = WorkSprintBacklogItem & {
  state: WorkSprintControlPbiState;
  workItemId?: string | null;
  workItemTitle?: string | null;
  workItemStatus?: WorkItemStatus | null;
  reviewStatus?: WorkItemReviewStatus | null;
  cycleCount: number;
  blockedBy: string[];
  blockedReasons: string[];
};

export type WorkSprintControl = {
  sourcePath: string;
  sprintName?: string | null;
  warnings: string[];
  summary: {
    total: number;
    unimported: number;
    ready: number;
    running: number;
    review: number;
    blocked: number;
    completed: number;
    launchable: number;
    activeWip: number;
    percentComplete: number;
  };
  pbis: WorkSprintControlPbi[];
  governance: WorkSprintGovernance;
  supervisor: WorkSprintSupervisor;
  launchQueue: WorkSprintLaunchCandidate[];
  blockers: string[];
  recommendations: WorkSprintControlRecommendation[];
  timeline: WorkSprintControlTimelineEntry[];
  burndown: WorkSprintBurndownPoint[];
};

export type WorkSprintControlResponse = {
  ok: boolean;
  control?: WorkSprintControl;
  error?: string;
};

export type WorkSprintControlActionResponse = {
  ok: boolean;
  imported: WorkItemRecord[];
  launched: WorkItemRecord[];
  skipped: WorkItemImportSkip[];
  control?: WorkSprintControl;
  report?: WorkSprintControlActionReport;
  error?: string;
};

export type WorkOrganizationLaunchCandidate = {
  workItemId: string;
  title: string;
  sourceType: WorkItemSourceType;
  status: WorkItemStatus;
  reviewStatus?: WorkItemReviewStatus | null;
  score: number;
  disposition: WorkSprintLaunchCandidateDisposition;
  reasons: string[];
};

export type WorkOrganizationControlAction = "launch_next_ready" | "fill_wip";

export type WorkOrganizationSupervisorState = "idle" | "running" | "paused" | "error";

export type WorkOrganizationControlActionReport = {
  action: WorkOrganizationControlAction;
  launchedWorkItemIds: string[];
  slotsRequested: number;
  slotsFilled: number;
  governance: WorkSprintGovernance;
  candidates: WorkOrganizationLaunchCandidate[];
};

export type WorkOrganizationLaunchSkip = {
  workItemId: string;
  title: string;
  reason: string;
};

export type WorkOrganizationSupervisor = {
  enabled: boolean;
  state: WorkOrganizationSupervisorState;
  tickIntervalSeconds: number;
  governance: WorkSprintGovernance;
  lastTickAt?: string | null;
  lastActionAt?: string | null;
  lastError?: string | null;
  lastReport?: WorkOrganizationControlActionReport | null;
};

export type WorkOrganizationControl = {
  workspaceId: string;
  summary: {
    total: number;
    draft: number;
    running: number;
    review: number;
    blocked: number;
    completed: number;
    failed: number;
    launchable: number;
    activeWip: number;
  };
  governance: WorkSprintGovernance;
  launchQueue: WorkOrganizationLaunchCandidate[];
  blockers: string[];
  supervisor: WorkOrganizationSupervisor;
};

export type WorkOrganizationControlResponse = {
  ok: boolean;
  control?: WorkOrganizationControl;
  error?: string;
};

export type WorkOrganizationControlActionRequest = {
  workspaceId: string;
  action: WorkOrganizationControlAction;
  targetWip?: number;
  maxAutoLaunchPerAction?: number;
  blockLaunchWhenReviewPending?: boolean;
  allowImportDuringAutoLaunch?: boolean;
};

export type WorkOrganizationControlActionResponse = {
  ok: boolean;
  launched: WorkItemRecord[];
  skipped: WorkOrganizationLaunchSkip[];
  control?: WorkOrganizationControl;
  report?: WorkOrganizationControlActionReport;
  error?: string;
};

export type WorkOrganizationSupervisorRequest = {
  workspaceId: string;
  enabled: boolean;
  tickIntervalSeconds?: number;
  targetWip?: number;
  maxAutoLaunchPerAction?: number;
  blockLaunchWhenReviewPending?: boolean;
  allowImportDuringAutoLaunch?: boolean;
};

export type WorkOrganizationSupervisorResponse = {
  ok: boolean;
  control?: WorkOrganizationControl;
  supervisor?: WorkOrganizationSupervisor;
  error?: string;
};

export type MissionNodeSummary = Pick<
  MissionNode,
  | "id"
  | "title"
  | "role"
  | "executor"
  | "phase"
  | "dependsOn"
  | "status"
  | "assignedAgentId"
  | "assignedAgentName"
  | "provider"
  | "transport"
  | "profileId"
  | "model"
  | "effort"
  | "authSource"
  | "exitCode"
  | "targetTool"
  | "acceptanceCriteria"
  | "approval"
  | "artifacts"
  | "findingCount"
  | "start"
  | "end"
  | "error"
>;

export type MissionGraphSummary = Pick<
  MissionGraph,
  "templateId" | "name" | "description" | "category" | "defaultGoalHint" | "recommendedRoles" | "outcomes"
> & {
  nodes: MissionNodeSummary[];
};

export type RunSummary = RunState & {
  repoPath?: string;
  error?: string;
};

export type RunDetail = {
  run: RunSummary;
  steps: StepState[];
  graph: MissionGraphSummary | null;
  delivery?: DeliverySessionState | null;
};

export type RunProgressSnapshot = {
  run: RunSummary | null;
  steps: StepState[];
  progress: {
    done: number;
    total: number;
    percent: number;
    remaining: number;
  };
};

export type RunStartOptions = {
  concurrency?: number;
  modelOverrides?: Record<string, string>;
  strategyMode?: string;
  passphrase?: string;
};

export type ChangeTruth = {
  status: ChangeStatus;
  diffArtifact?: string | null;
  applyError?: string | null;
  appliedAt?: string | null;
  source?: "provider" | "external";
};

export type ValidationTruth = {
  status: ValidationStatus;
  commands: string[];
  results: Array<{
    command: string;
    ok: boolean;
    exitCode: number | null;
    logPath?: string | null;
    summary?: string | null;
  }>;
  summary?: string | null;
  attemptedAt?: string | null;
  completedAt?: string | null;
};

export type BrowserRunOptions = {
  baseUrl?: string;
  targetPath?: string;
  iterations?: number;
  intervalMs?: number;
  passphrase?: string;
  scenario?: BrowserScenarioStep[];
};

export type BrowserScenarioStep =
  | { action: "goto"; url?: string; targetPath?: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "waitFor"; selector?: string; text?: string; timeoutMs?: number }
  | { action: "assertText"; selector?: string; text: string }
  | { action: "assertVisible"; selector: string }
  | { action: "screenshot"; name?: string; fullPage?: boolean };

export type BrowserRunRequest = {
  workspaceId: string;
  baseUrl?: string;
  targetPath?: string;
  options?: BrowserRunOptions;
};

export type DeliveryStartRequest = DeliverySessionRequest;

export type DeliveryStartResponse = RunStartResponse & {
  kind?: Extract<RunKind, "delivery">;
};

export type DeliveryPacketExportRequest = {
  target: DeliveryTargetTool;
};

export type DeliveryPacketImportRequest = {
  workspaceId?: string;
  packetId?: string;
  text?: string;
  data?: string;
  fileName?: string;
  targetTool?: DeliveryTargetTool;
};

export type RunStartRequest = {
  workspaceId: string;
  missionTemplateId?: string;
  userGoal?: string;
  runId?: string;
  options?: RunStartOptions;
};

export type RunStartResponse = {
  ok: boolean;
  runId?: string;
  error?: string;
};

export type BrowserRunResponse = RunStartResponse & {
  kind?: Extract<RunKind, "qa" | "benchmark" | "canary">;
};

export type RunResumeRequest = {
  workspaceId?: string;
  fromStepId?: string;
};

export type RunResumeResponse = {
  ok: boolean;
  fromStepId?: string;
  error?: string;
};

export type RunActionResponse = {
  ok: boolean;
  error?: string;
};

export type DiagnosticsExportRequest = {
  workspaceId?: string;
  runId?: string;
  outputDir?: string;
};

export type DiagnosticsExportResponse = {
  archive?: string;
  error?: string;
};

export type DoctorSeverity = "info" | "warn" | "error";

export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  severity: DoctorSeverity;
  summary: string;
  details?: string[];
};

export type DoctorReport = {
  generatedAt: string;
  rootDir: string;
  runsDir: string;
  workspaceId?: string;
  checks: DoctorCheck[];
  summary: {
    ok: boolean;
    warnCount: number;
    errorCount: number;
  };
};

export type LearningEntry = {
  id: string;
  timestamp: string;
  category: string;
  insight: string;
  relatedFiles: string[];
  sourceRunId?: string;
  confidence: number;
};

export type LearningsResponse = {
  workspaceId?: string;
  learnings: LearningEntry[];
};

export type DocsSyncResponse = {
  ok: boolean;
  syncedAt?: string;
  summary?: string;
  updatedFiles?: string[];
  changedFiles?: string[];
  error?: string;
};

export type ReleaseReadiness = RunReadiness & {
  workspaceId?: string;
  latestRunId?: string;
  signals?: {
    pendingApprovals: number;
    governanceAlerts: number;
    docsFresh: boolean;
    qualityGateOk: boolean;
    validationStatus?: string;
    changeStatus?: string;
    verdict?: string | null;
    readinessRequirements?: string[];
    blockingFindings?: number;
  };
};

export type WorkspaceProfileShape = {
  risk_tolerance?: string;
  max_cost_per_run?: number;
  default_strategy?: string;
  sandbox_mode?: string;
  execution_mode?: "inline" | "worktree";
  browser_base_url?: string;
  governance?: GovernanceProfile;
  repo_execution?: RepoExecutionProfile;
};

export type {
  TeamPreset,
  RoleDefinition,
  MachineCapability,
  RoleBinding,
  DeliverySessionRequest,
  DeliverySessionState,
  WorkPacket,
  PacketExport,
  PacketImport,
  DeliveryImportAnalysis,
  DeliverySummary,
  ReviewFinding,
  RemediationTask,
  EvidenceRecord,
  CapabilityDiscoveryResult,
  TeamPresetResponse,
  DeliveryTargetTool
};

export function normalizeTaskStatus(status: string | null | undefined): TaskRuntimeStatus {
  switch ((status ?? "").trim().toLowerCase()) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "succeeded";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "running":
    case "active":
      return "running";
    default:
      return "queued";
  }
}

export function normalizeWorkItemStatus(status: string | null | undefined): WorkItemStatus {
  switch ((status ?? "").trim().toLowerCase()) {
    case "queued":
    case "planning":
    case "active":
    case "running":
      return "running";
    case "blocked":
    case "paused":
      return "blocked";
    case "ready":
    case "review":
    case "ready-for-review":
    case "ready_for_review":
      return "ready_for_review";
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return "draft";
  }
}

export function normalizeAgentRuntimeState(state: string | null | undefined): AgentRuntimeState {
  switch ((state ?? "").trim().toLowerCase()) {
    case "running":
    case "active":
      return "active";
    case "sleeping":
      return "sleeping";
    case "error":
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export function isAgentRuntimeBusy(state: string | null | undefined): boolean {
  return normalizeAgentRuntimeState(state) === "active";
}

export type {
  PauseReason,
  RunVerdict
};
