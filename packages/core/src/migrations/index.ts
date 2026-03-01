import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { RunState } from "../runner/types.js";
import { writeJson } from "../runner/fs.js";

export const CURRENT_SCHEMA_VERSION = 2;

export async function migrateRuns(runsDir: string): Promise<{ migrated: number }> {
  let migrated = 0;
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name);
    const legacyRun = path.join(candidate, "run.json");
    if (fsSync.existsSync(legacyRun)) {
      const updated = await migrateRun(candidate);
      if (updated) migrated += 1;
      continue;
    }
    const workspaceRuns = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
    for (const runEntry of workspaceRuns) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(candidate, runEntry.name);
      const updated = await migrateRun(runDir);
      if (updated) migrated += 1;
    }
  }
  return { migrated };
}

export async function migrateRun(runDir: string): Promise<boolean> {
  const runPath = path.join(runDir, "run.json");
  try {
    const raw = await fs.readFile(runPath, "utf8");
    const meta = JSON.parse(raw) as RunState;
    const current = meta.schemaVersion ?? 1;
    if (current >= CURRENT_SCHEMA_VERSION) return false;
    const updated = applyMigrations(meta, current);
    await writeJson(runPath, updated);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function applyMigrations(meta: RunState, version: number): RunState {
  let updated = { ...meta };
  let v = version;
  while (v < CURRENT_SCHEMA_VERSION) {
    if (v === 1) {
      updated = migrateV1ToV2(updated);
    }
    v += 1;
  }
  updated.schemaVersion = CURRENT_SCHEMA_VERSION;
  return updated;
}

function migrateV1ToV2(meta: RunState): RunState {
  const updated: RunState = { ...meta };
  if (!updated.status) {
    updated.status = updated.end ? "finished" : "interrupted";
  }
  if (!updated.tags) updated.tags = [];
  if (!updated.pinned) updated.pinned = false;
  return updated;
}
