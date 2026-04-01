import { appendLine } from "./fs.js";
import { getWorkspaceSignalsPath } from "./control.js";

export type WorkspaceSignal = {
  ts?: string;
  workspaceId: string;
  source: "mission" | "browser" | "work" | "review" | "supervisor" | "plugin" | "execution";
  type: string;
  entityId?: string;
  status?: string;
  summary?: string;
  payload?: Record<string, unknown>;
};

export async function appendWorkspaceSignal(repoPath: string, signal: WorkspaceSignal): Promise<void> {
  const entry = {
    ts: signal.ts ?? new Date().toISOString(),
    workspaceId: signal.workspaceId,
    source: signal.source,
    type: signal.type,
    entityId: signal.entityId ?? null,
    status: signal.status ?? null,
    summary: signal.summary ?? null,
    payload: signal.payload ?? {}
  };
  await appendLine(getWorkspaceSignalsPath(repoPath), JSON.stringify(entry));
}
