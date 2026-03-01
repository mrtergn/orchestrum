"use client";

import { useEffect, useState } from "react";

export default function AboutPage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/meta/about", { cache: "no-store" });
      if (!res.ok) return;
      const payload = await res.json();
      setData(payload);
    };
    load();
  }, []);

  const version = data?.version?.version ?? "—";
  const buildDate = data?.version?.buildDate ?? "—";

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
            <p className="text-sm text-slate-400">Local-first AI Engineering OS</p>
          </div>
        </div>
        <p className="relative mt-4 max-w-xl text-sm leading-relaxed text-slate-300">
          Orchestrum turns your local machine into an autonomous engineering department. Define agents, wire org charts,
          and let AI plan, build, audit, and deploy — all without sending code to third parties.
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
              Extend with local plugins. Cost alerts, custom loggers, and workflow hooks — no servers needed.
            </div>
          </div>
        </div>
      </section>

      {/* Links */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-sm font-semibold text-white">Resources</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <a
            href="https://github.com/nicholasconfer/orchestrum"
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
            href="https://github.com/nicholasconfer/orchestrum/blob/main/docs/ARCHITECTURE.md"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl border border-slate-800/60 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 transition-colors hover:border-amber-400/30 hover:bg-amber-400/5"
          >
            <span className="text-base">📖</span>
            <div>
              <div className="font-medium">Documentation</div>
              <div className="text-[11px] text-slate-500">Architecture, plugins, and workflow guides</div>
            </div>
          </a>
          <a
            href="https://github.com/nicholasconfer/orchestrum/blob/main/CHANGELOG.md"
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
            href="https://github.com/nicholasconfer/orchestrum/blob/main/CONTRIBUTING.md"
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
