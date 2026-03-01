import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, ensureDir } from "../runner/fs.js";
import type { LicenseTier } from "../licensing/index.js";
import { getAppHome } from "../appHome.js";

export type TelemetryConfig = {
  enabled?: boolean;
  endpoint?: string;
};

export type TelemetryEvent = {
  t: string;
  ts: string;
  tier?: LicenseTier;
  duration_ms?: number;
  total_tokens?: number;
  total_cost?: number;
};

const DEFAULT_LOG = path.join(getAppHome(), "telemetry.ndjson");

export async function emitTelemetry(event: TelemetryEvent, config?: TelemetryConfig | null): Promise<void> {
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
  await ensureDir(path.dirname(DEFAULT_LOG));
  await appendLine(DEFAULT_LOG, JSON.stringify(event));
}
