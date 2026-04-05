"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type StepStatus = "pending" | "in_progress" | "done";
type StepName = "PM" | "Frontend" | "Backend" | "Tester" | "QA" | "Audit";

interface BatonStep {
  name: StepName;
  status: StepStatus;
  updatedAt: string;
}

interface SessionState {
  id: string;
  currentIndex: number;
  steps: BatonStep[];
  validations: { at: string; userAgent: string }[];
  audit?: { at: string; outcome: "approved" | "changes_requested"; notes?: string };
}

export function Timeline({ sessionId = "default" }: { sessionId?: string }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionState | null>(null);
  const [notes, setNotes] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/live-session/state?id=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    const json = await res.json();
    setSession(json.session as SessionState);
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const start = useCallback(async () => {
    await fetch(`/api/live-session/state?id=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start" })
    });
    refresh();
  }, [sessionId, refresh]);

  const advance = useCallback(async () => {
    await fetch(`/api/live-session/state?id=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "advance" })
    });
    refresh();
  }, [sessionId, refresh]);

  const validateBrowser = useCallback(async () => {
    await fetch(`/api/live-session/validate?id=${encodeURIComponent(sessionId)}`, { method: "POST" });
    refresh();
  }, [sessionId, refresh]);

  const auditApprove = useCallback(async () => {
    await fetch(`/api/live-session/audit?id=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "approved", notes })
    });
    setNotes("");
    refresh();
  }, [sessionId, notes, refresh]);

  const auditRequestChanges = useCallback(async () => {
    await fetch(`/api/live-session/audit?id=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "changes_requested", notes })
    });
    setNotes("");
    refresh();
  }, [sessionId, notes, refresh]);

  const currentName = useMemo(() => session?.steps[session.currentIndex]?.name, [session]);
  const currentStep = useMemo(() => (session && session.currentIndex >= 0 ? session.steps[session.currentIndex] : undefined), [session]);
  const lastValidation = useMemo(() => (session && session.validations.length > 0 ? session.validations[session.validations.length - 1] : null), [session]);

  const primaryAction = useMemo(() => {
    if (!session) return { label: "Start", handler: start, enabled: true, tone: "emerald" as const, hint: "Initialize the session and give the baton to the first lane." };
    if (session.currentIndex === -1) return { label: "Start", handler: start, enabled: true, tone: "emerald" as const, hint: "Initialize the session and give the baton to the first lane." };
    if (currentName === "Audit" && !session.audit) return { label: "Approve or Send Back", handler: undefined, enabled: false, tone: "amber" as const, hint: "Use the Audit panel to decide the final outcome." };
    if (currentName === "Tester") return { label: "Record Browser Validation", handler: validateBrowser, enabled: true, tone: "slate" as const, hint: "Capture a lightweight browser validation. Tester stage will auto-advance." };
    return { label: "Pass Baton", handler: advance, enabled: true, tone: "indigo" as const, hint: "Move the baton to the next lane when ready." };
  }, [session, currentName, start, advance, validateBrowser]);

  const toneSolid = (tone: "emerald" | "indigo" | "slate" | "amber") =>
    tone === "emerald"
      ? "bg-emerald-600 hover:bg-emerald-500"
      : tone === "amber"
      ? "bg-amber-500 hover:bg-amber-400 text-slate-950"
      : tone === "indigo"
      ? "bg-indigo-600 hover:bg-indigo-500"
      : "bg-slate-600 hover:bg-slate-500";
  const toneDisabled = (tone: "emerald" | "indigo" | "slate" | "amber") =>
    tone === "emerald"
      ? "bg-emerald-700/60"
      : tone === "amber"
      ? "bg-amber-500/40 text-slate-950"
      : tone === "indigo"
      ? "bg-indigo-700/60"
      : "bg-slate-700/60";

  if (loading) return <div className="text-sm text-zinc-500">Loading live session…</div>;
  if (!session) return <div className="text-red-600">No session state.</div>;

  return (
    <div className="space-y-6">
      {/* Baton owner banner */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Baton Owner</div>
            <div className="mt-0.5 text-2xl font-semibold text-white">
              {currentName ?? "Not started"}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {currentStep ? `Updated ${new Date(currentStep.updatedAt).toLocaleString()}` : "Start to assign the baton."}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {primaryAction.handler ? (
              <button
                onClick={primaryAction.handler}
                className={`px-3 py-1.5 rounded text-white text-sm ${toneSolid(primaryAction.tone)}`}
              >
                {primaryAction.label}
              </button>
            ) : (
              <button
                disabled
                className={`px-3 py-1.5 rounded text-white text-sm ${toneDisabled(primaryAction.tone)} opacity-60`}
                title={primaryAction.hint}
              >
                {primaryAction.label}
              </button>
            )}
            {/* Secondary quick actions */}
            {session.currentIndex >= 0 && currentName !== "Audit" && (
              <button onClick={advance} className="px-3 py-1.5 rounded border border-slate-700 text-sm">
                Pass Baton
              </button>
            )}
            {session.currentIndex >= 0 && (
              <button onClick={validateBrowser} className="px-3 py-1.5 rounded border border-slate-700 text-sm">
                Record Validation
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 text-[12px] text-slate-400">{primaryAction.hint}</div>
      </div>

      <div>
        <h2 className="text-base font-semibold text-slate-200 mb-2">Baton Timeline</h2>
      </div>
      <ol className="flex flex-wrap gap-3">
        {session.steps.map((s, idx) => (
          <li key={s.name} className="flex items-center gap-2">
            <span
              className={
                "inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold " +
                (s.status === "done"
                  ? "bg-emerald-600 text-white"
                  : s.status === "in_progress"
                  ? "bg-amber-500 text-black"
                  : "bg-zinc-200 text-zinc-700")
              }
              title={new Date(s.updatedAt).toLocaleString()}
            >
              {idx + 1}
            </span>
            <span className="text-sm font-medium">{s.name}</span>
            {idx < session.steps.length - 1 && <span className="mx-2 text-zinc-400">→</span>}
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Current truth */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="font-semibold mb-1 text-white">Current Truth</h3>
          <p className="text-[12px] text-slate-400 mb-3">The single source of operator truth for this session.</p>
          {session.audit ? (
            <div className="text-sm">
              <div className="text-slate-300">Audit outcome</div>
              <div className={`mt-0.5 font-semibold ${session.audit.outcome === "approved" ? "text-emerald-500" : "text-amber-400"}`}>{session.audit.outcome}</div>
              <div className="text-xs text-slate-500">{new Date(session.audit.at).toLocaleString()}</div>
              {session.audit.notes && <p className="mt-2 whitespace-pre-wrap text-slate-200">{session.audit.notes}</p>}
            </div>
          ) : lastValidation ? (
            <div className="text-sm">
              <div className="text-slate-300">Last browser validation</div>
              <div className="mt-0.5 font-semibold text-sky-400">{new Date(lastValidation.at).toLocaleString()}</div>
              <div className="text-xs text-slate-500">{lastValidation.userAgent}</div>
              <p className="mt-2 text-[13px] text-slate-300">{currentName === "Tester" ? "Tester owns the baton." : `Baton with ${currentName}.`}</p>
            </div>
          ) : (
            <div className="text-sm">
              <div className="text-slate-300">Stage</div>
              <div className="mt-0.5 font-semibold text-white">{currentName ?? "Not started"}</div>
              {!!currentStep && <div className="text-xs text-slate-500">Updated {new Date(currentStep.updatedAt).toLocaleString()}</div>}
              {!currentStep && <div className="text-xs text-slate-500">Start the session to establish the first truth.</div>}
            </div>
          )}
        </section>

        {/* Operator action */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="font-semibold mb-1 text-white">Operator Action</h3>
          <p className="text-[12px] text-slate-400 mb-3">Take the next deliberate step for this stage.</p>
          <div className="flex flex-wrap items-center gap-2">
            {primaryAction.handler ? (
              <button
                onClick={primaryAction.handler}
                className={`px-3 py-1.5 rounded text-white text-sm ${toneSolid(primaryAction.tone)}`}
              >
                {primaryAction.label}
              </button>
            ) : (
              <button
                disabled
                className={`px-3 py-1.5 rounded text-white text-sm ${toneDisabled(primaryAction.tone)} opacity-60`}
              >
                {primaryAction.label}
              </button>
            )}
            {/* Contextual actions */}
            {currentName === "Audit" ? (
              <>
                <button onClick={auditApprove} disabled={currentName !== "Audit"} className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm disabled:opacity-50">Approve</button>
                <button onClick={auditRequestChanges} disabled={currentName !== "Audit"} className="px-3 py-1.5 rounded bg-amber-600 text-white text-sm disabled:opacity-50">Request Changes</button>
              </>
            ) : (
              <>
                <button onClick={advance} className="px-3 py-1.5 rounded border border-slate-700 text-sm">Pass Baton</button>
                <button onClick={validateBrowser} className="px-3 py-1.5 rounded border border-slate-700 text-sm">Record Validation</button>
              </>
            )}
          </div>
          <div className="mt-2 text-[12px] text-slate-400">{primaryAction.hint}</div>
          {currentName === "Audit" && !session.audit && (
            <div className="mt-3 space-y-2">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Audit notes (optional)"
                className="w-full border border-slate-800 bg-slate-950 rounded p-2 text-sm text-slate-100"
                rows={3}
              />
              <div className="text-[11px] text-slate-500">Notes are saved alongside the decision.</div>
            </div>
          )}
        </section>

        {/* Parallel delivery */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="font-semibold mb-1 text-white">Parallel Lanes</h3>
          <p className="text-[12px] text-slate-400 mb-3">All lanes stay visible, only one owns the baton.</p>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {session.steps.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-2.5 w-2.5 rounded-full ${s.status === "done" ? "bg-emerald-500" : s.status === "in_progress" ? "bg-amber-400" : "bg-slate-600"}`}
                    aria-hidden
                  />
                  <span className="text-sm text-slate-200">{s.name}</span>
                </div>
                <div className="text-[11px] text-slate-400">{new Date(s.updatedAt).toLocaleString()}</div>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <h4 className="text-[12px] font-medium text-slate-300">Recent Validations</h4>
            {session.validations.length === 0 ? (
              <p className="text-[12px] text-slate-500 mt-1">No validations yet.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-[12px] text-slate-400">
                {session.validations.slice().reverse().slice(0, 5).map((v, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span>{new Date(v.at).toLocaleString()}</span>
                    <span className="truncate max-w-[55%] text-slate-500">{v.userAgent}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Timeline;
