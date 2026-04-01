import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureDir, readJsonIfExists } from "../runner/fs.js";
import { loadWorkspaces } from "../runner/workspaces.js";
import { listInstalledPlugins } from "../plugins/registry.js";
import { loadGovernanceEvents } from "../runner/governance.js";
import { loadLearnings } from "../runner/learnings.js";
import { getWorkspaceStateIndexPath } from "../runner/control.js";
import {
  DeliverySessionStateSchema,
  type DeliverySummary,
  type DeliverySummaryLatestImport
} from "../delivery/types.js";
import {
  countFindingCategoryCounts,
  countFindingSeverityCounts,
  countImportConfidenceCounts,
  countPacketStatuses,
  countRemediationPriorityCounts,
  createEmptyDeliverySummary,
  shouldReplaceLatestImport,
  toDeliverySummaryLatestImport
} from "../delivery/sessionState.js";

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
  readinessScore: number | null;
  readinessBlocking: string[];
  pauseReason: string | null;
  changeStatus: string | null;
  validationStatus: string | null;
  verdict: string | null;
};

export type IndexedDeliverySessionRecord = {
  workspaceId: string;
  runId: string;
  status: string;
  updatedAt: string;
  openFindings: number;
  resolvedFindings: number;
  remediationsOpen: number;
  remediationsDone: number;
  unresolvedManualPackets: number;
  unmatchedImportAttempts: number;
  packetStatusCounts: Record<string, number>;
  toolUsage: Record<string, number>;
  importConfidenceCounts: Record<string, number>;
  findingCategoryCounts: Record<string, number>;
  findingSeverityCounts: Record<string, number>;
  remediationPriorityCounts: Record<string, number>;
  latestImport: DeliverySummaryLatestImport | null;
};

export function getStateIndexPath(repoPath = process.cwd()): string {
  return getWorkspaceStateIndexPath(repoPath);
}

export class StateIndex {
  private sqlModule: SqlJsModule | null = null;
  private dbs = new Map<string, SqlJsDatabase>();
  private lastHealth: StateIndexHealth = {
    ok: false,
    rebuilt: false,
    path: "workspace-local"
  };

  constructor(
    private options: {
      rootDir: string;
      runsDir: string;
      dbPath?: string;
      listWorkspacePaths?: () => Promise<string[]>;
      resolveWorkspacePath?: (workspaceId: string) => Promise<string | null>;
    }
  ) {}

  async init(): Promise<StateIndexHealth> {
    return this.rebuild();
  }

  async rebuild(reason?: string): Promise<StateIndexHealth> {
    this.dbs.clear();
    const workspaces = await this.listWorkspaces();
    for (const workspace of workspaces) {
      await this.rebuildWorkspace(workspace);
    }
    this.lastHealth = {
      ok: true,
      rebuilt: true,
      path: workspaces[0] ? getStateIndexPath(workspaces[0].path) : getStateIndexPath(this.options.rootDir),
      error: reason,
      updatedAt: new Date().toISOString()
    };
    return this.lastHealth;
  }

  async health(): Promise<StateIndexHealth> {
    if (this.dbs.size === 0) {
      return this.init();
    }
    try {
      for (const db of this.dbs.values()) {
        db.exec("SELECT COUNT(*) FROM runs;");
      }
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
    const rows: IndexedRunRecord[] = [];
    const workspaces = workspaceId
      ? (await this.resolveWorkspace(workspaceId)).filter(Boolean)
      : await this.listWorkspaces();
    for (const workspace of workspaces) {
      const db = await this.ensureWorkspaceDb(workspace);
      const statement = db.prepare(
        "SELECT workspace_id, run_id, kind, status, start, end, repo_path, readiness_score, readiness_blocking, pause_reason, change_status, validation_status, verdict FROM runs WHERE workspace_id = ? ORDER BY start DESC"
      );
      statement.bind([workspace.id]);
      while (statement.step()) {
        const row = statement.getAsObject();
        rows.push({
          workspaceId: String(row.workspace_id ?? ""),
          runId: String(row.run_id ?? ""),
          kind: String(row.kind ?? "unknown"),
          status: String(row.status ?? ""),
          start: String(row.start ?? ""),
          end: row.end ? String(row.end) : null,
          repoPath: String(row.repo_path ?? ""),
          readinessScore: row.readiness_score == null ? null : Number(row.readiness_score),
          readinessBlocking: parseJsonArray(row.readiness_blocking),
          pauseReason: row.pause_reason == null ? null : String(row.pause_reason),
          changeStatus: row.change_status == null ? null : String(row.change_status),
          validationStatus: row.validation_status == null ? null : String(row.validation_status),
          verdict: row.verdict == null ? null : String(row.verdict)
        });
      }
      statement.free();
    }
    return rows.sort((left, right) => (left.start < right.start ? 1 : -1));
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

  async queryDeliverySessions(workspaceId?: string): Promise<IndexedDeliverySessionRecord[]> {
    await this.health();
    const rows: IndexedDeliverySessionRecord[] = [];
    const workspaces = workspaceId
      ? (await this.resolveWorkspace(workspaceId)).filter(Boolean)
      : await this.listWorkspaces();
    for (const workspace of workspaces) {
      const db = await this.ensureWorkspaceDb(workspace);
      const statement = db.prepare(
        "SELECT workspace_id, run_id, status, updated_at, open_findings, resolved_findings, remediations_open, remediations_done, unresolved_manual_packets, unmatched_import_attempts, packet_status_counts, tool_usage, import_confidence_counts, finding_category_counts, finding_severity_counts, remediation_priority_counts, latest_import FROM delivery_sessions WHERE workspace_id = ? ORDER BY updated_at DESC"
      );
      statement.bind([workspace.id]);
      while (statement.step()) {
        const row = statement.getAsObject();
        rows.push({
          workspaceId: String(row.workspace_id ?? ""),
          runId: String(row.run_id ?? ""),
          status: String(row.status ?? ""),
          updatedAt: String(row.updated_at ?? ""),
          openFindings: Number(row.open_findings ?? 0),
          resolvedFindings: Number(row.resolved_findings ?? 0),
          remediationsOpen: Number(row.remediations_open ?? 0),
          remediationsDone: Number(row.remediations_done ?? 0),
          unresolvedManualPackets: Number(row.unresolved_manual_packets ?? 0),
          unmatchedImportAttempts: Number(row.unmatched_import_attempts ?? 0),
          packetStatusCounts: parseJsonRecord(row.packet_status_counts),
          toolUsage: parseJsonRecord(row.tool_usage),
          importConfidenceCounts: parseJsonRecord(row.import_confidence_counts),
          findingCategoryCounts: parseJsonRecord(row.finding_category_counts),
          findingSeverityCounts: parseJsonRecord(row.finding_severity_counts),
          remediationPriorityCounts: parseJsonRecord(row.remediation_priority_counts),
          latestImport: parseJsonObject<DeliverySummaryLatestImport>(row.latest_import)
        });
      }
      statement.free();
    }
    return rows.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
  }

  async getDeliverySummary(workspaceId?: string): Promise<DeliverySummary> {
    const sessions = await this.queryDeliverySessions(workspaceId);
    const summary = createEmptyDeliverySummary(workspaceId);
    summary.sessions = sessions.length;
    summary.latestRunId = sessions[0]?.runId ?? null;
    for (const session of sessions) {
      if (session.status === "running") summary.activeSessions += 1;
      if (session.status === "blocked" || session.status === "failed") summary.blockedSessions += 1;
      if (session.status === "completed") summary.completedSessions += 1;
      summary.openFindings += session.openFindings;
      summary.resolvedFindings += session.resolvedFindings;
      summary.remediationsOpen += session.remediationsOpen;
      summary.remediationsDone += session.remediationsDone;
      summary.unresolvedManualPackets += session.unresolvedManualPackets;
      summary.unmatchedImportAttempts += session.unmatchedImportAttempts;
      for (const [status, count] of Object.entries(session.packetStatusCounts)) {
        summary.packetStatusCounts[status] = (summary.packetStatusCounts[status] ?? 0) + count;
      }
      for (const [tool, count] of Object.entries(session.toolUsage)) {
        summary.toolUsage[tool] = (summary.toolUsage[tool] ?? 0) + count;
      }
      for (const [confidence, count] of Object.entries(session.importConfidenceCounts)) {
        summary.importConfidenceCounts[confidence] = (summary.importConfidenceCounts[confidence] ?? 0) + count;
      }
      for (const [category, count] of Object.entries(session.findingCategoryCounts)) {
        summary.findingCategoryCounts[category] = (summary.findingCategoryCounts[category] ?? 0) + count;
      }
      for (const [severity, count] of Object.entries(session.findingSeverityCounts)) {
        summary.findingSeverityCounts[severity] = (summary.findingSeverityCounts[severity] ?? 0) + count;
      }
      for (const [priority, count] of Object.entries(session.remediationPriorityCounts)) {
        summary.remediationPriorityCounts[priority] = (summary.remediationPriorityCounts[priority] ?? 0) + count;
      }
      if (shouldReplaceLatestImport(summary.latestImport, session.latestImport)) {
        summary.latestImport = session.latestImport;
      }
    }
    return summary;
  }

  private async listWorkspaces() {
    const repoPaths = this.options.listWorkspacePaths ? await this.options.listWorkspacePaths().catch(() => []) : [];
    return loadWorkspaces(this.options.rootDir, { repoPaths }).catch(() => []);
  }

  private async resolveWorkspace(workspaceId: string) {
    const resolvedPath = this.options.resolveWorkspacePath
      ? await this.options.resolveWorkspacePath(workspaceId).catch(() => null)
      : null;
    const repoPaths = resolvedPath
      ? Array.from(new Set([resolvedPath, ...(this.options.listWorkspacePaths ? await this.options.listWorkspacePaths().catch(() => []) : [])]))
      : this.options.listWorkspacePaths
        ? await this.options.listWorkspacePaths().catch(() => [])
        : [];
    const workspaces = await loadWorkspaces(this.options.rootDir, { repoPaths }).catch(() => []);
    const match = workspaces.find((workspace) => workspace.id === workspaceId);
    return match ? [match] : [];
  }

  private async rebuildWorkspace(workspace: { id: string; path: string; name?: string; updatedAt?: string; createdAt?: string }) {
    const db = await this.ensureWorkspaceDb(workspace);
    db.run("DELETE FROM workspaces;");
    db.run("DELETE FROM plugins;");
    db.run("DELETE FROM runs;");
    db.run("DELETE FROM delivery_sessions;");
    db.run("DELETE FROM approvals;");
    db.run("DELETE FROM governance_events;");
    db.run("DELETE FROM learnings;");

    db.run(
      "INSERT OR REPLACE INTO workspaces (id, path, name, updated_at) VALUES (?, ?, ?, ?)",
      [workspace.id, workspace.path, workspace.name ?? null, workspace.updatedAt ?? workspace.createdAt ?? null]
    );

    const learnings = await loadLearnings(workspace.path).catch(() => []);
    for (const learning of learnings) {
      db.run(
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

    const plugins = await listInstalledPlugins(workspace.path).catch(() => []);
    for (const plugin of plugins) {
      db.run(
        "INSERT OR REPLACE INTO plugins (name, version, enabled, path) VALUES (?, ?, ?, ?)",
        [plugin.name, plugin.version, plugin.enabled ? 1 : 0, plugin.path]
      );
    }

    const runDirs = await scanRunDirs(this.options.runsDir);
    for (const record of runDirs.filter((item) => item.workspaceId === workspace.id)) {
      const runMeta = await readJsonIfExists<any>(path.join(record.runDir, "run.json"));
      if (!runMeta) continue;
      db.run(
        "INSERT OR REPLACE INTO runs (workspace_id, run_id, kind, status, start, end, repo_path, readiness_score, readiness_blocking, pause_reason, change_status, validation_status, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          record.workspaceId,
          runMeta.runId ?? record.runId,
          runMeta.kind ?? "unknown",
          runMeta.status ?? "unknown",
          runMeta.start ?? "",
          runMeta.end ?? null,
          runMeta.repoPath ?? "",
          runMeta.readiness?.score ?? null,
          JSON.stringify(runMeta.readiness?.blocking ?? []),
          runMeta.pauseReason ?? null,
          runMeta.change?.status ?? null,
          runMeta.validation?.status ?? null,
          runMeta.verdict ?? null
        ]
      );

      const deliveryRaw = await readJsonIfExists<unknown>(path.join(record.runDir, "delivery", "session.json"));
      const deliverySession = deliveryRaw ? DeliverySessionStateSchema.parse(deliveryRaw) : null;
      if (deliverySession) {
        const packetStatusCounts = countPacketStatuses(deliverySession.packets);
        const toolUsage = countToolUsage(deliverySession.exports);
        const importConfidenceCounts = countImportConfidenceCounts(deliverySession.imports);
        const findingCategoryCounts = countFindingCategoryCounts(deliverySession.findings);
        const findingSeverityCounts = countFindingSeverityCounts(deliverySession.findings);
        const remediationPriorityCounts = countRemediationPriorityCounts(deliverySession.remediations);
        const latestImport = toDeliverySummaryLatestImport(deliverySession.imports[0], deliverySession.runId);
        db.run(
          "INSERT OR REPLACE INTO delivery_sessions (workspace_id, run_id, status, updated_at, open_findings, resolved_findings, remediations_open, remediations_done, unresolved_manual_packets, unmatched_import_attempts, packet_status_counts, tool_usage, import_confidence_counts, finding_category_counts, finding_severity_counts, remediation_priority_counts, latest_import) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            record.workspaceId,
            deliverySession.runId,
            deliverySession.status,
            deliverySession.updatedAt,
            deliverySession.findings.filter((finding) => finding.status === "open").length,
            deliverySession.findings.filter((finding) => finding.status === "resolved").length,
            deliverySession.remediations.filter((task) => task.status !== "done").length,
            deliverySession.remediations.filter((task) => task.status === "done").length,
            deliverySession.packets.filter((packet) => packet.mode !== "auto_cli" && packet.status !== "completed").length,
            deliverySession.imports.filter((item) => item.matchStatus !== "matched").length,
            JSON.stringify(packetStatusCounts),
            JSON.stringify(toolUsage),
            JSON.stringify(importConfidenceCounts),
            JSON.stringify(findingCategoryCounts),
            JSON.stringify(findingSeverityCounts),
            JSON.stringify(remediationPriorityCounts),
            latestImport ? JSON.stringify(latestImport) : null
          ]
        );
      }

      const approvalsDir = path.join(record.runDir, "approvals");
      const approvalFiles = await fs.readdir(approvalsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of approvalFiles) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const request = await readJsonIfExists<any>(path.join(approvalsDir, entry.name));
        if (!request) continue;
        db.run(
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
        db.run(
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

    await this.saveWorkspaceDb(workspace.path, db);
  }

  private async ensureWorkspaceDb(workspace: { path: string }) {
    const key = path.resolve(workspace.path);
    const existingDb = this.dbs.get(key);
    if (existingDb) return existingDb;
    const SQL = await this.loadSqlJs();
    const dbPath = getStateIndexPath(workspace.path);
    await ensureDir(path.dirname(dbPath));
    const existing = await fs.readFile(dbPath).catch(() => null);
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    this.ensureSchema(db);
    this.dbs.set(key, db);
    return db;
  }

  private ensureSchema(db: SqlJsDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT,
        updated_at TEXT
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS plugins (
        name TEXT PRIMARY KEY,
        version TEXT,
        enabled INTEGER,
        path TEXT
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT,
        status TEXT,
        start TEXT,
        end TEXT,
        repo_path TEXT,
        readiness_score REAL,
        readiness_blocking TEXT,
        pause_reason TEXT,
        change_status TEXT,
        validation_status TEXT,
        verdict TEXT,
        PRIMARY KEY (workspace_id, run_id)
      );
    `);
    for (const column of [
      "ALTER TABLE runs ADD COLUMN pause_reason TEXT",
      "ALTER TABLE runs ADD COLUMN change_status TEXT",
      "ALTER TABLE runs ADD COLUMN validation_status TEXT",
      "ALTER TABLE runs ADD COLUMN verdict TEXT"
    ]) {
      try {
        db.run(column);
      } catch {
        // ignore existing columns for local rebuilds
      }
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS approvals (
        token TEXT PRIMARY KEY,
        workspace_id TEXT,
        run_id TEXT,
        step_id TEXT,
        kind TEXT,
        ts TEXT
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS delivery_sessions (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT,
        updated_at TEXT,
        open_findings INTEGER,
        resolved_findings INTEGER,
        remediations_open INTEGER,
        remediations_done INTEGER,
        unresolved_manual_packets INTEGER,
        unmatched_import_attempts INTEGER,
        packet_status_counts TEXT,
        tool_usage TEXT,
        import_confidence_counts TEXT,
        finding_category_counts TEXT,
        finding_severity_counts TEXT,
        remediation_priority_counts TEXT,
        latest_import TEXT,
        PRIMARY KEY (workspace_id, run_id)
      );
    `);
    for (const column of [
      "ALTER TABLE delivery_sessions ADD COLUMN import_confidence_counts TEXT",
      "ALTER TABLE delivery_sessions ADD COLUMN finding_category_counts TEXT",
      "ALTER TABLE delivery_sessions ADD COLUMN finding_severity_counts TEXT",
      "ALTER TABLE delivery_sessions ADD COLUMN remediation_priority_counts TEXT",
      "ALTER TABLE delivery_sessions ADD COLUMN latest_import TEXT"
    ]) {
      try {
        db.run(column);
      } catch {
        // ignore existing columns for older local indexes
      }
    }
    db.run(`
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
    db.run(`
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

  private async saveWorkspaceDb(repoPath: string, db: SqlJsDatabase): Promise<void> {
    const dbPath = getStateIndexPath(repoPath);
    const payload = db.export();
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

function parseJsonObject<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: unknown): Record<string, number> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed ?? {}).map(([key, count]) => [key, Number(count ?? 0)])
    );
  } catch {
    return {};
  }
}

function countToolUsage(
  exportsList: Array<{
    targetTool: string;
  }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of exportsList) {
    counts[item.targetTool] = (counts[item.targetTool] ?? 0) + 1;
  }
  return counts;
}
