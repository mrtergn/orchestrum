"use client";

import { useState } from "react";

export default function LiveSessionDashboardPage() {
  const [runId, setRunId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [decision, setDecision] = useState("approve");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function submitDecision(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/sessions/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, workspaceId: workspaceId || undefined, decision, note })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Request failed");
      setResult("Saved decision.");
      setNote("");
    } catch (err: any) {
      setResult(err?.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-semibold text-white mb-1">Live Session</h1>
      <p className="text-slate-400 mb-6">
        Operator controls for an active session. Persist lightweight decisions alongside the run.
      </p>

      <form onSubmit={submitDecision} className="space-y-4 bg-slate-900/40 border border-slate-800 rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Run ID</label>
            <input
              className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-sm text-white outline-none focus:border-slate-600"
              placeholder="e.g. 2026-04-04-123456"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Workspace ID (optional)</label>
            <input
              className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-sm text-white outline-none focus:border-slate-600"
              placeholder="default"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Decision</label>
            <select
              className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-sm text-white outline-none focus:border-slate-600"
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
            >
              <option value="approve">Approve</option>
              <option value="send_back">Send Back</option>
              <option value="resume">Resume</option>
              <option value="cancel">Cancel</option>
              <option value="note">Note</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Operator Note (optional)</label>
          <textarea
            className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-sm text-white outline-none focus:border-slate-600 resize-y min-h-[84px]"
            placeholder="Add rationale, context, or instructions for the next step."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !runId}
            className="inline-flex items-center px-4 py-2 rounded bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save Decision"}
          </button>
          {result && <span className="text-slate-400 text-sm">{result}</span>}
        </div>
      </form>

      <div className="mt-8 text-slate-500 text-sm">
        Tip: Use Runs to inspect details. This dashboard focuses on quick operator intent capture.
      </div>
    </div>
  );
}

