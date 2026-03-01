"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";

type RoadmapState = {
  roadmap: Array<{
    milestone: string;
    status: string;
    runId?: string | null;
    startedAt?: string;
    completedAt?: string;
  }>;
  updatedAt: string;
};

const STATUS_STYLE: Record<string, { badge: string; bar: string; icon: string; label: string }> = {
  completed: { badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", bar: "from-emerald-500 to-emerald-400", icon: "✓", label: "Complete" },
  running:   { badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",       bar: "from-amber-500 to-amber-400",    icon: "↻", label: "Running" },
  failed:    { badge: "bg-rose-500/15 text-rose-400 border-rose-500/30",           bar: "from-rose-500 to-rose-400",      icon: "✗", label: "Failed" },
  pending:   { badge: "bg-slate-500/15 text-slate-400 border-slate-500/30",        bar: "from-slate-600 to-slate-500",    icon: "◦", label: "Pending" },
};
const statusStyle = (s: string) => STATUS_STYLE[s?.toLowerCase()] ?? STATUS_STYLE["pending"]!;

export default function RoadmapPage() {
  const { selectedWorkspaceId } = useAppUi();
  const [roadmap, setRoadmap] = useState<RoadmapState | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!selectedWorkspaceId) { setRoadmap(null); return; }
      const res = await fetch(`/api/roadmap?workspace=${encodeURIComponent(selectedWorkspaceId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setRoadmap(data);
    };
    void load();
  }, [selectedWorkspaceId]);

  const milestones = roadmap?.roadmap ?? [];
  const completedCount = milestones.filter((m) => m.status === "completed").length;
  const overallProgress = milestones.length > 0 ? Math.round((completedCount / milestones.length) * 100) : 0;

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Roadmap</h2>
          <p className="text-sm text-slate-400">Milestone progress across autonomous runs.</p>
        </div>
        {selectedWorkspaceId && (
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] text-slate-500">
            {selectedWorkspaceId}
          </span>
        )}
      </section>

      {/* Empty: no workspace */}
      {!selectedWorkspaceId && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 text-2xl text-slate-500">⛯</div>
          <h3 className="mt-3 text-base font-semibold text-white">Select workspace</h3>
          <p className="mt-1 text-sm text-slate-400">Roadmap milestones are workspace-specific. Choose one to load its progress.</p>
          <Link href="/workspaces" className="mt-4 inline-block rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 hover:bg-amber-400/20 transition-colors">
            Open Workspaces
          </Link>
        </section>
      )}

      {/* Empty: no data */}
      {selectedWorkspaceId && !roadmap && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/20 to-amber-500/5 text-2xl text-amber-400">▤</div>
          <h3 className="mt-3 text-base font-semibold text-white">No roadmap yet</h3>
          <p className="mt-1 text-sm text-slate-400">Start a run or execute roadmap automation for this workspace.</p>
        </section>
      )}

      {roadmap && milestones.length > 0 && (
        <>
          {/* Overall progress */}
          <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Overall Progress</div>
              <span className="text-sm font-semibold text-white">{completedCount}/{milestones.length} milestones</span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </section>

          {/* Timeline */}
          <section className="relative space-y-0">
            {/* Vertical timeline line */}
            <div className="absolute left-[22px] top-0 bottom-0 w-px bg-slate-800" />

            {milestones.map((entry, idx) => {
              const s = statusStyle(entry.status);
              const progress = entry.status === "completed" ? 100 : entry.status === "running" ? 60 : entry.status === "failed" ? 100 : 15;
              return (
                <div key={entry.milestone} className="relative flex gap-4 pb-1">
                  {/* Timeline dot */}
                  <div className="relative z-10 flex-shrink-0 mt-5">
                    <div className={`flex h-[44px] w-[44px] items-center justify-center rounded-xl border text-sm font-bold ${s.badge}`}>
                      {s.icon}
                    </div>
                  </div>

                  {/* Content card */}
                  <div className="flex-1 rounded-2xl border border-slate-800 bg-slate-950/40 p-5 space-y-3 my-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">{entry.milestone}</div>
                        <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-500">
                          {entry.runId && (
                            <Link href={`/runs/${entry.runId}`} className="text-cyan-400/70 hover:text-cyan-300 transition-colors">
                              Run {entry.runId.slice(0, 8)}…
                            </Link>
                          )}
                          {entry.startedAt && <span>Started {new Date(entry.startedAt).toLocaleDateString()}</span>}
                          {entry.completedAt && <span>Completed {new Date(entry.completedAt).toLocaleDateString()}</span>}
                        </div>
                      </div>
                      <span className={`flex-shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${s.badge}`}>
                        {s.label}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${s.bar} transition-all`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-slate-600">Step {idx + 1} of {milestones.length}</div>
                  </div>
                </div>
              );
            })}
          </section>
        </>
      )}
    </main>
  );
}
