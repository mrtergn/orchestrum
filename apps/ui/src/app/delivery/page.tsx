"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { RunSummary } from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";

type TeamPresetPayload = {
  preset?: {
    name?: string;
    roles?: Array<{ id: string; mode: string }>;
  } | null;
  scaffoldPreset?: {
    name?: string;
    roles?: Array<{ id: string; mode: string }>;
  };
  suggestedBindings?: Array<{
    roleId: string;
    target: string;
    mode: string;
    available: boolean;
  }>;
};

export default function DeliveryPage() {
  const { selectedWorkspaceId, openRunConfig } = useAppUi();
  const [preset, setPreset] = useState<TeamPresetPayload | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const load = async () => {
      const [presetRes, runsRes] = await Promise.all([
        fetch(`/api/team-preset?workspace=${encodeURIComponent(selectedWorkspaceId)}`, { cache: "no-store" }),
        fetch(`/api/runs?workspace=${encodeURIComponent(selectedWorkspaceId)}`, { cache: "no-store" })
      ]);
      if (presetRes.ok) setPreset((await presetRes.json()) as TeamPresetPayload);
      if (runsRes.ok) {
        const payload = (await runsRes.json()) as RunSummary[];
        setRuns(payload.filter((run) => run.kind === "delivery"));
      }
    };
    void load();
  }, [selectedWorkspaceId]);

  const activePreset = useMemo(() => preset?.preset ?? preset?.scaffoldPreset ?? null, [preset]);

  return (
    <main className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Delivery</h2>
          <p className="text-sm text-slate-400">Start sprint runs, export work packets, import tool output, and track findings on a single local branch.</p>
        </div>
        <button
          onClick={() => openRunConfig({ workspaceId: selectedWorkspaceId || undefined, runKind: "delivery" })}
          className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-emerald-200"
        >
          Start Delivery Session
        </button>
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="text-sm font-semibold text-white">Team Preset</div>
          <div className="mt-1 text-xs text-slate-500">Repo-scoped roles and suggested handoff targets.</div>
          {activePreset ? (
            <div className="mt-4 space-y-2">
              <div className="text-sm text-white">{activePreset.name ?? "Unnamed preset"}</div>
              {(activePreset.roles ?? []).map((role) => (
                <div key={role.id} className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-white">{role.id}</div>
                    <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{role.mode}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 text-xs text-slate-500">Select a workspace to inspect or scaffold the repo preset.</div>
          )}
          {(preset?.suggestedBindings?.length ?? 0) > 0 && (
            <div className="mt-5 space-y-2">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Suggested bindings</div>
              {preset?.suggestedBindings?.map((binding) => (
                <div key={binding.roleId} className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-white">{binding.roleId}</div>
                    <span className={`text-[10px] uppercase tracking-[0.18em] ${binding.available ? "text-emerald-300" : "text-slate-500"}`}>
                      {binding.target}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">{binding.mode}</div>
                </div>
              ))}
            </div>
          )}
          <Link href="/settings" className="mt-5 inline-flex text-xs uppercase tracking-[0.18em] text-cyan-300 hover:text-cyan-200">
            Open settings →
          </Link>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-white">Recent Delivery Sessions</div>
            <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{runs.length}</span>
          </div>
          <div className="space-y-2">
            {runs.length === 0 && <div className="text-xs text-slate-500">No delivery sessions yet for this workspace.</div>}
            {runs.map((run) => (
              <Link
                key={run.runId}
                href={`/runs/${run.runId}?workspace=${encodeURIComponent(run.workspaceId ?? "")}`}
                className="block rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 transition hover:border-emerald-400/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-white">{run.goal || run.runId}</div>
                    <div className="mt-1 text-[11px] text-slate-500">{new Date(run.start).toLocaleString()}</div>
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{run.status}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
