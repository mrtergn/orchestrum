"use client";

import { useEffect, useMemo, useReducer } from "react";
import { useRouter } from "next/navigation";
import { useAppUi } from "@/components/AppUiProvider";
import { ModalFrame } from "@/components/ModalFrame";

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
  category?: string;
  defaultGoalHint?: string;
  recommendedRoles?: string[];
  outcomes?: string[];
  nodeCount?: number;
};

type StartResponse = {
  ok: boolean;
  runId: string;
  error?: string;
};

type RunKind = "mission" | "qa" | "benchmark" | "canary";

type RunConfigState = {
  workspaces: Workspace[];
  templates: Template[];
  workspaceId: string;
  runKind: RunKind;
  missionTemplateId: string;
  goal: string;
  baseUrl: string;
  targetPath: string;
  iterations: string;
  intervalMs: string;
  advancedOpen: boolean;
  sandboxEnabled: boolean;
  concurrency: string;
  pmModel: string;
  devModel: string;
  auditModel: string;
  starting: boolean;
  error: string;
};

type RunConfigAction =
  | { type: "seed"; payload: Partial<RunConfigState> }
  | { type: "loaded"; workspaces: Workspace[]; templates: Template[] }
  | { type: "setWorkspaceId"; workspaceId: string }
  | { type: "setRunKind"; runKind: RunKind }
  | { type: "setMissionTemplateId"; missionTemplateId: string }
  | { type: "setGoal"; goal: string }
  | { type: "setBaseUrl"; baseUrl: string }
  | { type: "setTargetPath"; targetPath: string }
  | { type: "setIterations"; iterations: string }
  | { type: "setIntervalMs"; intervalMs: string }
  | { type: "toggleAdvanced" }
  | { type: "setSandboxEnabled"; sandboxEnabled: boolean }
  | { type: "setConcurrency"; concurrency: string }
  | { type: "setPmModel"; pmModel: string }
  | { type: "setDevModel"; devModel: string }
  | { type: "setAuditModel"; auditModel: string }
  | { type: "setStarting"; starting: boolean }
  | { type: "setError"; error: string };

const INITIAL_STATE: RunConfigState = {
  workspaces: [],
  templates: [],
  workspaceId: "",
  runKind: "mission",
  missionTemplateId: "feature-dev",
  goal: "",
  baseUrl: "",
  targetPath: "",
  iterations: "3",
  intervalMs: "3000",
  advancedOpen: false,
  sandboxEnabled: true,
  concurrency: "",
  pmModel: "",
  devModel: "",
  auditModel: "",
  starting: false,
  error: ""
};

function runConfigReducer(state: RunConfigState, action: RunConfigAction): RunConfigState {
  switch (action.type) {
    case "seed":
      return {
        ...state,
        workspaceId: action.payload.workspaceId ?? "",
        runKind: action.payload.runKind ?? "mission",
        missionTemplateId: action.payload.missionTemplateId ?? "feature-dev",
        goal: action.payload.goal ?? "",
        baseUrl: action.payload.baseUrl ?? "",
        targetPath: action.payload.targetPath ?? "",
        iterations: "3",
        intervalMs: "3000",
        advancedOpen: false,
        sandboxEnabled: true,
        concurrency: "",
        pmModel: "",
        devModel: "",
        auditModel: "",
        starting: false,
        error: ""
      };
    case "loaded":
      return {
        ...state,
        workspaces: action.workspaces,
        templates: action.templates
      };
    case "setWorkspaceId":
      return { ...state, workspaceId: action.workspaceId };
    case "setRunKind":
      return { ...state, runKind: action.runKind };
    case "setMissionTemplateId":
      return { ...state, missionTemplateId: action.missionTemplateId };
    case "setGoal":
      return { ...state, goal: action.goal };
    case "setBaseUrl":
      return { ...state, baseUrl: action.baseUrl };
    case "setTargetPath":
      return { ...state, targetPath: action.targetPath };
    case "setIterations":
      return { ...state, iterations: action.iterations };
    case "setIntervalMs":
      return { ...state, intervalMs: action.intervalMs };
    case "toggleAdvanced":
      return { ...state, advancedOpen: !state.advancedOpen };
    case "setSandboxEnabled":
      return { ...state, sandboxEnabled: action.sandboxEnabled };
    case "setConcurrency":
      return { ...state, concurrency: action.concurrency };
    case "setPmModel":
      return { ...state, pmModel: action.pmModel };
    case "setDevModel":
      return { ...state, devModel: action.devModel };
    case "setAuditModel":
      return { ...state, auditModel: action.auditModel };
    case "setStarting":
      return { ...state, starting: action.starting };
    case "setError":
      return { ...state, error: action.error };
    default:
      return state;
  }
}

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

  const [state, dispatch] = useReducer(runConfigReducer, INITIAL_STATE);
  const isMissionRun = state.runKind === "mission";
  const isBrowserRun = state.runKind === "qa" || state.runKind === "benchmark" || state.runKind === "canary";

  useEffect(() => {
    if (!runConfigOpen) return;
    const load = async () => {
      const [workspacesRes, templatesRes] = await Promise.all([
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/templates", { cache: "no-store" })
      ]);
      const workspacesData = workspacesRes.ok ? await workspacesRes.json() : { workspaces: [] };
      const templatesData = templatesRes.ok ? await templatesRes.json() : { templates: [] };
      dispatch({
        type: "loaded",
        workspaces: workspacesData.workspaces ?? [],
        templates: templatesData.templates ?? []
      });
    };
    void load();
  }, [runConfigOpen]);

  useEffect(() => {
    if (!runConfigOpen) return;
    const seedWorkspace = runConfigSeed?.workspaceId ?? selectedWorkspaceId;
    const seedTemplate = runConfigSeed?.missionTemplateId ?? lastTemplate ?? "feature-dev";
    const seedGoal = runConfigSeed?.userGoal ?? "";
    const seedKind = runConfigSeed?.runKind ?? "mission";
    dispatch({
      type: "seed",
      payload: {
        workspaceId: seedWorkspace || "",
        runKind: seedKind,
        missionTemplateId: seedTemplate,
        goal: seedGoal,
        baseUrl: runConfigSeed?.baseUrl ?? "",
        targetPath: runConfigSeed?.targetPath ?? ""
      }
    });
  }, [runConfigOpen, runConfigSeed, selectedWorkspaceId, lastTemplate]);

  const templateOptions = useMemo(() => {
    if (state.templates.length === 0) {
      return [{ name: "feature-dev", title: "Feature Dev Loop", description: "", category: "implementation", nodeCount: 3 }];
    }
    return state.templates;
  }, [state.templates]);
  const selectedTemplate = useMemo(
    () => templateOptions.find((template) => template.name === state.missionTemplateId) ?? templateOptions[0],
    [state.missionTemplateId, templateOptions]
  );

  if (!runConfigOpen) return null;

  const startRun = async () => {
    dispatch({ type: "setError", error: "" });
    if (!state.workspaceId) {
      dispatch({ type: "setError", error: "Select a workspace." });
      return;
    }
    if (isMissionRun && !state.missionTemplateId) {
      dispatch({ type: "setError", error: "Select a mission template." });
      return;
    }
    if (isMissionRun && !state.goal.trim()) {
      dispatch({ type: "setError", error: "Enter a goal." });
      return;
    }
    if (isBrowserRun && !state.baseUrl.trim()) {
      dispatch({ type: "setError", error: "Enter a base URL for browser runs." });
      return;
    }
    const modelOverrides: Record<string, string> = {};
    if (state.pmModel.trim()) modelOverrides.pm = state.pmModel.trim();
    if (state.devModel.trim()) modelOverrides.dev = state.devModel.trim();
    if (state.auditModel.trim()) modelOverrides.audit = state.auditModel.trim();

    const parsedConcurrency = Number(state.concurrency);
    const concurrencyValue = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
      ? Math.max(1, Math.floor(parsedConcurrency))
      : undefined;
    const parsedIterations = Number(state.iterations);
    const parsedIntervalMs = Number(state.intervalMs);
    const endpoint = isMissionRun
      ? "/api/missions/start"
      : state.runKind === "qa"
        ? "/api/qa/run"
        : state.runKind === "benchmark"
          ? "/api/qa/benchmark"
          : "/api/qa/canary";

    dispatch({ type: "setStarting", starting: true });
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: state.workspaceId,
        ...(isMissionRun
          ? {
              missionTemplateId: state.missionTemplateId,
              userGoal: state.goal.trim(),
              options: {
                sandbox: state.sandboxEnabled,
                concurrency: concurrencyValue,
                modelOverrides
              }
            }
          : {
              baseUrl: state.baseUrl.trim(),
              targetPath: state.targetPath.trim() || undefined,
              options: {
                baseUrl: state.baseUrl.trim(),
                targetPath: state.targetPath.trim() || undefined,
                iterations: state.runKind === "canary" && Number.isFinite(parsedIterations) ? parsedIterations : undefined,
                intervalMs: state.runKind === "canary" && Number.isFinite(parsedIntervalMs) ? parsedIntervalMs : undefined
              }
            })
      })
    });

    const payload = (await res.json().catch(() => ({}))) as StartResponse;
    dispatch({ type: "setStarting", starting: false });

    if (!res.ok || !payload.runId) {
      dispatch({ type: "setError", error: payload.error ?? "Failed to start run." });
      return;
    }

    setSelectedWorkspaceId(state.workspaceId);
    if (state.runKind === "mission") {
      setLastTemplate(state.missionTemplateId);
    }
    pushToast({
      tone: "success",
      title: `${state.runKind === "mission" ? "Mission" : state.runKind} started`,
      message: `Run ${payload.runId} started.`,
      actionLabel: "Open Run",
      actionHref: `/runs/${payload.runId}?workspace=${encodeURIComponent(state.workspaceId)}`
    });
    closeRunConfig();
    router.push(`/runs/${payload.runId}?workspace=${encodeURIComponent(state.workspaceId)}`);
  };

  return (
    <ModalFrame
      open={runConfigOpen}
      onClose={closeRunConfig}
      ariaLabel="Run configuration modal"
      overlayClassName="z-50 overflow-y-auto overscroll-contain bg-slate-950/85 p-4 md:p-6"
      containerClassName="items-start py-4 md:py-8"
      panelClassName="my-0 w-full max-w-2xl max-h-[calc(100vh-4rem)] overflow-y-auto p-6"
    >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">New Run</h3>
            <p className="text-xs text-slate-400">Configure and launch a mission from the UI.</p>
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
              value={state.workspaceId}
              onChange={(event) => dispatch({ type: "setWorkspaceId", workspaceId: event.target.value })}
              className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            >
              <option value="">Select workspace</option>
              {state.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name || workspace.id}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-400">Run Kind</label>
            <select
              value={state.runKind}
              onChange={(event) => dispatch({ type: "setRunKind", runKind: event.target.value as RunKind })}
              className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            >
              <option value="mission">Mission</option>
              <option value="qa">Browser QA</option>
              <option value="benchmark">Benchmark</option>
              <option value="canary">Canary</option>
            </select>
          </div>

          {isMissionRun ? (
            <div>
              <label className="text-xs text-slate-400">Mission Template</label>
              <select
                value={state.missionTemplateId}
                onChange={(event) => dispatch({ type: "setMissionTemplateId", missionTemplateId: event.target.value })}
                className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
              >
                {templateOptions.map((template) => (
                  <option key={template.name} value={template.name}>
                    {template.title}
                  </option>
                ))}
              </select>
              {selectedTemplate && (
                <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedTemplate.category && (
                      <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200">
                        {selectedTemplate.category}
                      </span>
                    )}
                    {typeof selectedTemplate.nodeCount === "number" && (
                      <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                        {selectedTemplate.nodeCount} node{selectedTemplate.nodeCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-sm text-slate-200">{selectedTemplate.description}</div>
                  {selectedTemplate.defaultGoalHint && (
                    <div className="mt-2 text-xs text-slate-400">{selectedTemplate.defaultGoalHint}</div>
                  )}
                  {(selectedTemplate.recommendedRoles?.length ?? 0) > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedTemplate.recommendedRoles?.map((role) => (
                        <span key={role} className="rounded-full border border-slate-700 bg-slate-950/50 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                          {role}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : isBrowserRun ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-slate-400">Base URL</label>
                <input
                  value={state.baseUrl}
                  onChange={(event) => dispatch({ type: "setBaseUrl", baseUrl: event.target.value })}
                  placeholder="http://localhost:3000"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400">Path</label>
                <input
                  value={state.targetPath}
                  onChange={(event) => dispatch({ type: "setTargetPath", targetPath: event.target.value })}
                  placeholder="/"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
            </div>
          ) : null}

          {isMissionRun ? (
            <div>
              <label className="text-xs text-slate-400">Goal / Task</label>
              <textarea
                value={state.goal}
                onChange={(event) => dispatch({ type: "setGoal", goal: event.target.value })}
                placeholder={selectedTemplate?.defaultGoalHint ?? "Describe what this mission should accomplish."}
                className="mt-2 h-28 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
              />
              {(selectedTemplate?.outcomes?.length ?? 0) > 0 && (
                <div className="mt-3 space-y-1">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Expected Outcomes</div>
                  <div className="space-y-1 text-xs text-slate-400">
                    {selectedTemplate?.outcomes?.map((item) => <div key={item}>- {item}</div>)}
                  </div>
                </div>
              )}
            </div>
          ) : state.runKind === "canary" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-slate-400">Iterations</label>
                <input
                  type="number"
                  value={state.iterations}
                  onChange={(event) => dispatch({ type: "setIterations", iterations: event.target.value })}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400">Interval (ms)</label>
                <input
                  type="number"
                  value={state.intervalMs}
                  onChange={(event) => dispatch({ type: "setIntervalMs", intervalMs: event.target.value })}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
            </div>
          ) : null}

          {isMissionRun && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/20 p-4">
            <button
              onClick={() => dispatch({ type: "toggleAdvanced" })}
              className="text-xs uppercase tracking-[0.3em] text-slate-400"
            >
              {state.advancedOpen ? "Hide Advanced" : "Advanced Options"}
            </button>
            {state.advancedOpen && (
              <div className="mt-4 grid gap-3">
                <label className="flex items-center gap-3 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={state.sandboxEnabled}
                    onChange={(event) => dispatch({ type: "setSandboxEnabled", sandboxEnabled: event.target.checked })}
                    className="rounded border-slate-700 bg-slate-900"
                  />
                  Enable sandbox
                </label>
                <div>
                  <label className="text-xs text-slate-400">Concurrency</label>
                  <input
                    type="number"
                    value={state.concurrency}
                    onChange={(event) => dispatch({ type: "setConcurrency", concurrency: event.target.value })}
                    placeholder="Use workspace default"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  <input
                    value={state.pmModel}
                    onChange={(event) => dispatch({ type: "setPmModel", pmModel: event.target.value })}
                    placeholder="PM model override"
                    className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                  <input
                    value={state.devModel}
                    onChange={(event) => dispatch({ type: "setDevModel", devModel: event.target.value })}
                    placeholder="DEV model override"
                    className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                  <input
                    value={state.auditModel}
                    onChange={(event) => dispatch({ type: "setAuditModel", auditModel: event.target.value })}
                    placeholder="AUDIT model override"
                    className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  />
                </div>
              </div>
            )}
            </div>
          )}
        </div>

        {state.error && <div className="mt-4 text-xs text-rose-300">{state.error}</div>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={closeRunConfig}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            onClick={startRun}
            disabled={state.starting}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 disabled:opacity-50"
          >
            {state.starting ? "Starting..." : state.runKind === "mission" ? "Start Mission" : `Start ${state.runKind}`}
          </button>
        </div>
    </ModalFrame>
  );
}
