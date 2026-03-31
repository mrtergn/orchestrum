import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { getAppHome } from "../appHome.js";
import { ensureDir, readJsonIfExists } from "../runner/fs.js";
import { loadWorkspaces } from "../runner/workspaces.js";
import { listInstalledPlugins } from "../plugins/registry.js";
import { loadGovernanceEvents } from "../runner/governance.js";
import { loadLearnings } from "../runner/learnings.js";
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
      ? this.db.prepare("SELECT workspace_id, run_id, kind, status, start, end, repo_path, readiness_score, readiness_blocking FROM runs WHERE workspace_id = ? ORDER BY start DESC")
      : this.db.prepare("SELECT workspace_id, run_id, kind, status, start, end, repo_path, readiness_score, readiness_blocking FROM runs ORDER BY start DESC");
    const rows: IndexedRunRecord[] = [];
    if (workspaceId) {
      statement.bind([workspaceId]);
    }
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

  async queryDeliverySessions(workspaceId?: string): Promise<IndexedDeliverySessionRecord[]> {
    await this.health();
    if (!this.db) return [];
    const statement = workspaceId
      ? this.db.prepare("SELECT workspace_id, run_id, status, updated_at, open_findings, resolved_findings, remediations_open, remediations_done, unresolved_manual_packets, unmatched_import_attempts, packet_status_counts, tool_usage, import_confidence_counts, finding_category_counts, finding_severity_counts, remediation_priority_counts, latest_import FROM delivery_sessions WHERE workspace_id = ? ORDER BY updated_at DESC")
      : this.db.prepare("SELECT workspace_id, run_id, status, updated_at, open_findings, resolved_findings, remediations_open, remediations_done, unresolved_manual_packets, unmatched_import_attempts, packet_status_counts, tool_usage, import_confidence_counts, finding_category_counts, finding_severity_counts, remediation_priority_counts, latest_import FROM delivery_sessions ORDER BY updated_at DESC");
    const rows: IndexedDeliverySessionRecord[] = [];
    if (workspaceId) {
      statement.bind([workspaceId]);
    }
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
    return rows;
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

  private async ingestAll(): Promise<void> {
    if (!this.db) return;
    this.db.run("DELETE FROM workspaces;");
    this.db.run("DELETE FROM plugins;");
    this.db.run("DELETE FROM runs;");
    this.db.run("DELETE FROM delivery_sessions;");
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
        "INSERT OR REPLACE INTO runs (workspace_id, run_id, kind, status, start, end, repo_path, readiness_score, readiness_blocking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          record.workspaceId,
          runMeta.runId ?? record.runId,
          runMeta.kind ?? "unknown",
          runMeta.status ?? "unknown",
          runMeta.start ?? "",
          runMeta.end ?? null,
          runMeta.repoPath ?? "",
          runMeta.readiness?.score ?? null,
          JSON.stringify(runMeta.readiness?.blocking ?? [])
        ]
      );

      if (runMeta.kind === "delivery") {
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
          this.db.run(
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
      }

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
        this.db.run(column);
      } catch {
        // ignore existing columns for older local indexes
      }
    }
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
