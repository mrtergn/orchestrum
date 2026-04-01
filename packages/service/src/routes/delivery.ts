import type express from "express";
import {
  type StateIndex
} from "@orchestrum/core";

export function registerDeliveryRoutes(
  app: express.Express,
  options: {
    stateIndex: StateIndex;
  }
): void {
  app.get("/delivery/summary", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    await options.stateIndex.health();
    const summary = await options.stateIndex.getDeliverySummary(workspaceId);
    res.json(summary);
  });
}
