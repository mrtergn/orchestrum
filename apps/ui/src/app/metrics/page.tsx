"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeliverySummary, LearningEntry, ReleaseReadiness } from "@orchestrum/core";
import { useAppUi } from "@/components/AppUiProvider";
import { toolLabel } from "@/lib/delivery";
import {
  EmptyState,
  MetricStrip,
  NoticePanel,
  PageHeader,
  SegmentedTabs,
  SurfacePanel
} from "@/components/ui/PagePrimitives";

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
};

type MetricsView = "overview" | "inspect";

export default function MetricsPage() {
  const { selectedWorkspaceId: workspaceId } = useAppUi();
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [learnings, setLearnings] = useState<LearningEntry[]>([]);
  const [readiness, setReadiness] = useState<ReleaseReadiness | null>(null);
  const [deliverySummary, setDeliverySummary] = useState<DeliverySummary | null>(null);
  const [view, setView] = useState<MetricsView>("overview");

  useEffect(() => {
    const load = async () => {
      if (!workspaceId) {
        setAnalytics(null);
        return;
      }
      const res = await fetch(`/api/analytics?workspace=${encodeURIComponent(workspaceId)}`);
      if (res.ok) {
        const data = await res.json();
        setAnalytics(normalizeAnalytics(data.analytics ?? data));
      }
    };
    void load();
  }, [workspaceId]);

  useEffect(() => {
    const load = async () => {
      if (!workspaceId) {
        setLearnings([]);
        setReadiness(null);
        setDeliverySummary(null);
        return;
      }
      const [learningsRes, readinessRes, deliverySummaryRes] = await Promise.all([
        fetch(`/api/learnings?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }),
        fetch(`/api/release/readiness?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }),
        fetch(`/api/delivery/summary?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
      ]);
      if (learningsRes.ok) {
        const payload = await learningsRes.json();
        setLearnings(Array.isArray(payload.learnings) ? payload.learnings.slice(0, 6) : []);
      }
      if (readinessRes.ok) {
        setReadiness((await readinessRes.json()) as ReleaseReadiness);
      }
      if (deliverySummaryRes.ok) {
        setDeliverySummary((await deliverySummaryRes.json()) as DeliverySummary);
      }
    };
    void load();
  }, [workspaceId]);

  const successRate = analytics ? (analytics.runs === 0 ? 0 : Math.round((analytics.successes / analytics.runs) * 100)) : 0;
  const modelUsageList = useMemo(() => Object.entries(analytics?.modelUsage ?? {}).sort((a, b) => b[1] - a[1]), [analytics?.modelUsage]);
  const deliveryResolution = useMemo(() => {
    if (!deliverySummary) return null;
    const total = deliverySummary.openFindings + deliverySummary.resolvedFindings;
    if (total <= 0) return null;
    return Math.round((deliverySummary.resolvedFindings / total) * 100);
  }, [deliverySummary]);

  const nextSignal = useMemo(() => {
    if (!workspaceId) return "Select a workspace to see its current signals.";
    if (!analytics) return "Run a mission, work item, or browser pass to populate workspace signals.";
    if ((readiness?.blocking?.length ?? 0) > 0) return "Readiness is blocked. Review the blocking signals before trusting the workspace state.";
    if ((deliverySummary?.openFindings ?? 0) > 0) return "Delivery still has open findings. Review those before treating the workspace as stable.";
    return "Workspace signals look healthy. Use Inspect only if you need historical charts or model breakdowns.";
  }, [analytics, deliverySummary?.openFindings, readiness?.blocking, workspaceId]);

  return (
    <main className="page-shell">
      <PageHeader
        eyebrow="Signals"
        title="Workspace signals, not an analytics wall"
        description="This page is for operator-level signal reading: readiness, learnings, delivery state, and basic run health. Deep charts remain available in Inspect."
        actions={
          <SegmentedTabs
            value={view}
            onChange={setView}
            options={[
              { value: "overview", label: "Overview" },
              { value: "inspect", label: "Inspect" }
            ]}
          />
        }
      />

      {!workspaceId ? (
        <EmptyState
          icon="▤"
          title="No workspace selected"
          description="Select a workspace from the sidebar to read its readiness and runtime signals."
        />
      ) : !analytics ? (
        <EmptyState
          icon="▤"
          title="No signals yet"
          description="Run a mission, delivery session, or browser pass to populate workspace signals."
        />
      ) : (
        <>
          <MetricStrip
            items={[
              { label: "Runs", value: analytics.runs },
              { label: "Success rate", value: `${successRate}%`, accentClassName: successRate >= 80 ? "text-emerald-300" : "text-amber-200" },
              { label: "Readiness", value: `${readiness?.score ?? 0}/100` },
              { label: "Open findings", value: deliverySummary?.openFindings ?? 0, accentClassName: "text-rose-300" }
            ]}
          />

          <NoticePanel tone="info" title="Current read">
            {nextSignal}
          </NoticePanel>

          {view === "overview" ? (
            <section className="page-columns">
              <div className="summary-stack">
                <SurfacePanel
                  title="Operator readiness signal"
                  description="A quick read on whether the workspace is safe to trust right now."
                >
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-base font-semibold text-white">{readiness?.score ?? 0}/100</div>
                        <span className={`rounded-full border px-3 py-1 text-xs ${
                          (readiness?.blocking?.length ?? 0) === 0
                            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                            : "border-amber-400/30 bg-amber-400/10 text-amber-200"
                        }`}>
                          {(readiness?.blocking?.length ?? 0) === 0 ? "No blockers" : "Needs review"}
                        </span>
                      </div>
                      <div className="mt-3 space-y-2">
                        {(readiness?.blocking ?? []).length === 0 ? (
                          <div className="text-sm text-emerald-300">No blocking signals detected.</div>
                        ) : (
                          readiness?.blocking?.map((item) => (
                            <div key={item} className="text-sm text-slate-300">
                              {item}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </SurfacePanel>

                <SurfacePanel
                  title="Recent learnings"
                  description="Short heuristics and observations surfaced from recent workspace activity."
                >
                  {learnings.length === 0 ? (
                    <div className="text-sm text-slate-500">No workspace learnings yet.</div>
                  ) : (
                    <div className="space-y-3">
                      {learnings.map((learning) => (
                        <div key={learning.id} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-300">{learning.category}</div>
                            <div className="text-xs text-slate-500">{Math.round(learning.confidence * 100)}%</div>
                          </div>
                          <div className="mt-2 text-sm text-slate-200">{learning.insight}</div>
                          {learning.relatedFiles.length > 0 ? (
                            <div className="mt-2 text-xs text-slate-500">{learning.relatedFiles.join(", ")}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </SurfacePanel>
              </div>

              <div className="summary-stack">
                <SurfacePanel
                  title="Delivery signal"
                  description="Delivery health matters here only as an operator signal, not as a separate analytics product."
                >
                  {!deliverySummary ? (
                    <div className="text-sm text-slate-500">No delivery data yet.</div>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Active sessions</div>
                            <div className="mt-2 text-lg font-semibold text-cyan-300">{deliverySummary.activeSessions}</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Resolution</div>
                            <div className="mt-2 text-lg font-semibold text-white">
                              {deliveryResolution == null ? "n/a" : `${deliveryResolution}%`}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {Object.entries(deliverySummary.toolUsage)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 4)
                          .map(([tool, count]) => (
                            <div key={tool} className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm">
                              <span className="text-slate-300">{toolLabel(tool)}</span>
                              <span className="text-slate-500">{count} export(s)</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </SurfacePanel>

                <SurfacePanel
                  title="Run health"
                  description="A small execution snapshot. Use Inspect if you need trend lines or model call detail."
                >
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Average loops</div>
                      <div className="mt-2 text-lg font-semibold text-white">{to(analytics.loopCounts?.avg).toFixed(1)}</div>
                    </div>
                    <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Total cost</div>
                      <div className="mt-2 text-lg font-semibold text-white">${to(analytics.totalCost).toFixed(2)}</div>
                    </div>
                  </div>
                </SurfacePanel>
              </div>
            </section>
          ) : (
            <section className="page-columns">
              <div className="summary-stack">
                <SurfacePanel title="Trend charts" description="Historical charts stay behind Inspect so the page remains readable by default.">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <TrendCard title="Cost trend" data={(analytics.trends?.cost ?? []).map((item) => to(item?.cost))} color="violet" unit="$" />
                    <TrendCard title="Success rate" data={(analytics.trends?.successRate ?? []).map((item) => to(item?.rate))} color="emerald" unit="%" />
                    <TrendCard title="Reward score" data={(analytics.trends?.reward ?? []).map((item) => to(item?.reward))} color="amber" />
                    <TrendCard title="Loop frequency" data={(analytics.trends?.loops ?? []).map((item) => to(item?.avg))} color="sky" />
                  </div>
                </SurfacePanel>
              </div>

              <div className="summary-stack">
                <SurfacePanel title="Failure and model breakdown" description="Use this only when you need to explain why the signal changed.">
                  <div className="space-y-3">
                    {[
                      ["Policy", to(analytics.failureTypes?.policy)],
                      ["Audit", to(analytics.failureTypes?.audit)],
                      ["Tests", to(analytics.failureTypes?.test)],
                      ["Security", to(analytics.failureTypes?.security)]
                    ].map(([label, count]) => (
                      <div key={label} className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm">
                        <span className="text-slate-300">{label}</span>
                        <span className="text-slate-500">{count}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 space-y-2">
                    {modelUsageList.length === 0 ? (
                      <div className="text-sm text-slate-500">No model data yet.</div>
                    ) : (
                      modelUsageList.map(([model, count]) => (
                        <div key={model} className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm">
                          <span className="text-slate-300">{model}</span>
                          <span className="text-slate-500">{count} calls</span>
                        </div>
                      ))
                    )}
                  </div>
                </SurfacePanel>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

const ACCENT_MAP: Record<string, { border: string; bar: string }> = {
  cyan: { border: "border-cyan-500/20", bar: "from-cyan-500 to-cyan-400" },
  emerald: { border: "border-emerald-500/20", bar: "from-emerald-500 to-emerald-400" },
  amber: { border: "border-amber-500/20", bar: "from-amber-500 to-amber-400" },
  violet: { border: "border-violet-500/20", bar: "from-violet-500 to-violet-400" },
  sky: { border: "border-sky-500/20", bar: "from-sky-500 to-sky-400" }
};

function TrendCard({ title, data, color, unit }: { title: string; data: number[]; color: string; unit?: string }) {
  const accent = ACCENT_MAP[color] ?? ACCENT_MAP.cyan!;
  const latest = data.length > 0 ? data[data.length - 1] ?? 0 : 0;
  return (
    <div className={`rounded-2xl border ${accent.border} bg-slate-950/40 p-4`}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{title}</div>
        <div className="text-xs text-slate-400">
          {unit === "$" ? `$${latest.toFixed(2)}` : unit === "%" ? `${(latest * 100).toFixed(0)}%` : latest.toFixed(2)}
        </div>
      </div>
      <SparkBars data={data} color={color} />
    </div>
  );
}

function SparkBars({ data, color = "amber" }: { data: number[]; color?: string }) {
  const max = Math.max(...data, 1);
  const gradientClass = ACCENT_MAP[color]?.bar ?? ACCENT_MAP.amber!.bar;
  return (
    <div className="mt-4 flex h-20 items-end gap-[3px]">
      {data.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">No data</div>
      ) : (
        data.map((value, index) => (
          <div
            key={`${index}-${value}`}
            className={`min-w-[4px] flex-1 rounded-t bg-gradient-to-t ${gradientClass} opacity-80`}
            style={{ height: `${Math.max(6, (value / max) * 100)}%` }}
          />
        ))
      )}
    </div>
  );
}

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
      security: to(input?.failureTypes?.security)
    },
    trends: {
      cost: Array.isArray(input?.trends?.cost) ? input.trends.cost : [],
      successRate: Array.isArray(input?.trends?.successRate) ? input.trends.successRate : [],
      loops: Array.isArray(input?.trends?.loops) ? input.trends.loops : [],
      reward: Array.isArray(input?.trends?.reward) ? input.trends.reward : []
    },
    testStability: {
      total: to(input?.testStability?.total),
      failed: to(input?.testStability?.failed),
      index: to(input?.testStability?.index)
    },
    modelUsage: (input?.modelUsage ?? {}) as Record<string, number>
  };
}
