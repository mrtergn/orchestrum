import type express from "express";
import {
  getLicenseStatus,
  isFeatureAllowed,
  loadAnalytics,
  type StateIndex
} from "@orchestrum/core";

export function registerInsightsOpsRoutes(
  app: express.Express,
  options: {
    stateIndex: StateIndex;
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
}
