"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";

type Workspace = {
  id: string;
  name?: string;
  path: string;
};

type Template = {
  name: string;
  title: string;
};

const ONBOARDED_KEY = "orchestrum.onboarded";

export function Onboarding() {
  const { setSelectedWorkspaceId, setLastTemplate, setOnboardingSkipped, pushToast } = useAppUi();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [templateName, setTemplateName] = useState("feature-dev.yaml");
  const [helloRunId, setHelloRunId] = useState("");
  const [graphConfirmed, setGraphConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaces, workspaceId]
  );

  useEffect(() => {
    const load = async () => {
      const [workspaceRes, secretsRes, templatesRes] = await Promise.all([
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/secrets", { cache: "no-store" }),
        fetch("/api/templates", { cache: "no-store" })
      ]);
      const workspaceData = workspaceRes.ok ? await workspaceRes.json() : { workspaces: [] };
      const secretsData = secretsRes.ok ? await secretsRes.json() : { keys: {} };
      const templatesData = templatesRes.ok ? await templatesRes.json() : { templates: [] };
      const workspaceList = workspaceData.workspaces ?? [];
      const templateList = (templatesData.templates ?? []).map((template: any) => ({
        name: String(template.name),
        title: String(template.title ?? template.name)
      }));
      setWorkspaces(workspaceList);
      setTemplates(templateList);
      setWorkspaceId(workspaceList[0]?.id ?? "");
      setHasOpenAiKey(Boolean(secretsData.keys?.OPENAI_API_KEY));

      const completed = localStorage.getItem(ONBOARDED_KEY) === "1";
      const skipped = localStorage.getItem("orchestrum.onboarding.skipped") === "1";
      const missingWorkspace = workspaceList.length === 0;
      const missingOpenAi = !Boolean(secretsData.keys?.OPENAI_API_KEY);
      const needsSetup = missingWorkspace || missingOpenAi;

      if (!completed || (needsSetup && !skipped)) {
        setOpen(true);
        if (missingWorkspace) setStep(1);
        else if (missingOpenAi) setStep(2);
        else setStep(3);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!helloRunId || !workspaceId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/runs/${helloRunId}?workspace=${encodeURIComponent(workspaceId)}`, {
        cache: "no-store"
      });
      if (!res.ok) return;
      const data = await res.json();
      if (cancelled) return;
      const hasSteps = Array.isArray(data.steps) && data.steps.length > 0;
      if (hasSteps) {
        setGraphConfirmed(true);
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [helloRunId, workspaceId]);

  if (!open) return null;

  const addWorkspace = async () => {
    setBusy(true);
    setMessage("");
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: workspacePath.trim(),
        name: workspaceName.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to add workspace.");
      return;
    }
    const workspace = payload.workspace;
    if (!workspace?.id) {
      setMessage("Workspace response missing id.");
      return;
    }
    setWorkspaceId(workspace.id);
    setSelectedWorkspaceId(workspace.id);
    setWorkspaces((prev) => {
      const next = [...prev.filter((entry) => entry.id !== workspace.id), workspace];
      return next;
    });
    setStep(hasOpenAiKey ? 3 : 2);
  };

  const saveOpenAiKey = async () => {
    setBusy(true);
    setMessage("");
    const body: Record<string, unknown> = {
      keyName: "OPENAI_API_KEY",
      value: apiKey.trim(),
      scope: "global"
    };
    if (passphrase.trim()) {
      body.passphrase = passphrase.trim();
    }
    const res = await fetch("/api/secrets/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to save API key.");
      return;
    }
    setHasOpenAiKey(true);
    setStep(3);
  };

  const startHelloWorkflow = async () => {
    if (!workspaceId) {
      setMessage("Select or create a workspace first.");
      return;
    }
    setBusy(true);
    setMessage("");
    const res = await fetch("/api/runs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        workflowId: templateName,
        userGoal: "Hello workflow: verify setup and produce a tiny planning output.",
        options: { sandbox: true }
      })
    });
    const payload = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !payload.runId) {
      setMessage(payload.error ?? "Failed to start hello workflow.");
      return;
    }
    setHelloRunId(String(payload.runId));
    setGraphConfirmed(false);
  };

  const completeOnboarding = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    localStorage.removeItem("orchestrum.onboarding.skipped");
    setOnboardingSkipped(false);
    setSelectedWorkspaceId(workspaceId);
    setLastTemplate(templateName);
    pushToast({
      tone: "success",
      title: "Setup complete",
      message: "You can launch runs from Templates or the New Run button."
    });
    setOpen(false);
  };

  const skipOnboarding = () => {
    localStorage.setItem("orchestrum.onboarding.skipped", "1");
    setOnboardingSkipped(true);
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-6">
      <div className="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-950/95 p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-white">Welcome to Orchestrum</h2>
            <p className="mt-1 text-sm text-slate-400">Set up everything from the UI in five steps.</p>
          </div>
          <div className="text-xs text-slate-500">Step {step} / 5</div>
        </div>

        <div className="mt-6 h-2 w-full rounded-full bg-slate-800">
          <div className="h-2 rounded-full bg-amber-400/70" style={{ width: `${(step / 5) * 100}%` }} />
        </div>

        {step === 1 && (
          <div className="mt-6 space-y-4">
            <h3 className="text-lg text-white">Step 1: Add a Workspace</h3>
            <p className="text-sm text-slate-400">Choose a local folder that contains your project repository.</p>
            <input
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
              placeholder="D:\\projects\\my-repo"
              className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            />
            <input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Optional display name"
              className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            />
            <button
              onClick={() => void addWorkspace()}
              disabled={busy || !workspacePath.trim()}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 disabled:opacity-50"
            >
              {busy ? "Adding..." : "Add Workspace"}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="mt-6 space-y-4">
            <h3 className="text-lg text-white">Step 2: Configure AI Provider</h3>
            <p className="text-sm text-slate-400">Set `OPENAI_API_KEY` to enable default workflows.</p>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              placeholder="sk-..."
              className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            />
            <input
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              type="password"
              placeholder="Passphrase (required if keychain is unavailable)"
              className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            />
            <button
              onClick={() => void saveOpenAiKey()}
              disabled={busy || !apiKey.trim()}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save API Key"}
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="mt-6 space-y-4">
            <h3 className="text-lg text-white">Step 3: Pick a Template</h3>
            <p className="text-sm text-slate-400">Feature Dev Loop is preselected and recommended.</p>
            <select
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
            >
              {templates.map((template) => (
                <option key={template.name} value={template.name}>
                  {template.title}
                </option>
              ))}
            </select>
            <button
              onClick={() => setStep(4)}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-amber-200"
            >
              Continue
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="mt-6 space-y-4">
            <h3 className="text-lg text-white">Step 4: Run a Hello Workflow</h3>
            <p className="text-sm text-slate-400">
              Launch a quick test run in <span className="text-slate-200">{selectedWorkspace?.name || workspaceId}</span>.
            </p>
            {!helloRunId && (
              <button
                onClick={() => void startHelloWorkflow()}
                disabled={busy || !workspaceId}
                className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 disabled:opacity-50"
              >
                {busy ? "Starting..." : "Start Hello Workflow"}
              </button>
            )}
            {helloRunId && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-sm text-slate-300">
                <div>Run started: {helloRunId}</div>
                <div className="mt-2">
                  <Link
                    className="text-amber-200 underline decoration-dotted underline-offset-4"
                    href={`/runs/${helloRunId}?workspace=${encodeURIComponent(workspaceId)}`}
                  >
                    Open live run graph
                  </Link>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {graphConfirmed ? "Live graph activity detected." : "Waiting for first workflow steps..."}
                </div>
              </div>
            )}
            <button
              onClick={() => setStep(5)}
              disabled={!graphConfirmed}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        )}

        {step === 5 && (
          <div className="mt-6 space-y-4">
            <h3 className="text-lg text-white">Step 5: You’re Ready</h3>
            <p className="text-sm text-slate-400">
              You can now manage workspaces, templates, and runs entirely from the UI.
            </p>
            <button
              onClick={completeOnboarding}
              className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-emerald-200"
            >
              Finish Setup
            </button>
          </div>
        )}

        {message && <div className="mt-4 text-xs text-rose-300">{message}</div>}

        <div className="mt-8 flex justify-between">
          <button
            onClick={skipOnboarding}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs text-slate-300"
          >
            Skip for now
          </button>
          {step > 1 && step < 5 && (
            <button
              onClick={() => setStep((prev) => Math.max(1, prev - 1))}
              className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs text-slate-300"
            >
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
