"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { DeliverySummary, RunSummary } from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";
import { type DeliveryBinding, type DeliveryCapability, toolLabel } from "@/lib/delivery";

type TeamPresetPayload = {
  preset?: {
    name?: string;
    roles?: Array<{ id: string; mode: string }>;
  } | null;
  scaffoldPreset?: {
    name?: string;
    roles?: Array<{ id: string; mode: string }>;
  };
  suggestedBindings?: DeliveryBinding[];
  capabilities?: DeliveryCapability[];
};

export default function DeliveryPage() {
  const { selectedWorkspaceId, openRunConfig } = useAppUi();
  const [preset, setPreset] = useState<TeamPresetPayload | null>(null);
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const load = async () => {
      const [presetRes, runsRes, summaryRes] = await Promise.all([
        fetch(`/api/team-preset?workspace=${encodeURIComponent(selectedWorkspaceId)}`, { cache: "no-store" }),
        fetch(`/api/runs?workspace=${encodeURIComponent(selectedWorkspaceId)}`, { cache: "no-store" }),
        fetch(`/api/delivery/summary?workspace=${encodeURIComponent(selectedWorkspaceId)}`, { cache: "no-store" })
      ]);
      if (presetRes.ok) setPreset((await presetRes.json()) as TeamPresetPayload);
      if (runsRes.ok) {
        const payload = (await runsRes.json()) as RunSummary[];
        setRuns(payload.filter((run) => run.kind === "mission" && run.missionTemplateId === "delivery-sprint"));
      }
      if (summaryRes.ok) {
        setSummary((await summaryRes.json()) as DeliverySummary);
      }
    };
    void load();
  }, [selectedWorkspaceId]);

  const activePreset = useMemo(() => preset?.preset ?? preset?.scaffoldPreset ?? null, [preset]);
  const discoveredTargets = useMemo(() => {
    const targets = new Set<string>();
    for (const binding of preset?.suggestedBindings ?? []) {
      if (binding.available) targets.add(binding.target);
    }
    for (const [tool, count] of Object.entries(summary?.toolUsage ?? {})) {
      if (count > 0) targets.add(tool);
    }
    return Array.from(targets);
  }, [preset?.suggestedBindings, summary?.toolUsage]);

  const presetHealth = useMemo(() => {
    if (!activePreset) return "No preset saved yet";
    const roleCount = activePreset.roles?.length ?? 0;
    const availableBindings = (preset?.suggestedBindings ?? []).filter((binding) => binding.available).length;
    return `${roleCount} role(s), ${availableBindings} ready binding(s)`;
  }, [activePreset, preset?.suggestedBindings]);

  return (
    <main className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Delivery</h2>
          <p className="text-sm text-slate-400">Track delivery-oriented missions and workspace handoff readiness.</p>
        </div>
        <button
          onClick={() => openRunConfig({ workspaceId: selectedWorkspaceId || undefined, runKind: "mission", missionTemplateId: "delivery-sprint" })}
          className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-emerald-200"
        >
          Start Delivery Mission
        </button>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Preset Health" value={activePreset?.name ?? "Scaffold only"} sub={presetHealth} accent="text-white" />
        <SummaryCard label="Active Sessions" value={String(summary?.activeSessions ?? 0)} sub={`${summary?.sessions ?? 0} total session(s)`} accent="text-cyan-300" />
        <SummaryCard label="Open Findings" value={String(summary?.openFindings ?? 0)} sub={`${summary?.resolvedFindings ?? 0} resolved`} accent="text-rose-300" />
        <SummaryCard label="Manual Packets" value={String(summary?.unresolvedManualPackets ?? 0)} sub={`${summary?.unmatchedImportAttempts ?? 0} unmatched import attempt(s)`} accent="text-amber-300" />
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-4">
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
            <div className="mt-5">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Discovered Targets</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {discoveredTargets.length === 0 && <span className="text-xs text-slate-500">No handoff targets discovered yet.</span>}
                {discoveredTargets.map((target) => (
                  <span key={target} className="rounded-full border border-slate-700 bg-slate-900/40 px-3 py-1 text-[11px] text-slate-300">
                    {toolLabel(target)}
                  </span>
                ))}
              </div>
            </div>
            <Link href="/settings" className="mt-5 inline-flex text-xs uppercase tracking-[0.18em] text-cyan-300 hover:text-cyan-200">
              Open settings →
            </Link>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-white">Tool Usage</div>
              <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{Object.keys(summary?.toolUsage ?? {}).length}</span>
            </div>
            <div className="space-y-2">
              {Object.entries(summary?.toolUsage ?? {}).length === 0 && <div className="text-xs text-slate-500">No handoff exports yet.</div>}
              {Object.entries(summary?.toolUsage ?? {})
                .sort((a, b) => b[1] - a[1])
                .map(([tool, count]) => (
                  <div key={tool} className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{toolLabel(tool)}</div>
                      <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{count} export(s)</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>
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

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${accent}`}>{value}</div>
      <div className="mt-1 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}
