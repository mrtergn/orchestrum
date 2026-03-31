import type {
  ChangeStatus,
  PauseReason,
  RunStatus as CanonicalRunStatus,
  RunVerdict,
  StepStatus as CanonicalStepStatus,
  ValidationStatus
} from "../types/status.js";

export type AgentStatus = "active" | "idle" | "sleeping" | "failed" | "completed";

export type AgentState = {
  agentId: string;
  status: AgentStatus;
  currentStepId?: string;
};

export type ValidationCommandResult = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  logPath?: string | null;
  summary?: string | null;
};

export type ValidationState = {
  status: ValidationStatus;
  commands: string[];
  results: ValidationCommandResult[];
  summary?: string | null;
  attemptedAt?: string | null;
  completedAt?: string | null;
};

export type ChangeState = {
  status: ChangeStatus;
  diffArtifact?: string | null;
  applyError?: string | null;
  appliedAt?: string | null;
  source?: "provider" | "external";
};

export type StepStatus = CanonicalStepStatus;

export type StepState = {
  stepId: string;
  status: StepStatus;
  start?: string;
  end?: string;
  ok?: boolean;
  error?: string | null;
  cached?: boolean;
  commitSha?: string | null;
  parentStepId?: string;
  agentId?: string | null;
  provider?: string | null;
  model?: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  costUsd?: number | null;
  riskScore?: number | null;
  behavior?: {
    reasoningSummary?: string | null;
    confidence?: number | null;
    decisionPath?: string[] | null;
  } | null;
  pauseReason?: PauseReason | null;
  change?: ChangeState | null;
  validation?: ValidationState | null;
  verdict?: RunVerdict | null;
};

export type RepoExecutionProfile = {
  package_manager?: "npm" | "pnpm" | "yarn";
  commands?: {
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
    smoke?: string;
    dev?: string;
  };
  protected_paths?: string[];
  risky_commands?: string[];
  readiness_requirements?: string[];
};

export type RunStatus = CanonicalRunStatus;

export type RunKind = "mission" | "qa" | "benchmark" | "canary" | "delivery";

export type RunReadiness = {
  score: number;
  blocking: string[];
  updatedAt?: string;
};

export type GovernanceProfile = {
  enabled?: boolean;
  dangerous_command_guard?: boolean;
  config_protection?: boolean;
  quality_gate?: boolean;
};

export type RunState = {
  schemaVersion?: number;
  meta?: {
    id?: string;
    workspaceId?: string;
    startedAt?: string;
    finishedAt?: string | null;
  };
  stats?: {
    totalCost?: number;
    totalTokens?: number;
    totalSteps?: number;
    riskScore?: number;
  };
  steps?: StepState[];
  governance?: {
    governanceEvents?: Array<Record<string, unknown>>;
    approvalTokens?: string[];
  };
  runId: string;
  kind?: RunKind;
  status: RunStatus;
  start: string;
  end: string | null;
  goal?: string;
  userGoal?: string;
  workspaceId?: string;
  workspacePath?: string;
  pinned?: boolean;
  tags?: string[];
  interruptedAt?: string | null;
  totalSteps?: number;
  completedSteps?: number;
  headSha?: string;
  branch?: string | null;
  totalTokens?: number;
  totalCost?: number;
  costByAgent?: Record<string, { tokens: number; cost: number }>;
  dynamicAgents?: Array<{ id: string; role?: string }>;
  modelUsage?: Record<string, number>;
  reward?: number;
  rewardHistory?: Array<{ ts: string; reward: number }>;
  strategy?: {
    mode?: string;
    suggestedMode?: string;
    adjustments?: string[];
    performanceScore?: number;
  };
  agentScores?: Record<string, { score: number; avgScore?: number }>;
  policyViolations?: number;
  auditFailures?: number;
  testFailures?: number;
  securityAlerts?: number;
  riskSummary?: { avgRisk?: number; maxRisk?: number };
  promptEvolution?: { suggestions?: number; lastScore?: number };
  loopCount?: number;
  license?: {
    tier?: string;
    valid?: boolean;
    expiresAt?: string | null;
  };
  worktreePath?: string | null;
  repoPath?: string;
  missionTemplateId?: string;
  readiness?: RunReadiness | null;
  pauseReason?: PauseReason | null;
  change?: ChangeState | null;
  validation?: ValidationState | null;
  verdict?: RunVerdict | null;
  profile?: {
    risk_tolerance?: string;
    max_cost_per_run?: number;
    default_strategy?: string;
    sandbox_mode?: string;
    execution_mode?: "inline" | "worktree";
    browser_base_url?: string;
    governance?: GovernanceProfile;
    repo_execution?: RepoExecutionProfile;
  } | null;
  error?: string;
};
