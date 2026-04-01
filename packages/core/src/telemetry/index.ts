import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, ensureDir } from "../runner/fs.js";
import type { LicenseTier } from "../licensing/index.js";
import { getWorkspaceSignalsPath } from "../runner/control.js";

export type TelemetryConfig = {
  enabled?: boolean;
  endpoint?: string;
};

export type TelemetryEvent = {
  t: string;
  ts: string;
  tier?: LicenseTier;
  run_kind?: string;
  run_status?: string;
  workspace_id?: string;
  template_id?: string;
  duration_ms?: number;
  total_tokens?: number;
  total_cost?: number;
};

function getDefaultTelemetryLogPath(workspacePath?: string): string {
  if (workspacePath) {
    return getWorkspaceSignalsPath(workspacePath);
  }
  return path.join(process.cwd(), ".orchestrum", "control", "signals.ndjson");
}

export async function emitTelemetry(
  event: TelemetryEvent,
  config?: TelemetryConfig | null,
  options?: { workspacePath?: string }
): Promise<void> {
  if (!config?.enabled) return;
  if (config.endpoint) {
    try {
      await fetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event)
      });
      return;
    } catch {
      // fallback to local log
    }
  }
  const logPath = getDefaultTelemetryLogPath(options?.workspacePath);
  await ensureDir(path.dirname(logPath));
  await appendLine(logPath, JSON.stringify(event));
}
