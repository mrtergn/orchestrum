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

type RunKind = "workflow" | "qa" | "benchmark" | "canary" | "delivery";

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
  const [runKind, setRunKind] = useState<RunKind>("workflow");
  const [workflowId, setWorkflowId] = useState("feature-dev.yaml");
  const [goal, setGoal] = useState("");
  const [sprintName, setSprintName] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedPathsText, setSelectedPathsText] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [iterations, setIterations] = useState("3");
  const [intervalMs, setIntervalMs] = useState("3000");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sandboxEnabled, setSandboxEnabled] = useState(true);
  const [concurrency, setConcurrency] = useState("");
  const [pmModel, setPmModel] = useState("");
  const [devModel, setDevModel] = useState("");
  const [auditModel, setAuditModel] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const isWorkflowRun = runKind === "workflow";
  const isDeliveryRun = runKind === "delivery";
  const isBrowserRun = runKind === "qa" || runKind === "benchmark" || runKind === "canary";

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
    const seedKind = runConfigSeed?.runKind ?? "workflow";
    setWorkspaceId(seedWorkspace || "");
    setRunKind(seedKind);
    setWorkflowId(seedWorkflow);
    setGoal(seedGoal);
    setSprintName(runConfigSeed?.sprintName ?? "");
    setNotes(runConfigSeed?.notes ?? "");
    setSelectedPathsText((runConfigSeed?.selectedPaths ?? []).join("\n"));
    setBaseUrl(runConfigSeed?.baseUrl ?? "");
    setTargetPath(runConfigSeed?.targetPath ?? "");
    setIterations("3");
    setIntervalMs("3000");
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
    if (isWorkflowRun && !workflowId) {
      setError("Select a workflow.");
      return;
    }
    if ((isWorkflowRun || isDeliveryRun) && !goal.trim()) {
      setError("Enter a goal.");
      return;
    }
    if (isBrowserRun && !baseUrl.trim()) {
      setError("Enter a base URL for browser runs.");
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
    const parsedIterations = Number(iterations);
    const parsedIntervalMs = Number(intervalMs);
    const selectedPaths = selectedPathsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const endpoint = isWorkflowRun
      ? "/api/runs/start"
      : isDeliveryRun
        ? "/api/delivery/start"
        : runKind === "qa"
        ? "/api/qa/run"
        : runKind === "benchmark"
          ? "/api/qa/benchmark"
          : "/api/qa/canary";
    setStarting(true);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        ...(isWorkflowRun
          ? {
              workflowId,
              userGoal: goal.trim(),
              options: {
                sandbox: sandboxEnabled,
                concurrency: concurrencyValue,
                modelOverrides
              }
            }
          : isDeliveryRun
            ? {
                goal: goal.trim(),
                sprintName: sprintName.trim() || undefined,
                notes: notes.trim() || undefined,
                selectedPaths
              }
          : {
              baseUrl: baseUrl.trim(),
              targetPath: targetPath.trim() || undefined,
              options: {
                baseUrl: baseUrl.trim(),
                targetPath: targetPath.trim() || undefined,
                iterations: runKind === "canary" && Number.isFinite(parsedIterations) ? parsedIterations : undefined,
                intervalMs: runKind === "canary" && Number.isFinite(parsedIntervalMs) ? parsedIntervalMs : undefined
              }
            })
      })
    });
    const payload = (await res.json().catch(() => ({}))) as StartResponse;
    setStarting(false);
    if (!res.ok || !payload.runId) {
      setError(payload.error ?? "Failed to start run.");
      return;
    }
    setSelectedWorkspaceId(workspaceId);
    if (runKind === "workflow") {
      setLastTemplate(workflowId);
    }
    pushToast({
      tone: "success",
      title: `${runKind === "workflow" ? "Run" : runKind === "delivery" ? "Delivery session" : runKind} started`,
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
            <label className="text-xs text-slate-400">Run Kind</label>
            <select
              value={runKind}
              onChange={(event) => setRunKind(event.target.value as RunKind)}
              className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            >
              <option value="workflow">Workflow</option>
              <option value="delivery">Delivery / Sprint Run</option>
              <option value="qa">Browser QA</option>
              <option value="benchmark">Benchmark</option>
              <option value="canary">Canary</option>
            </select>
          </div>

          {isWorkflowRun ? (
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
          ) : isBrowserRun ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-slate-400">Base URL</label>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://localhost:3000"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400">Path</label>
                <input
                  value={targetPath}
                  onChange={(event) => setTargetPath(event.target.value)}
                  placeholder="/"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
            </div>
          ) : null}

          {isWorkflowRun || isDeliveryRun ? (
            <div>
              <label className="text-xs text-slate-400">{isDeliveryRun ? "Delivery Goal" : "Goal / Task"}</label>
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="Describe what this run should accomplish."
                className="mt-2 h-28 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
              />
            </div>
          ) : runKind === "canary" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-slate-400">Iterations</label>
                <input
                  type="number"
                  value={iterations}
                  onChange={(event) => setIterations(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400">Interval (ms)</label>
                <input
                  type="number"
                  value={intervalMs}
                  onChange={(event) => setIntervalMs(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
            </div>
          ) : null}

          {isDeliveryRun && (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-slate-400">Sprint / Label</label>
                <input
                  value={sprintName}
                  onChange={(event) => setSprintName(event.target.value)}
                  placeholder="Sprint 10"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400">Relevant Paths</label>
                <textarea
                  value={selectedPathsText}
                  onChange={(event) => setSelectedPathsText(event.target.value)}
                  rows={3}
                  placeholder="packages/service/src/server.ts&#10;apps/ui/src/components/RunConfigModal.tsx"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-slate-400">Notes</label>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={4}
                  placeholder="Constraints, open questions, links, or current branch notes."
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
            </div>
          )}

          {isWorkflowRun && (
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
          )}
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
            {starting ? "Starting..." : runKind === "workflow" ? "Start Run" : runKind === "delivery" ? "Start Delivery" : `Start ${runKind}`}
          </button>
        </div>
      </div>
    </div>
  );
}
