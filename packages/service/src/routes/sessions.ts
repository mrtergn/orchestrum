import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type express from "express";

export function registerSessionRoutes(
  app: express.Express,
  options: {
    runsDir: string;
  }
): void {
  app.post("/sessions/decisions", async (req, res) => {
    const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId.trim() : "";
    const decision = typeof req.body?.decision === "string" ? req.body.decision.trim() : "";
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : undefined;
    const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : undefined;

    if (!runId) return res.status(400).json({ ok: false, error: "runId required" });
    if (!decision) return res.status(400).json({ ok: false, error: "decision required" });

    const runDir = await resolveRunDir(options.runsDir, runId, workspaceId).catch(() => null);
    if (!runDir) return res.status(404).json({ ok: false, error: "Run not found" });

    const record = {
      id: crypto.randomUUID(),
      sessionId: runId,
      decision,
      note,
      actor: "user" as const,
      createdAt: new Date().toISOString(),
      data
    };

    try {
      const deliveryDir = path.join(runDir, "delivery");
      await fs.mkdir(deliveryDir, { recursive: true });
      const filePath = path.join(deliveryDir, "decisions.ndjson");
      await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
      return res.json({ ok: true, record });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message ?? "Persist failed" });
    }
  });
}

async function resolveRunDir(runsDir: string, runId: string, workspaceId?: string): Promise<string | null> {
  if (workspaceId) {
    const candidate = path.join(runsDir, workspaceId, runId);
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // fallthrough
    }
  }
  try {
    const workspaces = await fs.readdir(runsDir, { withFileTypes: true });
    for (const entry of workspaces) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(runsDir, entry.name, runId);
      try {
        const st = await fs.stat(candidate);
        if (st.isDirectory()) return candidate;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return null;
}

