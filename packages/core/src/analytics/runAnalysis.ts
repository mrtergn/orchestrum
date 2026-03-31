export type RunAnalysis = {
  success: boolean;
  auditFailures: number;
  auditBlocks: number;
  devFailures: number;
  policyViolations: number;
  testFailures: number;
  securityAlerts: number;
  loopCount: number;
  totalTokens: number;
  totalCost: number;
  riskScores: number[];
  agentStats: Record<string, { tokens: number; cost: number }>;
  performanceScore: number;
};
