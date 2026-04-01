"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";

type BrowserRun = {
  runId: string;
  kind: string;
  status: string;
  start: string;
  end?: string | null;
  repoPath?: string;
};

export default function BrowserPage() {
  const { selectedWorkspaceId, openRunConfig } = useAppUi();
  const [runs, setRuns] = useState<BrowserRun[]>([]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedWorkspaceId) params.set("workspace", selectedWorkspaceId);
    fetch(`/api/runs?${params.toString()}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => {
        const items = Array.isArray(payload) ? payload as BrowserRun[] : [];
        setRuns(items.filter((run) => run.kind === "qa" || run.kind === "benchmark" || run.kind === "canary"));
      })
      .catch(() => setRuns([]));
  }, [selectedWorkspaceId]);

  const summary = useMemo(() => {
    const completed = runs.filter((run) => run.status === "completed").length;
    const failed = runs.filter((run) => run.status === "failed" || run.status === "blocked").length;
    return { total: runs.length, completed, failed };
  }, [runs]);

  return (
    <main className="space-y-6">
      <section className="rounded-2xl border border-slate-800 bg-slate-950/50 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Browser Smoke</div>
            <h1 className="text-2xl font-semibold text-white">Smoke and scenario evidence</h1>
            <p className="max-w-2xl text-sm text-slate-400">
              Browser runs are operator-facing evidence, not release certification. Use smoke runs for fast capture and add scenarios when you need explicit journey steps and assertions.
            </p>
          </div>
          <button
            onClick={() => openRunConfig()}
            className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium text-amber-200 transition hover:bg-amber-400/20"
          >
            Launch browser run
          </button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Recent browser runs", value: summary.total },
          { label: "Completed", value: summary.completed },
          { label: "Attention needed", value: summary.failed }
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{item.label}</div>
            <div className="mt-2 text-2xl font-semibold text-white">{item.value}</div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Recent browser evidence</h2>
            <p className="text-sm text-slate-500">Smoke, benchmark, and canary runs from the selected workspace.</p>
          </div>
        </div>
        <div className="space-y-3">
          {runs.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
              No browser runs yet.
            </div>
          )}
          {runs.map((run) => (
            <div key={run.runId} className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{run.kind}</div>
                  <div className="mt-1 text-sm font-medium text-white">{run.runId}</div>
                </div>
                <div className="text-right">
                  <div className={`text-xs font-medium ${run.status === "completed" ? "text-emerald-300" : "text-amber-200"}`}>{run.status}</div>
                  <div className="mt-1 text-[11px] text-slate-500">{new Date(run.start).toLocaleString()}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
