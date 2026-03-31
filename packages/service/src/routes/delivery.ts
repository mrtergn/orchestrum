import type express from "express";
import {
  analyzeDeliveryImport,
  exportDeliveryPacket,
  importDeliveryPacketResponse,
  listDeliveryPackets,
  loadDeliveryFindings,
  loadDeliveryRemediations,
  loadDeliverySession,
  type DeliveryTargetTool,
  type StateIndex
} from "@orchestrum/core";

export function registerDeliveryRoutes(
  app: express.Express,
  options: {
    runsDir: string;
    stateIndex: StateIndex;
  }
): void {
  const rebuildStateIndex = () => {
    void options.stateIndex.rebuild().catch(() => undefined);
  };

  app.get("/delivery/summary", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    await options.stateIndex.health();
    const summary = await options.stateIndex.getDeliverySummary(workspaceId);
    res.json(summary);
  });

  app.get("/delivery/:id", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const session = await loadDeliverySession({ runsDir: options.runsDir, runId: req.params.id, workspaceId });
    if (!session) return res.status(404).json({ error: "Delivery session not found" });
    res.json(session);
  });

  app.get("/delivery/:id/packets", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const packets = await listDeliveryPackets({ runsDir: options.runsDir, runId: req.params.id, workspaceId });
    res.json({ packets });
  });

  app.get("/delivery/:id/packets/:packetId/export", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const target = req.query.target ? String(req.query.target) : "";
    if (!target) return res.status(400).json({ error: "target query param is required" });
    try {
      const exported = await exportDeliveryPacket({
        runsDir: options.runsDir,
        runId: req.params.id,
        workspaceId,
        packetId: req.params.packetId,
        targetTool: target as DeliveryTargetTool
      });
      rebuildStateIndex();
      res.json(exported);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Packet export failed." });
    }
  });

  app.post("/delivery/:id/import", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const { text, fileName, targetTool, source } = decodeImportPayload(req.body);
    try {
      const result = await analyzeDeliveryImport({
        runsDir: options.runsDir,
        runId: req.params.id,
        workspaceId,
        text,
        fileName,
        targetTool,
        source,
        recordAttempt: true
      });
      rebuildStateIndex();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Delivery import analysis failed." });
    }
  });

  app.post("/delivery/:id/packets/:packetId/import", async (req, res) => {
    const workspaceId = req.body?.workspaceId ? String(req.body.workspaceId) : undefined;
    const { text, fileName, targetTool, source } = decodeImportPayload(req.body);
    try {
      const result = await importDeliveryPacketResponse({
        runsDir: options.runsDir,
        runId: req.params.id,
        workspaceId,
        packetId: req.params.packetId,
        text,
        fileName,
        targetTool,
        source
      });
      rebuildStateIndex();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "Packet import failed." });
    }
  });

  app.get("/delivery/:id/findings", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const findings = await loadDeliveryFindings({ runsDir: options.runsDir, runId: req.params.id, workspaceId });
    res.json({ findings });
  });

  app.get("/delivery/:id/remediations", async (req, res) => {
    const workspaceId = req.query.workspace ? String(req.query.workspace) : undefined;
    const remediations = await loadDeliveryRemediations({ runsDir: options.runsDir, runId: req.params.id, workspaceId });
    res.json({ remediations });
  });
}

function decodeImportPayload(body: Record<string, unknown> | undefined): {
  text: string;
  fileName?: string;
  targetTool?: DeliveryTargetTool;
  source: "paste" | "file";
} {
  let text = typeof body?.text === "string" ? body.text : "";
  const fileName = typeof body?.fileName === "string" ? body.fileName : undefined;
  const targetTool = typeof body?.targetTool === "string" ? body.targetTool as DeliveryTargetTool : undefined;
  if (!text && typeof body?.data === "string" && body.data.trim()) {
    text = Buffer.from(String(body.data), "base64").toString("utf8");
  }
  return {
    text,
    fileName,
    targetTool,
    source: fileName ? "file" : "paste"
  };
}
