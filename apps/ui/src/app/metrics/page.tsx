"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";

/* ---------- types ---------- */
type AnalyticsData = {
  runs: number;
  successes: number;
  failures: number;
  totalCost: number;
  costPerFeature: number;
  perAgent: Record<
    string,
    { runs: number; successes: number; failures: number; totalTokens: number; totalCost: number; avgScore: number }
  >;
  loopCounts: { total: number; avg: number };
  failureTypes: { policy: number; audit: number; test: number; security: number };
  trends: {
    cost: Array<{ ts: string; cost: number }>;
    successRate: Array<{ ts: string; rate: number }>;
    loops: Array<{ ts: string; avg: number }>;
    reward: Array<{ ts: string; reward: number }>;
  };
  testStability: { total: number; failed: number; index: number };
  modelUsage: Record<string, number>;
  workerStats?: Array<{ ts: string; active: number; queue: number }>;
};

type EvaluationResult = {
  id: string;
  workflow: string;
  runs: number;
  runIds: string[];
  similarity: number;
  createdAt: string;
};

/* ---------- page ---------- */
export default function MetricsPage() {
  const { selectedWorkspaceId: workspaceId } = useAppUi();
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [evaluations, setEvaluations] = useState<EvaluationResult[]>([]);

  useEffect(() => {
    const load = async () => {
      if (!workspaceId) { setAnalytics(null); return; }
      const res = await fetch(`/api/analytics?workspace=${encodeURIComponent(workspaceId)}`);
      if (res.ok) {
        const data = await res.json();
        setAnalytics(normalizeAnalytics(data.analytics ?? data));
      }
    };
    load();
  }, [workspaceId]);

  useEffect(() => {
    const load = async () => {
      if (!workspaceId) { setEvaluations([]); return; }
      const res = await fetch(`/api/evaluations?workspace=${encodeURIComponent(workspaceId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setEvaluations(data.evaluations ?? []);
    };
    load();
  }, [workspaceId]);

  const successRate = analytics
    ? analytics.runs === 0 ? 0 : Math.round((analytics.successes / analytics.runs) * 100)
    : 0;

  const latestEvaluation = evaluations[0];
  const modelUsage = analytics?.modelUsage ?? {};
  const modelUsageList = useMemo(() => Object.entries(modelUsage).sort((a, b) => b[1] - a[1]), [modelUsage]);
  const modelMax = useMemo(() => Math.max(...modelUsageList.map(([, c]) => c), 1), [modelUsageList]);

  const failureMax = analytics
    ? Math.max(to(analytics.failureTypes?.policy), to(analytics.failureTypes?.audit), to(analytics.failureTypes?.test), to(analytics.failureTypes?.security), 1)
    : 1;

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Metrics</h2>
          <p className="text-sm text-slate-400">Analytics, trends, and performance signals.</p>
        </div>
        {workspaceId && (
          <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] text-slate-500">
            {workspaceId}
          </span>
        )}
      </section>

      {/* Empty states */}
      {!workspaceId && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 text-2xl text-slate-500">◈</div>
          <h3 className="mt-3 text-base font-semibold text-white">No workspace selected</h3>
          <p className="mt-1 text-sm text-slate-400">Select a workspace from the sidebar to view metrics.</p>
        </section>
      )}

      {workspaceId && !analytics && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/20 to-amber-500/5 text-2xl text-amber-400">▤</div>
          <h3 className="mt-3 text-base font-semibold text-white">No analytics yet</h3>
          <p className="mt-1 text-sm text-slate-400">Run a workflow to populate metrics.</p>
        </section>
      )}

      {analytics && (
        <>
          {/* KPI cards */}
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KPICard icon="▶" label="Total Runs" value={String(analytics.runs)} accent="cyan" sub={`${analytics.successes} passed · ${analytics.failures} failed`} />
            <KPICard icon="✓" label="Success Rate" value={`${successRate}%`} accent={successRate >= 80 ? "emerald" : successRate >= 50 ? "amber" : "rose"} bar={successRate} />
            <KPICard icon="$" label="Total Cost" value={`$${to(analytics.totalCost).toFixed(2)}`} accent="violet" sub={`$${to(analytics.costPerFeature).toFixed(2)} per feature`} />
            <KPICard icon="↻" label="Avg Loops" value={to(analytics.loopCounts?.avg).toFixed(1)} accent="sky" sub={`${to(analytics.loopCounts?.total)} total loops`} />
          </section>

          {/* Trend charts */}
          <section className="grid gap-4 lg:grid-cols-2">
            <TrendCard title="Cost Trend" data={(analytics.trends?.cost ?? []).map((d) => to(d?.cost))} color="violet" unit="$" />
            <TrendCard title="Success Rate" data={(analytics.trends?.successRate ?? []).map((d) => to(d?.rate))} color="emerald" unit="%" />
            <TrendCard title="Reward Score" data={(analytics.trends?.reward ?? []).map((d) => to(d?.reward))} color="amber" />
            <TrendCard title="Loop Frequency" data={(analytics.trends?.loops ?? []).map((d) => to(d?.avg))} color="sky" />
          </section>

          {/* Stability row */}
          <section className="grid gap-4 lg:grid-cols-3">
            {/* Test Stability */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Test Stability</div>
                <span className="text-lg font-semibold text-white">{(to(analytics.testStability?.index) * 100).toFixed(0)}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all"
                  style={{ width: `${to(analytics.testStability?.index) * 100}%` }}
                />
              </div>
              <div className="text-[10px] text-slate-500">
                {to(analytics.testStability?.failed)} failed of {to(analytics.testStability?.total)} tests
              </div>
            </div>

            {/* Determinism */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Determinism Score</div>
                <span className="text-lg font-semibold text-white">
                  {latestEvaluation ? `${(latestEvaluation.similarity * 100).toFixed(0)}%` : "n/a"}
                </span>
              </div>
              {latestEvaluation && (
                <>
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-sky-500 to-sky-400 transition-all"
                      style={{ width: `${latestEvaluation.similarity * 100}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {latestEvaluation.runs} runs on <span className="text-slate-400">{latestEvaluation.workflow}</span>
                  </div>
                </>
              )}
            </div>

            {/* Failure Types */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5 space-y-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Failure Breakdown</div>
              <div className="space-y-2">
                {[
                  { label: "Policy", value: to(analytics.failureTypes?.policy), color: "bg-violet-400" },
                  { label: "Audit", value: to(analytics.failureTypes?.audit), color: "bg-amber-400" },
                  { label: "Tests", value: to(analytics.failureTypes?.test), color: "bg-rose-400" },
                  { label: "Security", value: to(analytics.failureTypes?.security), color: "bg-red-400" },
                ].map((f) => (
                  <div key={f.label} className="flex items-center gap-2 text-xs">
                    <span className="w-14 text-slate-500">{f.label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div className={`h-full rounded-full ${f.color} transition-all`} style={{ width: `${(f.value / failureMax) * 100}%` }} />
                    </div>
                    <span className="w-6 text-right text-slate-400">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Model usage + worker stats */}
          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5 space-y-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Model Usage</div>
              {modelUsageList.length === 0 && (
                <div className="text-xs text-slate-500 py-4 text-center">No model data yet.</div>
              )}
              <div className="space-y-2.5">
                {modelUsageList.map(([model, count]) => (
                  <div key={model} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300 font-medium">{model}</span>
                      <span className="text-slate-500">{count} calls</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-cyan-500/80 to-cyan-400/60 transition-all"
                        style={{ width: `${(count / modelMax) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5 space-y-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Worker Utilization</div>
              {analytics.workerStats && analytics.workerStats.length > 0 ? (
                <SparkBars data={analytics.workerStats.map((s) => s.active)} color="cyan" />
              ) : (
                <div className="text-xs text-slate-500 py-4 text-center">No worker stats yet.</div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

/* ============= sub-components ============= */

const ACCENT_MAP: Record<string, { border: string; icon: string; bar: string }> = {
  cyan:    { border: "border-cyan-500/20",    icon: "text-cyan-400 bg-cyan-500/10",    bar: "from-cyan-500 to-cyan-400" },
  emerald: { border: "border-emerald-500/20", icon: "text-emerald-400 bg-emerald-500/10", bar: "from-emerald-500 to-emerald-400" },
  amber:   { border: "border-amber-500/20",   icon: "text-amber-400 bg-amber-500/10",   bar: "from-amber-500 to-amber-400" },
  violet:  { border: "border-violet-500/20",  icon: "text-violet-400 bg-violet-500/10",  bar: "from-violet-500 to-violet-400" },
  sky:     { border: "border-sky-500/20",     icon: "text-sky-400 bg-sky-500/10",     bar: "from-sky-500 to-sky-400" },
  rose:    { border: "border-rose-500/20",    icon: "text-rose-400 bg-rose-500/10",    bar: "from-rose-500 to-rose-400" },
};

function KPICard({ icon, label, value, accent, sub, bar }: {
  icon: string; label: string; value: string; accent: string; sub?: string; bar?: number;
}) {
  const a = ACCENT_MAP[accent] ?? ACCENT_MAP["cyan"]!;
  return (
    <div className={`rounded-2xl border ${a.border} bg-slate-950/40 p-5 space-y-3`}>
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold ${a.icon}`}>{icon}</div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      </div>
      <div className="text-2xl font-semibold text-white">{value}</div>
      {typeof bar === "number" && (
        <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div className={`h-full rounded-full bg-gradient-to-r ${a.bar} transition-all`} style={{ width: `${bar}%` }} />
        </div>
      )}
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

function TrendCard({ title, data, color, unit }: { title: string; data: number[]; color: string; unit?: string }) {
  const a = ACCENT_MAP[color] ?? ACCENT_MAP["cyan"]!;
  const max = Math.max(...data, 1);
  const latest = data.length > 0 ? data[data.length - 1]! : 0;
  return (
    <div className={`rounded-2xl border ${a.border} bg-slate-950/40 p-5 space-y-3`}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{title}</div>
        <span className="text-xs font-medium text-slate-400">{unit === "$" ? `$${latest.toFixed(2)}` : unit === "%" ? `${(latest * 100).toFixed(0)}%` : latest.toFixed(2)}</span>
      </div>
      <SparkBars data={data} color={color} />
    </div>
  );
}

function SparkBars({ data, color = "amber" }: { data: number[]; color?: string }) {
  const max = Math.max(...data, 1);
  const gradientClass = ACCENT_MAP[color]?.bar ?? "from-amber-500 to-amber-400";
  return (
    <div className="flex h-20 items-end gap-[3px]">
      {data.map((value, idx) => (
        <div
          key={`${idx}-${value}`}
          className={`flex-1 min-w-[4px] max-w-3 rounded-t bg-gradient-to-t ${gradientClass} opacity-70 hover:opacity-100 transition-opacity`}
          style={{ height: `${Math.max(6, (value / max) * 100)}%` }}
          title={`${value.toFixed(2)}`}
        />
      ))}
      {data.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-[10px] text-slate-600">No data</div>
      )}
    </div>
  );
}

/* ---------- helpers ---------- */
function to(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeAnalytics(input: any): AnalyticsData {
  return {
    runs: to(input?.runs),
    successes: to(input?.successes),
    failures: to(input?.failures),
    totalCost: to(input?.totalCost),
    costPerFeature: to(input?.costPerFeature),
    perAgent: (input?.perAgent ?? {}) as AnalyticsData["perAgent"],
    loopCounts: { total: to(input?.loopCounts?.total), avg: to(input?.loopCounts?.avg) },
    failureTypes: {
      policy: to(input?.failureTypes?.policy),
      audit: to(input?.failureTypes?.audit),
      test: to(input?.failureTypes?.test),
      security: to(input?.failureTypes?.security),
    },
    trends: {
      cost: Array.isArray(input?.trends?.cost) ? input.trends.cost : [],
      successRate: Array.isArray(input?.trends?.successRate) ? input.trends.successRate : [],
      loops: Array.isArray(input?.trends?.loops) ? input.trends.loops : [],
      reward: Array.isArray(input?.trends?.reward) ? input.trends.reward : [],
    },
    testStability: {
      total: to(input?.testStability?.total),
      failed: to(input?.testStability?.failed),
      index: to(input?.testStability?.index),
    },
    modelUsage: (input?.modelUsage ?? {}) as Record<string, number>,
    workerStats: Array.isArray(input?.workerStats) ? input.workerStats : [],
  };
}
