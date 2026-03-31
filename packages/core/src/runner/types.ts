export type AgentStatus = "active" | "idle" | "sleeping" | "failed" | "completed";

export type AgentState = {
  agentId: string;
  status: AgentStatus;
  currentStepId?: string;
};

export type StepStatus = "pending" | "running" | "completed" | "failed" | "cached" | "skipped" | "cancelled";

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
};

export type RunStatus = "running" | "finished" | "failed" | "cancelled" | "interrupted";

export type RunKind = "workflow" | "qa" | "benchmark" | "canary";

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
  resumedFrom?: string | null;
  resumeCount?: number;
  totalSteps?: number;
  completedSteps?: number;
  headSha?: string;
  branch?: string | null;
  totalTokens?: number;
  totalCost?: number;
  costByAgent?: Record<string, { tokens: number; cost: number }>;
  dynamicAgents?: Array<{ id: string; role?: string }>;
  replayedAt?: string;
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
  readiness?: RunReadiness | null;
  profile?: {
    risk_tolerance?: string;
    max_cost_per_run?: number;
    default_strategy?: string;
    sandbox_mode?: string;
    execution_mode?: "inline" | "worktree";
    browser_base_url?: string;
    governance?: GovernanceProfile;
  } | null;
};
