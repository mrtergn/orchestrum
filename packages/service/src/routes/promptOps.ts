import type express from "express";
import {
  approvePromptSuggestion,
  loadPromptHistory,
  rejectPromptSuggestion,
  rollbackPromptVersion
} from "@orchestrum/core";

export function registerPromptOpsRoutes(
  app: express.Express,
  options: {
    resolveWorkspacePath: (workspaceId?: string) => Promise<string | null>;
  }
): void {
  app.get("/prompts", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(req.query.workspace as string | undefined);
    if (!workspacePath) return res.json({ prompts: {} });
    const data = await loadPromptHistory(workspacePath);
    res.json(data);
  });

  app.post("/prompts/approve", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const { promptPath, suggestionId } = req.body ?? {};
    await approvePromptSuggestion({
      workspacePath,
      promptPath,
      suggestionId
    });
    res.json({ ok: true });
  });

  app.post("/prompts/reject", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const { promptPath, suggestionId } = req.body ?? {};
    await rejectPromptSuggestion({
      workspacePath,
      promptPath,
      suggestionId
    });
    res.json({ ok: true });
  });

  app.post("/prompts/rollback", async (req, res) => {
    const workspacePath = await options.resolveWorkspacePath(req.body?.workspaceId);
    if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
    const { promptPath, versionId } = req.body ?? {};
    await rollbackPromptVersion({
      workspacePath,
      promptPath,
      versionId
    });
    res.json({ ok: true });
  });
}
