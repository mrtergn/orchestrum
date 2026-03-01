"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppUi } from "@/components/AppUiProvider";

type Workspace = {
  id: string;
  path: string;
  name?: string;
};

type Template = {
  name: string;
  title: string;
  description: string;
  source?: string;
};

type StartResponse = {
  ok: boolean;
  runId: string;
  error?: string;
};

export function RunConfigModal() {
  const router = useRouter();
  const {
    runConfigOpen,
    runConfigSeed,
    closeRunConfig,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    lastTemplate,
    setLastTemplate,
    pushToast
  } = useAppUi();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workflowId, setWorkflowId] = useState("feature-dev.yaml");
  const [goal, setGoal] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sandboxEnabled, setSandboxEnabled] = useState(true);
  const [concurrency, setConcurrency] = useState("");
  const [pmModel, setPmModel] = useState("");
  const [devModel, setDevModel] = useState("");
  const [auditModel, setAuditModel] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!runConfigOpen) return;
    const load = async () => {
      const [workspacesRes, templatesRes] = await Promise.all([
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/templates", { cache: "no-store" })
      ]);
      const workspacesData = workspacesRes.ok ? await workspacesRes.json() : { workspaces: [] };
      const templatesData = templatesRes.ok ? await templatesRes.json() : { templates: [] };
      setWorkspaces(workspacesData.workspaces ?? []);
      setTemplates(templatesData.templates ?? []);
    };
    void load();
  }, [runConfigOpen]);

  useEffect(() => {
    if (!runConfigOpen) return;
    const seedWorkspace = runConfigSeed?.workspaceId ?? selectedWorkspaceId;
    const seedWorkflow = runConfigSeed?.workflowId ?? lastTemplate ?? "feature-dev.yaml";
    const seedGoal = runConfigSeed?.userGoal ?? "";
    setWorkspaceId(seedWorkspace || "");
    setWorkflowId(seedWorkflow);
    setGoal(seedGoal);
    setError("");
    setAdvancedOpen(false);
    setSandboxEnabled(true);
    setConcurrency("");
    setPmModel("");
    setDevModel("");
    setAuditModel("");
  }, [runConfigOpen, runConfigSeed, selectedWorkspaceId, lastTemplate]);

  const templateOptions = useMemo(() => {
    if (templates.length === 0) {
      return [{ name: "feature-dev.yaml", title: "Feature Dev Loop", description: "" }];
    }
    return templates;
  }, [templates]);

  if (!runConfigOpen) return null;

  const startRun = async () => {
    setError("");
    if (!workspaceId) {
      setError("Select a workspace.");
      return;
    }
    if (!workflowId) {
      setError("Select a workflow.");
      return;
    }
    const modelOverrides: Record<string, string> = {};
    if (pmModel.trim()) modelOverrides.pm = pmModel.trim();
    if (devModel.trim()) modelOverrides.dev = devModel.trim();
    if (auditModel.trim()) modelOverrides.audit = auditModel.trim();
    const parsedConcurrency = Number(concurrency);
    const concurrencyValue = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
      ? Math.max(1, Math.floor(parsedConcurrency))
      : undefined;
    setStarting(true);
    const res = await fetch("/api/runs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        workflowId,
        userGoal: goal.trim(),
        options: {
          sandbox: sandboxEnabled,
          concurrency: concurrencyValue,
          modelOverrides
        }
      })
    });
    const payload = (await res.json().catch(() => ({}))) as StartResponse;
    setStarting(false);
    if (!res.ok || !payload.runId) {
      setError(payload.error ?? "Failed to start run.");
      return;
    }
    setSelectedWorkspaceId(workspaceId);
    setLastTemplate(workflowId);
    pushToast({
      tone: "success",
      title: "Run started",
      message: `Run ${payload.runId} started.`,
      actionLabel: "Open Run",
      actionHref: `/runs/${payload.runId}?workspace=${encodeURIComponent(workspaceId)}`
    });
    closeRunConfig();
    router.push(`/runs/${payload.runId}?workspace=${encodeURIComponent(workspaceId)}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950/95 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">New Run</h3>
            <p className="text-xs text-slate-400">Configure and launch a workflow from the UI.</p>
          </div>
          <button
            onClick={closeRunConfig}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-300"
          >
            Close
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="text-xs text-slate-400">Workspace</label>
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            >
              <option value="">Select workspace</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name || workspace.id}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">Workflow</label>
            <select
              value={workflowId}
              onChange={(event) => setWorkflowId(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            >
              {templateOptions.map((template) => (
                <option key={template.name} value={template.name}>
                  {template.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">Goal / Task</label>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Describe what this run should accomplish."
              className="mt-2 h-28 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            />
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/20 p-4">
            <button
              onClick={() => setAdvancedOpen((prev) => !prev)}
              className="text-xs uppercase tracking-[0.3em] text-slate-400"
            >
              {advancedOpen ? "Hide Advanced" : "Advanced Options"}
            </button>
            {advancedOpen && (
              <div className="mt-4 grid gap-3">
                <label className="flex items-center gap-3 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={sandboxEnabled}
                    onChange={(event) => setSandboxEnabled(event.target.checked)}
                    className="rounded border-slate-700 bg-slate-900"
                  />
                  Enable sandbox
                </label>
                <div>
                  <label className="text-xs text-slate-400">Concurrency</label>
                  <input
                    type="number"
                    value={concurrency}
                    onChange={(event) => setConcurrency(event.target.value)}
                    placeholder="Use workspace default"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  <input
                    value={pmModel}
                    onChange={(event) => setPmModel(event.target.value)}
                    placeholder="PM model override"
                    className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                  <input
                    value={devModel}
                    onChange={(event) => setDevModel(event.target.value)}
                    placeholder="DEV model override"
                    className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                  <input
                    value={auditModel}
                    onChange={(event) => setAuditModel(event.target.value)}
                    placeholder="AUDIT model override"
                    className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {error && <div className="mt-4 text-xs text-rose-300">{error}</div>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={closeRunConfig}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            onClick={startRun}
            disabled={starting}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 disabled:opacity-50"
          >
            {starting ? "Starting..." : "Start Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
