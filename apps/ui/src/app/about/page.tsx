"use client";

import { useEffect, useState } from "react";

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

export default function AboutPage() {
  const [data, setData] = useState<any>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");

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
    };
    load();
  }, []);

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
    const payload = await res.json().catch(() => ({}));
    setInstalling(false);
    if (!res.ok) {
      setUpdateMessage(payload.error ?? "Update install failed.");
      return;
    }
    setUpdateMessage(
      `Installed ${payload.version ?? update?.available?.version ?? "update"} (${payload.updatedFiles ?? 0} files). Restart Orchestrum to load the new build.`
    );
  };

  return (
    <main className="space-y-6">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/40 p-8">
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-gradient-to-br from-amber-400/5 to-cyan-400/5 blur-3xl" />
        <div className="relative flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/20 to-cyan-400/20 text-2xl text-amber-300">
            ◉
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Orchestrum</h2>
            <p className="text-sm text-slate-400">Local-first AI engineering control plane</p>
          </div>
        </div>
        <p className="relative mt-4 max-w-xl text-sm leading-relaxed text-slate-300">
          Orchestrum runs local mission workflows, delivery handoffs, browser smoke checks, and evidence capture on your machine.
          Agent and org surfaces are coordination tools around that mission spine, not a claim of fully autonomous delivery.
        </p>
      </section>

      {/* Version info */}
      <section className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Version</div>
          <div className="mt-2 text-lg font-semibold text-white">{version}</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Build Date</div>
          <div className="mt-2 text-lg font-semibold text-white">{buildDate}</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Edition</div>
          <div className="mt-2 text-lg font-semibold text-white">Open Source</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">License</div>
          <div className="mt-2 text-lg font-semibold text-white">MIT</div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Updater</h3>
            <p className="mt-1 text-xs text-slate-500">
              Checks are manual. Cached release metadata is shown until you refresh from GitHub Releases.
            </p>
          </div>
          <span className="rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-500">
            {updateSource}
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Current</div>
            <div className="mt-2 text-sm font-semibold text-white">{update?.current?.version ?? version}</div>
            <div className="mt-1 text-[11px] text-slate-500">{update?.current?.channel ?? data?.version?.channel ?? "stable"}</div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Available</div>
            <div className="mt-2 text-sm font-semibold text-white">{update?.available?.version ?? "—"}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              {update?.selectedAsset ? `${update.selectedAsset.platform}/${update.selectedAsset.arch}` : update?.reason ?? "No cached release metadata"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Status</div>
            <div className={`mt-2 text-sm font-semibold ${update?.updateAvailable ? "text-amber-200" : "text-emerald-200"}`}>
              {update?.updateAvailable ? "Update available" : "Up to date"}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">{update?.selectedAsset?.name ?? "No installable asset selected"}</div>
          </div>
        </div>

        {(update?.available?.notes || update?.available?.releaseUrl) && (
          <div className="mt-4 rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Release Notes</div>
              {update?.available?.releaseUrl && (
                <a
                  href={update.available.releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-amber-300 hover:text-amber-200"
                >
                  Open release →
                </a>
              )}
            </div>
            {update?.available?.notes && (
              <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-300">
                {update.available.notes}
              </pre>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={() => void handleCheckUpdates()}
            disabled={checking}
            className="rounded-lg border border-sky-400/40 bg-sky-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-sky-200 disabled:opacity-50"
          >
            {checking ? "Checking…" : "Check for Updates"}
          </button>
          <button
            onClick={() => void handleInstallUpdate()}
            disabled={!update?.updateAvailable || !update?.selectedAsset || installing}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-200 disabled:opacity-40"
          >
            {installing ? "Installing…" : "Install Update"}
          </button>
        </div>

        {updateMessage && <div className="mt-3 text-xs text-slate-400">{updateMessage}</div>}
      </section>

      {/* Key principles */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-sm font-semibold text-white">Core Principles</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
            <div className="text-lg">🔒</div>
            <div className="mt-2 text-xs font-medium text-white">Local-first Privacy</div>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-400">
              Your code never leaves your machine. Agent execution, logs, and artifacts stay on local disk.
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
            <div className="text-lg">⚡</div>
            <div className="mt-2 text-xs font-medium text-white">Zero Lock-in</div>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-400">
              Swap AI providers freely. Works with OpenAI, Anthropic, and local models via Ollama.
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
            <div className="text-lg">🧩</div>
            <div className="mt-2 text-xs font-medium text-white">Plugin Ecosystem</div>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-400">
              Extend with local plugins. Cost alerts, custom loggers, and mission hooks stay local.
            </div>
          </div>
        </div>
      </section>

      {/* Links */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-sm font-semibold text-white">Resources</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <a
            href="https://github.com/mrtergn/orchestrum"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl border border-slate-800/60 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 transition-colors hover:border-amber-400/30 hover:bg-amber-400/5"
          >
            <span className="text-base">⬡</span>
            <div>
              <div className="font-medium">GitHub Repository</div>
              <div className="text-[11px] text-slate-500">Source code, issues, and contributions</div>
            </div>
          </a>
          <a
            href="https://github.com/mrtergn/orchestrum/blob/main/docs/ARCHITECTURE.md"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl border border-slate-800/60 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 transition-colors hover:border-amber-400/30 hover:bg-amber-400/5"
          >
            <span className="text-base">📖</span>
            <div>
              <div className="font-medium">Documentation</div>
              <div className="text-[11px] text-slate-500">Architecture, plugins, and mission guides</div>
            </div>
          </a>
          <a
            href="https://github.com/mrtergn/orchestrum/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl border border-slate-800/60 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 transition-colors hover:border-amber-400/30 hover:bg-amber-400/5"
          >
            <span className="text-base">📝</span>
            <div>
              <div className="font-medium">Changelog</div>
              <div className="text-[11px] text-slate-500">Release notes and version history</div>
            </div>
          </a>
          <a
            href="https://github.com/mrtergn/orchestrum/blob/main/CONTRIBUTING.md"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl border border-slate-800/60 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 transition-colors hover:border-amber-400/30 hover:bg-amber-400/5"
          >
            <span className="text-base">🤝</span>
            <div>
              <div className="font-medium">Contributing Guide</div>
              <div className="text-[11px] text-slate-500">How to contribute code, plugins, and docs</div>
            </div>
          </a>
        </div>
      </section>

      {/* Credits */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6 text-center">
        <p className="text-xs text-slate-500">
          Made with care for engineers who value privacy and autonomy.
        </p>
        <p className="mt-1 text-[11px] text-slate-600">
          Free and open source — no license keys, no tiered restrictions, no telemetry by default.
        </p>
      </section>
    </main>
  );
}
