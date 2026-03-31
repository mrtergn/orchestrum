import type express from "express";
import {
  getLicenseStatus,
  isFeatureAllowed,
  loadAnalytics,
  loadOpportunities,
  type StateIndex
} from "@orchestrum/core";

type InsightsAgentPlatform = {
  startMission(options: {
    runsDir: string;
    workspaceId: string;
    repoPath: string;
    templateId: string;
    goal: string;
    runId?: string;
    runOptions?: {
      concurrency?: number;
      modelOverrides?: Record<string, string>;
      strategyMode?: string;
    };
  }): Promise<Record<string, unknown>>;
};

export function registerInsightsOpsRoutes(
  app: express.Express,
  options: {
    runsDir: string;
    stateIndex: StateIndex;
    agentPlatform: InsightsAgentPlatform;
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  }
): void {
  app.get("/analytics", async (req, res) => {
    const license = await getLicenseStatus();
    const tier = license.valid ? license.tier : "Free";
    if (!isFeatureAllowed(tier, "analytics")) {
      return res.status(403).json({ error: "Analytics requires Pro tier." });
    }
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const workspacePath = await options.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return res.json({ analytics: null });

    let analytics = await loadAnalytics(workspacePath);
    if (!analytics || analytics.runs === 0) {
      const runs = await options.stateIndex.queryRuns(workspaceId).catch(() => []);
      analytics = {
        runs: runs.length,
        successes: runs.filter((run) => run.status === "completed").length,
        failures: runs.filter((run) => run.status === "failed").length,
        totalCost: 0,
        costPerFeature: 0,
        perAgent: {},
        loopCounts: { total: 0, avg: 0 },
        failureTypes: { policy: 0, audit: 0, test: 0, security: 0 },
        trends: { cost: [], successRate: [], loops: [], reward: [] },
        testStability: { total: 0, failed: 0, index: 0 },
        modelUsage: {}
      };
    }
    res.json({ analytics });
  });

  app.get("/opportunities", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(req.query.workspace as string | undefined);
    if (!workspacePath) return res.json({ opportunities: [] });
    const opportunities = await loadOpportunities(workspacePath);
    res.json({ opportunities });
  });

  app.post("/opportunities/run", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const workspaceId = String(req.body?.workspaceId ?? "");
    const goal = req.body?.title ?? "Improve project";
    try {
      const result = await options.agentPlatform.startMission({
        runsDir: options.runsDir,
        workspaceId,
        repoPath: workspacePath,
        templateId: "feature-dev",
        goal
      });
      void options.stateIndex.rebuild().catch(() => undefined);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? "Mission start failed" });
    }
  });
}
