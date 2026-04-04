"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  MetricStrip,
  NoticePanel,
  PageHeader,
  SurfacePanel
} from "@/components/ui/PagePrimitives";

type VersionMeta = {
  version: string;
  channel: string;
  buildDate?: string;
  notes?: string;
};

type ReleaseAsset = {
  name: string;
  platform: string;
  arch: string;
};

type UpdateStatus = {
  current: VersionMeta | null;
  available: (VersionMeta & { releaseUrl?: string; notes?: string }) | null;
  updateAvailable: boolean;
  checkedRemotely?: boolean;
  selectedAsset?: ReleaseAsset | null;
  reason?: string;
};

type UpdateInstallJournal = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "installing" | "completed" | "rolled_back";
  targetDir: string;
  archivePath: string;
  downloaded: boolean;
  impactedFiles: Array<{
    relativePath: string;
    existedBeforeInstall: boolean;
    backupPath?: string | null;
  }>;
  failureReason?: string;
  journalPath: string;
};

type UpdateHistoryResponse = {
  journals?: UpdateInstallJournal[];
  error?: string;
};

type UpdateInstallResponse = {
  version?: string;
  updatedFiles?: number;
  journalPath?: string;
  rollbackAvailable?: boolean;
  error?: string;
};

type UpdateRollbackResponse = {
  journalPath?: string;
  restoredFiles?: number;
  removedFiles?: number;
  error?: string;
};

export default function AboutPage() {
  const [data, setData] = useState<any>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateInstallJournal[]>([]);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [rollingBackJournal, setRollingBackJournal] = useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");

  const loadUpdateHistory = useCallback(async () => {
    const historyRes = await fetch("/api/updates/history?limit=5", { cache: "no-store" });
    if (!historyRes.ok) return;
    const payload = (await historyRes.json().catch(() => ({}))) as UpdateHistoryResponse;
    setHistory(Array.isArray(payload.journals) ? payload.journals : []);
  }, []);

  useEffect(() => {
    const load = async () => {
      const [aboutRes, updateRes] = await Promise.all([
        fetch("/api/meta/about", { cache: "no-store" }),
        fetch("/api/updates/status", { cache: "no-store" })
      ]);
      if (aboutRes.ok) {
        const payload = await aboutRes.json();
        setData(payload);
      }
      if (updateRes.ok) {
        const payload = await updateRes.json();
        setUpdate(payload);
      }
      await loadUpdateHistory();
    };
    void load();
  }, [loadUpdateHistory]);

  const version = data?.version?.version ?? "—";
  const buildDate = data?.version?.buildDate ?? "—";
  const updateSource = update?.checkedRemotely ? "GitHub Releases" : "Local cache";

  const handleCheckUpdates = async () => {
    setChecking(true);
    setUpdateMessage("");
    const res = await fetch("/api/updates/status?remote=1", { cache: "no-store" });
    const payload = await res.json().catch(() => ({}));
    setChecking(false);
    if (!res.ok) {
      setUpdateMessage(payload.error ?? "Update check failed.");
      return;
    }
    setUpdate(payload);
    setUpdateMessage(payload.updateAvailable ? "A newer release is available." : "Already up to date.");
  };

  const handleInstallUpdate = async () => {
    setInstalling(true);
    setUpdateMessage("");
    const res = await fetch("/api/updates/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remote: true })
    });
    const payload = (await res.json().catch(() => ({}))) as UpdateInstallResponse;
    setInstalling(false);
    if (!res.ok) {
      setUpdateMessage(payload.error ?? "Update install failed.");
      return;
    }
    await loadUpdateHistory();
    setUpdateMessage(
      `Installed ${payload.version ?? update?.available?.version ?? "update"} (${payload.updatedFiles ?? 0} files). ${
        payload.rollbackAvailable ? "Rollback journal recorded." : ""
      } Restart Orchestrum to load the new build.`
    );
  };

  const handleRollbackUpdate = async (journalPath: string) => {
    setRollingBackJournal(journalPath);
    setUpdateMessage("");
    const res = await fetch("/api/updates/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journalPath })
    });
    const payload = (await res.json().catch(() => ({}))) as UpdateRollbackResponse;
    setRollingBackJournal(null);
    if (!res.ok) {
      setUpdateMessage(payload.error ?? "Rollback failed.");
      return;
    }
    await loadUpdateHistory();
    const statusRes = await fetch("/api/updates/status", { cache: "no-store" });
    if (statusRes.ok) {
      const statusPayload = (await statusRes.json().catch(() => null)) as UpdateStatus | null;
      if (statusPayload) setUpdate(statusPayload);
    }
    setUpdateMessage(
      `Rolled back update. Restored ${payload.restoredFiles ?? 0} file(s), removed ${payload.removedFiles ?? 0} newly installed file(s).`
    );
  };

  return (
    <main className="page-shell">
      <PageHeader
        eyebrow="About"
        title="What Orchestrum is today"
        description="Orchestrum is a local-first AI engineering control plane for supervised repo work, delivery handoff, browser evidence, and explicit run truth. The desktop app is still a preview shell until signing and hardening are finished."
      />

      <MetricStrip
        items={[
          { label: "Version", value: version },
          { label: "Build date", value: buildDate },
          { label: "Edition", value: "Open Source" },
          {
            label: "Update status",
            value: update?.updateAvailable ? "Update available" : "Up to date",
            accentClassName: update?.updateAvailable ? "text-amber-200" : "text-emerald-300"
          }
        ]}
      />

      {updateMessage ? (
        <NoticePanel tone="info" title="Updater message">
          {updateMessage}
        </NoticePanel>
      ) : null}

      <section className="page-columns">
        <div className="summary-stack">
          <SurfacePanel
            title="Runtime posture"
            description="These are the practical boundaries of the current product."
          >
            <div className="space-y-3">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                <div className="text-sm font-semibold text-white">Local-first, not fully local-only</div>
                <div className="mt-1 text-sm text-slate-400">
                  Runs, artifacts, and most control state stay on local disk. API-backed providers can still receive prompts and repo context.
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                <div className="text-sm font-semibold text-white">Supervised, not self-driving</div>
                <div className="mt-1 text-sm text-slate-400">
                  Work, specialists, and team surfaces are built for inspectable supervised execution, not unattended delivery claims.
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                <div className="text-sm font-semibold text-white">Desktop still preview-grade</div>
                <div className="mt-1 text-sm text-slate-400">
                  Desktop owns the local service lifecycle and staged updates, but remains unsigned and not yet hardened.
                </div>
              </div>
            </div>
          </SurfacePanel>

          <SurfacePanel
            title="Updater"
            description="Checks are manual. Install history is staged and rollback-capable, but desktop is still preview-grade."
            actions={
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleCheckUpdates()}
                  disabled={checking}
                  className="rounded-xl border border-sky-400/40 bg-sky-400/10 px-4 py-2 text-xs font-medium text-sky-200 disabled:opacity-50"
                >
                  {checking ? "Checking..." : "Check for updates"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleInstallUpdate()}
                  disabled={!update?.updateAvailable || !update?.selectedAsset || installing}
                  className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium text-amber-200 disabled:opacity-40"
                >
                  {installing ? "Installing..." : "Install update"}
                </button>
              </div>
            }
          >
            <div className="space-y-3">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">Source</div>
                    <div className="mt-1 text-sm text-slate-400">{updateSource}</div>
                  </div>
                  <span className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1 text-xs text-slate-300">
                    {update?.selectedAsset ? `${update.selectedAsset.platform}/${update.selectedAsset.arch}` : update?.reason ?? "No asset selected"}
                  </span>
                </div>
              </div>
              {update?.available?.notes ? (
                <div className="inspect-surface">
                  <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">Latest release notes</div>
                  <pre className="inspect-scroll max-h-[280px] whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-200">
                    {update.available.notes}
                  </pre>
                </div>
              ) : null}
            </div>
          </SurfacePanel>
        </div>

        <div className="summary-stack">
          <SurfacePanel
            title="Recent install sessions"
            description="Rollback is only available for completed staged installs."
          >
            <div className="space-y-3">
              {history.length === 0 ? (
                <div className="text-sm text-slate-500">No update installs have been recorded on this machine yet.</div>
              ) : (
                history.map((journal) => {
                  const canRollback = journal.status === "completed";
                  return (
                    <div key={journal.journalPath} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-sm font-semibold text-white">
                            {journal.downloaded ? "Remote staged install" : "Local staged install"}
                          </div>
                          <div className="text-xs text-slate-500">{journal.updatedAt ?? journal.createdAt}</div>
                          <div className="text-xs text-slate-500">{journal.impactedFiles.length} impacted file(s)</div>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-xs ${
                          journal.status === "completed"
                            ? "border-amber-400/20 bg-amber-400/10 text-amber-200"
                            : journal.status === "rolled_back"
                              ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
                              : "border-slate-700 bg-slate-950/70 text-slate-400"
                        }`}>
                          {journal.status.replace("_", " ")}
                        </span>
                      </div>
                      {journal.failureReason ? (
                        <div className="mt-2 text-sm text-rose-300">{journal.failureReason}</div>
                      ) : null}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleRollbackUpdate(journal.journalPath)}
                          disabled={!canRollback || rollingBackJournal === journal.journalPath}
                          className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs font-medium text-rose-200 disabled:opacity-40"
                        >
                          {rollingBackJournal === journal.journalPath ? "Rolling back..." : "Rollback install"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </SurfacePanel>

          <SurfacePanel
            title="Support links"
            description="Support pages are available, but intentionally secondary to Work and Runs."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Link href="/help" className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white">
                Help & Docs
              </Link>
              <Link href="/changelog" className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white">
                Changelog
              </Link>
              <Link href="/eula" className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white">
                License
              </Link>
              <a
                href="https://github.com/mrtergn/orchestrum"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
              >
                GitHub repository
              </a>
            </div>
          </SurfacePanel>
        </div>
      </section>
    </main>
  );
}
