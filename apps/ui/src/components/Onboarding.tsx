"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { ProviderDiscoveryGrid } from "@/components/providers/ProviderDiscoveryGrid";
import { ProviderDiscoveryLoadingState } from "@/components/providers/ProviderDiscoveryLoadingState";
import { ProviderDiscoveryStatusSummary } from "@/components/providers/ProviderDiscoveryStatusSummary";
import { preferredTransport, vendorLabel } from "@/lib/providers";
import { useProviderDiscovery } from "@/lib/queries/useProviderDiscovery";

type Workspace = {
  id: string;
  name?: string;
  path: string;
};

type AgentPayload = {
  agents?: Array<{ id: string }>;
};

const ONBOARDED_KEY = "orchestrum.onboarded";

type OnboardingProps = {
  onVisibilityChange?: (open: boolean) => void;
};

export function Onboarding({ onVisibilityChange }: OnboardingProps) {
  const router = useRouter();
  const { selectedWorkspaceId, setSelectedWorkspaceId, setOnboardingSkipped, pushToast, openRunConfig } = useAppUi();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [provider, setProvider] = useState<"openai" | "claude">("openai");
  const [apiKey, setApiKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [hasClaudeKey, setHasClaudeKey] = useState(false);
  const [agentCount, setAgentCount] = useState(0);
  const [showApiFallbacks, setShowApiFallbacks] = useState(false);
  const {
    providers: providerDiscovery,
    isLoading: providerDiscoveryLoading,
    error: providerDiscoveryError
  } = useProviderDiscovery({
    scope: "global",
    enabled: open && step >= 2
  });

  useEffect(() => {
    const done = localStorage.getItem(ONBOARDED_KEY) === "1";
    const skipped = localStorage.getItem("orchestrum.onboarding.skipped") === "1";
    if (!done && !skipped) {
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    const loadBootstrap = async () => {
      const [workspaceRes, secretsRes] = await Promise.all([
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/secrets", { cache: "no-store" })
      ]);
      const workspacePayload = workspaceRes.ok ? await workspaceRes.json() : { workspaces: [] };
      const secretsPayload = secretsRes.ok ? await secretsRes.json() : { keys: {} };
      const workspaceList = Array.isArray(workspacePayload.workspaces) ? workspacePayload.workspaces as Workspace[] : [];
      const defaultWorkspaceId = selectedWorkspaceId || workspaceList[0]?.id || "";
      setWorkspaces(workspaceList);
      setWorkspaceId(defaultWorkspaceId);
      setHasOpenAiKey(Boolean(secretsPayload.keys?.OPENAI_API_KEY));
      setHasClaudeKey(Boolean(secretsPayload.keys?.ANTHROPIC_API_KEY));
      if (defaultWorkspaceId) {
        setStep((current) => Math.max(current, 2));
      }
    };
    void loadBootstrap();
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setAgentCount(0);
      return;
    }
    const loadAgents = async () => {
      const res = await fetch(`/api/agents?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
      const payload = res.ok ? ((await res.json()) as AgentPayload) : { agents: [] };
      setAgentCount(Array.isArray(payload.agents) ? payload.agents.length : 0);
    };
    void loadAgents();
  }, [workspaceId]);

  useEffect(() => {
    onVisibilityChange?.(open);
  }, [open, onVisibilityChange]);

  useEffect(() => {
    setShowApiFallbacks(false);
  }, [step, open]);

  const addWorkspace = async () => {
    if (!workspacePath.trim()) {
      setMessage("Select a local repo path first.");
      return;
    }
    setBusy("workspace");
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
    setBusy("");
    if (!res.ok || !payload.workspace?.id) {
      setMessage(payload.error ?? "Failed to add workspace.");
      return;
    }
    const nextWorkspace = payload.workspace as Workspace;
    setWorkspaces((prev) => [...prev.filter((item) => item.id !== nextWorkspace.id), nextWorkspace]);
    setWorkspaceId(nextWorkspace.id);
    setSelectedWorkspaceId(nextWorkspace.id);
    setStep(2);
  };

  const saveProvider = async () => {
    const keyName = provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    if (!apiKey.trim()) {
      setMessage(`Enter ${keyName} or continue without a provider.`);
      return;
    }
    setBusy("provider");
    setMessage("");
    const res = await fetch("/api/secrets/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyName,
        value: apiKey.trim(),
        scope: "global",
        passphrase: passphrase.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    setBusy("");
    if (!res.ok) {
      setMessage(payload.error ?? `Failed to save ${keyName}.`);
      return;
    }
    if (provider === "claude") setHasClaudeKey(true);
    else setHasOpenAiKey(true);
    setApiKey("");
    setStep(3);
  };

  const complete = (destination?: string) => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    localStorage.removeItem("orchestrum.onboarding.skipped");
    setOnboardingSkipped(false);
    if (workspaceId) setSelectedWorkspaceId(workspaceId);
    setOpen(false);
    if (destination) router.push(destination);
  };

  const skip = () => {
    localStorage.setItem("orchestrum.onboarding.skipped", "1");
    setOnboardingSkipped(true);
    setOpen(false);
  };

  if (!open) return null;

  return (
    <section className="animate-fade-in rounded-3xl border border-slate-800/80 bg-slate-950/80 p-6 shadow-2xl shadow-slate-950/30 backdrop-blur-xl lg:p-8">
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-white">Orchestrum Mission Setup</h2>
            <p className="mt-1 text-sm text-slate-400">Set up a workspace, verify your CLI or API path, and move into workspace-scoped mission execution.</p>
          </div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Step {step} / 3</div>
        </div>

        <div className="mt-6 h-2 rounded-full bg-slate-900">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-cyan-400 via-emerald-400 to-amber-300 transition-all"
            style={{ width: `${(step / 3) * 100}%` }}
          />
        </div>

        {step === 1 && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Existing Workspaces</div>
              <div className="mt-3 space-y-2">
                {workspaces.length === 0 && <div className="text-xs text-slate-500">No workspaces added yet.</div>}
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    onClick={() => {
                      setWorkspaceId(workspace.id);
                      setSelectedWorkspaceId(workspace.id);
                      setStep(2);
                    }}
                    className={`w-full rounded-xl border px-4 py-3 text-left ${
                      workspace.id === workspaceId ? "border-cyan-400/30 bg-cyan-400/10" : "border-slate-800 bg-slate-950/60"
                    }`}
                  >
                    <div className="text-sm font-medium text-white">{workspace.name || workspace.id}</div>
                    <div className="mt-1 text-[11px] text-slate-500">{workspace.path}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Add Workspace</div>
              <div className="mt-1 text-xs text-slate-500">Choose the repository that will hold agents, org metadata, and mission runs.</div>
              <div className="mt-4 space-y-3">
                <input
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  placeholder="/path/to/your/repo"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                />
                <input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="Optional display name"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                />
                <button
                  onClick={() => void addWorkspace()}
                  disabled={busy === "workspace"}
                  className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-amber-200 disabled:opacity-50"
                >
                  {busy === "workspace" ? "Adding..." : "Add Workspace"}
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">CLI-First Provider Status</div>
              <div className="mt-1 text-xs text-slate-500">We detect local sessions first. API keys stay optional and hidden until you open them.</div>
              <div className="mt-4">
                {providerDiscoveryLoading ? (
                  <ProviderDiscoveryLoadingState variant="compact" />
                ) : providerDiscoveryError ? (
                  <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-xs text-rose-100">
                    <div className="font-medium">Local discovery could not finish.</div>
                    <div className="mt-1 text-rose-100/80">{providerDiscoveryError}</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <ProviderDiscoveryStatusSummary providers={providerDiscovery} variant="compact" />
                    <ProviderDiscoveryGrid providers={providerDiscovery} variant="compact" />
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Optional API Fallback</div>
              <div className="mt-1 text-xs text-slate-500">Only open this if you want direct API transport or a fallback when local CLI auth is missing.</div>
              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => setShowApiFallbacks((current) => !current)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white">API fallback settings</div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      OpenAI {hasOpenAiKey ? "configured" : "optional"} · Claude {hasClaudeKey ? "configured" : "optional"}
                    </div>
                  </div>
                  <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                    {showApiFallbacks ? "Hide" : "Show"}
                  </span>
                </button>

                {showApiFallbacks && (
                  <div className="space-y-3 border-t border-slate-800 px-4 py-4">
                    <select
                      value={provider}
                      onChange={(event) => setProvider(event.target.value as "openai" | "claude")}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="claude">Claude</option>
                    </select>
                    <input
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      type="password"
                      placeholder={provider === "claude" ? "sk-ant-..." : "sk-..."}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                    />
                    <input
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      type="password"
                      placeholder="Passphrase for encrypted storage (optional)"
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => void saveProvider()}
                      disabled={busy === "provider"}
                      className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-amber-200 disabled:opacity-50"
                    >
                      {busy === "provider" ? "Saving..." : "Save Fallback"}
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300"
                >
                  Continue
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Workspace Ready</div>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                  Workspace: <span className="text-white">{workspaceId || "not selected"}</span>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                  Agents: <span className="text-white">{agentCount}</span>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                  Providers: <span className="text-white">{
                    [
                      ...providerDiscovery
                        .map((record) => preferredTransport(record)?.configured ? vendorLabel(record.vendor) : null)
                        .filter(Boolean),
                      hasOpenAiKey ? "OpenAI API" : null,
                      hasClaudeKey ? "Claude API" : null
                    ].filter(Boolean).join(", ") || "manual/local only"
                  }</span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Next Steps</div>
              <div className="mt-4 space-y-3">
                <button
                  onClick={() => complete("/agents")}
                  className="w-full rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-left"
                >
                  <div className="text-sm font-medium text-white">Configure workspace agents</div>
                  <div className="mt-1 text-xs text-slate-400">Create PM, dev, audit, and optional security roles under workspace-scoped metadata.</div>
                </button>
                <button
                  onClick={() => complete("/templates")}
                  className="w-full rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-left"
                >
                  <div className="text-sm font-medium text-white">Browse mission templates</div>
                  <div className="mt-1 text-xs text-slate-400">Start from `feature-dev`, `delivery-sprint`, or another built-in mission graph.</div>
                </button>
                <button
                  onClick={() => {
                    complete();
                    openRunConfig({ workspaceId, missionTemplateId: "feature-dev", runKind: "mission" });
                  }}
                  disabled={agentCount === 0}
                  className="w-full rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-left disabled:opacity-50"
                >
                  <div className="text-sm font-medium text-white">Launch first mission</div>
                  <div className="mt-1 text-xs text-slate-400">Requires at least one configured workspace agent.</div>
                </button>
              </div>
            </div>
          </section>
        )}

        {message && <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">{message}</div>}

        <div className="mt-8 flex items-center justify-between">
          <button
            onClick={skip}
            className="text-xs uppercase tracking-[0.18em] text-slate-500 hover:text-slate-300"
          >
            Skip for now
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep((prev) => Math.max(1, prev - 1))}
                className="rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300"
              >
                Back
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
