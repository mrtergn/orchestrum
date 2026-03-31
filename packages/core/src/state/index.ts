import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getAppHome } from "../appHome.js";
import { ensureDir, readJsonIfExists } from "../runner/fs.js";
import { loadWorkspaces } from "../runner/workspaces.js";
import { listInstalledPlugins } from "../plugins/registry.js";
import { loadGovernanceEvents } from "../runner/governance.js";
import { loadLearnings } from "../runner/learnings.js";

type SqlJsDatabase = any;
type SqlJsModule = {
  Database: new (buffer?: Uint8Array) => SqlJsDatabase;
};

export type StateIndexHealth = {
  ok: boolean;
  rebuilt: boolean;
  path: string;
  error?: string;
  updatedAt?: string;
};

export type IndexedRunRecord = {
  workspaceId: string;
  runId: string;
  kind: string;
  status: string;
  start: string;
  end: string | null;
  repoPath: string;
  workflow: string;
  readinessScore: number | null;
  readinessBlocking: string[];
};

export function getStateIndexPath(): string {
  return path.join(getAppHome(), "state-index.sqlite");
}

export class StateIndex {
  private sqlModule: SqlJsModule | null = null;
  private db: SqlJsDatabase | null = null;
  private lastHealth: StateIndexHealth = {
    ok: false,
    rebuilt: false,
    path: getStateIndexPath()
  };

  constructor(private options: { rootDir: string; runsDir: string; dbPath?: string }) {}

  async init(): Promise<StateIndexHealth> {
    const dbPath = this.options.dbPath ?? getStateIndexPath();
    await ensureDir(path.dirname(dbPath));
    try {
      const SQL = await this.loadSqlJs();
      const existing = await fs.readFile(dbPath).catch(() => null);
      this.db = existing ? new SQL.Database(existing) : new SQL.Database();
      this.ensureSchema();
      this.lastHealth = {
        ok: true,
        rebuilt: false,
        path: dbPath,
        updatedAt: new Date().toISOString()
      };
      await this.save();
      return this.lastHealth;
    } catch (err) {
      return this.rebuild(err instanceof Error ? err.message : String(err));
    }
  }

  async rebuild(reason?: string): Promise<StateIndexHealth> {
    const SQL = await this.loadSqlJs();
    this.db = new SQL.Database();
    this.ensureSchema();
    await this.ingestAll();
    await this.save();
    this.lastHealth = {
      ok: true,
      rebuilt: true,
      path: this.options.dbPath ?? getStateIndexPath(),
      error: reason,
      updatedAt: new Date().toISOString()
    };
    return this.lastHealth;
  }

  async health(): Promise<StateIndexHealth> {
    if (!this.db) {
      return this.init();
    }
    try {
      this.db.exec("SELECT COUNT(*) FROM runs;");
      return {
        ...this.lastHealth,
        ok: true,
        updatedAt: new Date().toISOString()
      };
    } catch (err) {
      return this.rebuild(err instanceof Error ? err.message : String(err));
    }
  }

  async queryRuns(workspaceId?: string): Promise<IndexedRunRecord[]> {
    await this.health();
    if (!this.db) return [];
    const statement = workspaceId
      ? this.db.prepare("SELECT workspace_id, run_id, kind, status, start, end, repo_path, workflow, readiness_score, readiness_blocking FROM runs WHERE workspace_id = ? ORDER BY start DESC")
      : this.db.prepare("SELECT workspace_id, run_id, kind, status, start, end, repo_path, workflow, readiness_score, readiness_blocking FROM runs ORDER BY start DESC");
    const rows: IndexedRunRecord[] = [];
    if (workspaceId) {
      statement.bind([workspaceId]);
    }
    while (statement.step()) {
      const row = statement.getAsObject();
      rows.push({
        workspaceId: String(row.workspace_id ?? ""),
        runId: String(row.run_id ?? ""),
        kind: String(row.kind ?? "workflow"),
        status: String(row.status ?? ""),
        start: String(row.start ?? ""),
        end: row.end ? String(row.end) : null,
        repoPath: String(row.repo_path ?? ""),
        workflow: String(row.workflow ?? ""),
        readinessScore: row.readiness_score == null ? null : Number(row.readiness_score),
        readinessBlocking: parseJsonArray(row.readiness_blocking)
      });
    }
    statement.free();
    return rows;
  }

  async getLatestReadiness(workspaceId?: string): Promise<{ workspaceId: string; score: number | null; blocking: string[]; runId: string | null } | null> {
    const runs = await this.queryRuns(workspaceId);
    const latest = runs[0];
    if (!latest) return null;
    return {
      workspaceId: latest.workspaceId,
      score: latest.readinessScore,
      blocking: latest.readinessBlocking,
      runId: latest.runId
    };
  }

  private async ingestAll(): Promise<void> {
    if (!this.db) return;
    this.db.run("DELETE FROM workspaces;");
    this.db.run("DELETE FROM plugins;");
    this.db.run("DELETE FROM runs;");
    this.db.run("DELETE FROM approvals;");
    this.db.run("DELETE FROM governance_events;");
    this.db.run("DELETE FROM learnings;");

    const workspaces = await loadWorkspaces(this.options.rootDir).catch(() => []);
    for (const workspace of workspaces) {
      this.db.run(
        "INSERT OR REPLACE INTO workspaces (id, path, name, updated_at) VALUES (?, ?, ?, ?)",
        [workspace.id, workspace.path, workspace.name ?? null, workspace.updatedAt ?? workspace.createdAt ?? null]
      );
      const learnings = await loadLearnings(workspace.path).catch(() => []);
      for (const learning of learnings) {
        this.db.run(
          "INSERT OR REPLACE INTO learnings (id, workspace_id, ts, category, insight, related_files, run_id, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            learning.id,
            workspace.id,
            learning.timestamp,
            learning.category,
            learning.insight,
            JSON.stringify(learning.relatedFiles ?? []),
            learning.sourceRunId ?? null,
            learning.confidence
          ]
        );
      }
    }

    const plugins = await listInstalledPlugins().catch(() => []);
    for (const plugin of plugins) {
      this.db.run(
        "INSERT OR REPLACE INTO plugins (name, version, enabled, path) VALUES (?, ?, ?, ?)",
        [plugin.name, plugin.version, plugin.enabled ? 1 : 0, plugin.path]
      );
    }

    const runDirs = await scanRunDirs(this.options.runsDir);
    for (const record of runDirs) {
      const runMeta = await readJsonIfExists<any>(path.join(record.runDir, "run.json"));
      if (!runMeta) continue;
      this.db.run(
        "INSERT OR REPLACE INTO runs (workspace_id, run_id, kind, status, start, end, repo_path, workflow, readiness_score, readiness_blocking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          record.workspaceId,
          runMeta.runId ?? record.runId,
          runMeta.kind ?? "workflow",
          runMeta.status ?? "unknown",
          runMeta.start ?? "",
          runMeta.end ?? null,
          runMeta.repoPath ?? "",
          runMeta.workflow ?? "",
          runMeta.readiness?.score ?? null,
          JSON.stringify(runMeta.readiness?.blocking ?? [])
        ]
      );

      const approvalsDir = path.join(record.runDir, "approvals");
      const approvalFiles = await fs.readdir(approvalsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of approvalFiles) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const request = await readJsonIfExists<any>(path.join(approvalsDir, entry.name));
        if (!request) continue;
        this.db.run(
          "INSERT OR REPLACE INTO approvals (token, workspace_id, run_id, step_id, kind, ts) VALUES (?, ?, ?, ?, ?, ?)",
          [
            request.token ?? entry.name.replace(/\.json$/, ""),
            record.workspaceId,
            request.runId ?? runMeta.runId ?? record.runId,
            request.stepId ?? null,
            request.kind ?? "command",
            request.ts ?? runMeta.start ?? null
          ]
        );
      }

      const governanceEvents = await loadGovernanceEvents(record.runDir).catch(() => []);
      for (const event of governanceEvents) {
        this.db.run(
          "INSERT OR REPLACE INTO governance_events (id, workspace_id, run_id, step_id, category, severity, summary, ts, files, commands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            event.id,
            record.workspaceId,
            event.runId,
            event.stepId,
            event.category,
            event.severity,
            event.summary,
            event.ts,
            JSON.stringify(event.files ?? []),
            JSON.stringify(event.commands ?? [])
          ]
        );
      }
    }
  }

  private ensureSchema(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT,
        updated_at TEXT
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS plugins (
        name TEXT PRIMARY KEY,
        version TEXT,
        enabled INTEGER,
        path TEXT
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT,
        status TEXT,
        start TEXT,
        end TEXT,
        repo_path TEXT,
        workflow TEXT,
        readiness_score REAL,
        readiness_blocking TEXT,
        PRIMARY KEY (workspace_id, run_id)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS approvals (
        token TEXT PRIMARY KEY,
        workspace_id TEXT,
        run_id TEXT,
        step_id TEXT,
        kind TEXT,
        ts TEXT
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS governance_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        run_id TEXT,
        step_id TEXT,
        category TEXT,
        severity TEXT,
        summary TEXT,
        ts TEXT,
        files TEXT,
        commands TEXT
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        ts TEXT,
        category TEXT,
        insight TEXT,
        related_files TEXT,
        run_id TEXT,
        confidence REAL
      );
    `);
  }

  private async save(): Promise<void> {
    if (!this.db) return;
    const dbPath = this.options.dbPath ?? getStateIndexPath();
    const payload = this.db.export();
    await fs.writeFile(dbPath, Buffer.from(payload));
  }

  private async loadSqlJs(): Promise<SqlJsModule> {
    if (this.sqlModule) return this.sqlModule;
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const initSqlJs = (await import("sql.js")).default;
    this.sqlModule = (await initSqlJs({
      locateFile: (file: string) => (file.endsWith(".wasm") ? wasmPath : file)
    })) as SqlJsModule;
    return this.sqlModule;
  }
}

async function scanRunDirs(runsDir: string): Promise<Array<{ workspaceId: string; runId: string; runDir: string }>> {
  const results: Array<{ workspaceId: string; runId: string; runDir: string }> = [];
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name);
    const legacyRun = path.join(candidate, "run.json");
    if (fsSync.existsSync(legacyRun)) {
      results.push({ workspaceId: "legacy", runId: entry.name, runDir: candidate });
      continue;
    }
    const nested = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
    for (const nestedEntry of nested) {
      if (!nestedEntry.isDirectory()) continue;
      results.push({
        workspaceId: entry.name,
        runId: nestedEntry.name,
        runDir: path.join(candidate, nestedEntry.name)
      });
    }
  }
  return results;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
