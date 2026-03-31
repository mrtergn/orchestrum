"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import {
  type DeliveryBinding,
  type DeliveryCapability,
  type TeamPresetDraft,
  normalizeTeamPresetDraft,
  serializeTeamPresetDraft,
  targetOptionsForMode,
  toolLabel
} from "@/lib/delivery";

type Workspace = {
  id: string;
  name?: string;
  path: string;
};

type TeamPresetPayload = {
  preset?: unknown | null;
  scaffoldPreset?: unknown;
  suggestedBindings?: DeliveryBinding[];
  capabilities?: DeliveryCapability[];
  error?: string;
};

type CapabilityDiscoveryPayload = {
  capabilities?: DeliveryCapability[];
  suggestedBindings?: DeliveryBinding[];
  scaffoldPreset?: unknown;
};

type DeliverySessionPayload = {
  runId?: string;
  packets?: Array<{ id: string; roleId: string; target: string; mode: string; status: string }>;
  summary?: string;
};

const ONBOARDED_KEY = "orchestrum.onboarded";

export function Onboarding() {
  const router = useRouter();
  const { selectedWorkspaceId, setSelectedWorkspaceId, setOnboardingSkipped, pushToast } = useAppUi();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [capabilities, setCapabilities] = useState<DeliveryCapability[]>([]);
  const [suggestedBindings, setSuggestedBindings] = useState<DeliveryBinding[]>([]);
  const [presetDraft, setPresetDraft] = useState<TeamPresetDraft | null>(null);
  const [goal, setGoal] = useState("Sprint 10");
  const [sprintName, setSprintName] = useState("Sprint 10");
  const [notes, setNotes] = useState("");
  const [selectedPathsText, setSelectedPathsText] = useState("");
  const [createdRunId, setCreatedRunId] = useState("");
  const [createdSession, setCreatedSession] = useState<DeliverySessionPayload | null>(null);

  const stepCount = 6;

  useEffect(() => {
    const load = async () => {
      const [workspaceRes, secretsRes] = await Promise.all([
        fetch("/api/workspaces", { cache: "no-store" }),
        fetch("/api/secrets", { cache: "no-store" })
      ]);
      const workspacePayload = workspaceRes.ok ? await workspaceRes.json() : { workspaces: [] };
      const secretsPayload = secretsRes.ok ? await secretsRes.json() : { keys: {} };
      const workspaceList = Array.isArray(workspacePayload.workspaces) ? workspacePayload.workspaces as Workspace[] : [];
      const defaultWorkspaceId = selectedWorkspaceId || workspaceList[0]?.id || "";
      const done = localStorage.getItem(ONBOARDED_KEY) === "1";
      const skipped = localStorage.getItem("orchestrum.onboarding.skipped") === "1";
      setWorkspaces(workspaceList);
      setWorkspaceId(defaultWorkspaceId);
      setHasOpenAiKey(Boolean(secretsPayload.keys?.OPENAI_API_KEY));
      if (!done && !skipped) {
        setOpen(true);
        if (!defaultWorkspaceId) setStep(1);
        else if (!Boolean(secretsPayload.keys?.OPENAI_API_KEY)) setStep(2);
        else setStep(3);
      }
    };
    void load();
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setCapabilities([]);
      setSuggestedBindings([]);
      setPresetDraft(null);
      return;
    }
    const loadSetup = async () => {
      const [presetRes, capabilityRes] = await Promise.all([
        fetch(`/api/team-preset?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }),
        fetch(`/api/capabilities?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
      ]);
      const presetPayload = presetRes.ok ? (await presetRes.json()) as TeamPresetPayload : {};
      const capabilityPayload = capabilityRes.ok ? (await capabilityRes.json()) as CapabilityDiscoveryPayload : {};
      const nextCapabilities = capabilityPayload.capabilities ?? presetPayload.capabilities ?? [];
      const nextBindings = capabilityPayload.suggestedBindings ?? presetPayload.suggestedBindings ?? [];
      const sourcePreset = presetPayload.preset ?? presetPayload.scaffoldPreset ?? capabilityPayload.scaffoldPreset ?? null;
      setCapabilities(nextCapabilities);
      setSuggestedBindings(nextBindings);
      setPresetDraft(sourcePreset ? normalizeTeamPresetDraft(sourcePreset, nextBindings) : null);
    };
    void loadSetup();
  }, [workspaceId]);

  const firstPacket = useMemo(
    () => createdSession?.packets?.find((packet) => packet.mode !== "auto_cli") ?? createdSession?.packets?.[0] ?? null,
    [createdSession]
  );

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
    setStep(hasOpenAiKey ? 3 : 2);
  };

  const saveProvider = async () => {
    if (!apiKey.trim()) {
      setMessage("Enter OPENAI_API_KEY or continue without a provider.");
      return;
    }
    setBusy("provider");
    setMessage("");
    const res = await fetch("/api/secrets/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyName: "OPENAI_API_KEY",
        value: apiKey.trim(),
        scope: "global",
        passphrase: passphrase.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    setBusy("");
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to save OPENAI_API_KEY.");
      return;
    }
    setHasOpenAiKey(true);
    setApiKey("");
    setStep(3);
  };

  const savePreset = async () => {
    if (!workspaceId || !presetDraft) {
      setMessage("Select a workspace and load the preset first.");
      return false;
    }
    setBusy("preset");
    setMessage("");
    const res = await fetch("/api/team-preset", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        preset: serializeTeamPresetDraft(presetDraft)
      })
    });
    const payload = await res.json().catch(() => ({}));
    setBusy("");
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to save the team preset.");
      return false;
    }
    pushToast({
      tone: "success",
      title: "Team preset saved",
      message: "Repo-scoped roles and targets are ready for delivery sessions."
    });
    return true;
  };

  const createFirstDelivery = async () => {
    if (!workspaceId) {
      setMessage("Select a workspace first.");
      return;
    }
    if (!goal.trim()) {
      setMessage("Enter a sprint or goal name first.");
      return;
    }
    setBusy("delivery");
    setMessage("");
    const res = await fetch("/api/delivery/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        goal: goal.trim(),
        sprintName: sprintName.trim() || undefined,
        notes: notes.trim() || undefined,
        selectedPaths: selectedPathsText
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean)
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.runId) {
      setBusy("");
      setMessage(payload.error ?? "Failed to start the first delivery session.");
      return;
    }
    const runId = String(payload.runId);
    const sessionRes = await fetch(`/api/delivery/${encodeURIComponent(runId)}?workspace=${encodeURIComponent(workspaceId)}`, {
      cache: "no-store"
    });
    const sessionPayload = sessionRes.ok ? (await sessionRes.json()) as DeliverySessionPayload : null;
    setBusy("");
    setCreatedRunId(runId);
    setCreatedSession(sessionPayload);
    setStep(6);
    pushToast({
      tone: "success",
      title: "Delivery session created",
      message: runId
    });
  };

  const complete = (destination?: string) => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    localStorage.removeItem("orchestrum.onboarding.skipped");
    setOnboardingSkipped(false);
    if (workspaceId) {
      setSelectedWorkspaceId(workspaceId);
    }
    setOpen(false);
    if (destination) {
      router.push(destination);
    }
  };

  const skip = () => {
    localStorage.setItem("orchestrum.onboarding.skipped", "1");
    setOnboardingSkipped(true);
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/92 p-6">
      <div className="w-full max-w-5xl rounded-3xl border border-slate-800 bg-slate-950/98 p-8 shadow-2xl shadow-slate-950/40">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-white">Orchestrum Delivery Setup</h2>
            <p className="mt-1 text-sm text-slate-400">
              Set up a workspace, confirm delivery roles, and launch the first work-packet session.
            </p>
          </div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500">
            Step {step} / {stepCount}
          </div>
        </div>

        <div className="mt-6 h-2 rounded-full bg-slate-900">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-cyan-400 via-emerald-400 to-amber-300 transition-all"
            style={{ width: `${(step / stepCount) * 100}%` }}
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
              <div className="mt-1 text-xs text-slate-500">Choose the repo you want Orchestrum to compile into packets.</div>
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
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void addWorkspace()}
                    disabled={busy === "workspace"}
                    className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-amber-200 disabled:opacity-50"
                  >
                    {busy === "workspace" ? "Adding..." : "Add Workspace"}
                  </button>
                  {workspaceId && (
                    <button
                      onClick={() => setStep(2)}
                      className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-200"
                    >
                      Continue
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Provider Check</div>
              <div className="mt-2 text-xs text-slate-500">
                Delivery sessions can work in manual handoff mode without a provider, but model-backed flows need a configured key.
              </div>
              <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${hasOpenAiKey ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200" : "border-amber-400/20 bg-amber-400/10 text-amber-200"}`}>
                {hasOpenAiKey ? "OPENAI_API_KEY is already configured." : "No provider key detected yet."}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Configure OPENAI_API_KEY</div>
              <div className="mt-4 space-y-3">
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  type="password"
                  placeholder="sk-..."
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                />
                <input
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  type="password"
                  placeholder="Passphrase for encrypted storage (optional)"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void saveProvider()}
                    disabled={busy === "provider"}
                    className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-amber-200 disabled:opacity-50"
                  >
                    {busy === "provider" ? "Saving..." : "Save Provider"}
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    className="rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300"
                  >
                    Continue Without Provider
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Capability Discovery</div>
              <div className="mt-1 text-xs text-slate-500">This machine is scanned for repo scripts, shells, IDE entry points, and browser handoff capability.</div>
              <div className="mt-4 grid gap-2">
                {capabilities.map((capability) => (
                  <div key={capability.id} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{capability.label}</div>
                      <span className={`text-[10px] uppercase tracking-[0.18em] ${capability.available ? "text-emerald-300" : "text-slate-500"}`}>
                        {capability.available ? "available" : "missing"}
                      </span>
                    </div>
                    {capability.details && <div className="mt-1 text-[11px] text-slate-500">{capability.details}</div>}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Suggested Role Bindings</div>
              <div className="mt-1 text-xs text-slate-500">These are suggestions only. You will confirm them in the next step.</div>
              <div className="mt-4 space-y-2">
                {suggestedBindings.map((binding) => (
                  <div key={binding.roleId} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{binding.roleId}</div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{binding.mode}</div>
                    </div>
                    <div className="mt-1 text-xs text-slate-300">{toolLabel(binding.target)}</div>
                    {binding.reason && <div className="mt-2 text-[11px] text-slate-500">{binding.reason}</div>}
                  </div>
                ))}
              </div>
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => setStep(4)}
                  disabled={!presetDraft}
                  className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-200 disabled:opacity-50"
                >
                  Confirm Roles
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 4 && presetDraft && (
          <section className="mt-6 space-y-5">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="grid gap-4 lg:grid-cols-[0.7fr_1.3fr]">
                <div>
                  <div className="text-sm font-semibold text-white">Team Preset</div>
                  <div className="mt-1 text-xs text-slate-500">Confirm repo-scoped roles and their primary handoff targets. No JSON editing required here.</div>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Preset Name</label>
                  <input
                    value={presetDraft.name}
                    onChange={(event) => setPresetDraft((prev) => prev ? { ...prev, name: event.target.value } : prev)}
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {presetDraft.roles.map((role) => {
                const options = targetOptionsForMode(role.mode, capabilities);
                return (
                  <div key={role.id} className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">{role.label}</div>
                        <div className="mt-1 text-xs text-slate-500">{role.description || role.id}</div>
                      </div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{role.id}</div>
                    </div>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Mode</label>
                        <select
                          value={role.mode}
                          onChange={(event) => {
                            const nextMode = event.target.value as TeamPresetDraft["roles"][number]["mode"];
                            setPresetDraft((prev) => {
                              if (!prev) return prev;
                              return {
                                ...prev,
                                roles: prev.roles.map((item) => item.id === role.id ? {
                                  ...item,
                                  mode: nextMode,
                                  target: targetOptionsForMode(nextMode, capabilities)[0] ?? item.target
                                } : item)
                              };
                            });
                          }}
                          className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                        >
                          <option value="manual_browser">manual_browser</option>
                          <option value="manual_ide">manual_ide</option>
                          <option value="auto_cli">auto_cli</option>
                          <option value="disabled">disabled</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Primary Target</label>
                        <select
                          value={role.target}
                          onChange={(event) => {
                            const nextTarget = event.target.value;
                            setPresetDraft((prev) => prev ? {
                              ...prev,
                              roles: prev.roles.map((item) => item.id === role.id ? { ...item, target: nextTarget } : item)
                            } : prev);
                          }}
                          className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                        >
                          {options.map((option) => (
                            <option key={option} value={option}>{toolLabel(option)}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap justify-between gap-3">
              <button
                onClick={() => setStep(3)}
                className="rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300"
              >
                Back
              </button>
              <button
                onClick={() => void (async () => {
                  const ok = await savePreset();
                  if (ok) setStep(5);
                })()}
                disabled={busy === "preset"}
                className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-emerald-200 disabled:opacity-50"
              >
                {busy === "preset" ? "Saving..." : "Save and Continue"}
              </button>
            </div>
          </section>
        )}

        {step === 5 && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">First Delivery Session</div>
              <div className="mt-1 text-xs text-slate-500">This creates the first sprint-style session and generates work packets for the confirmed team preset.</div>
              <div className="mt-4 space-y-3">
                <input
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="Sprint 10"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                />
                <input
                  value={sprintName}
                  onChange={(event) => setSprintName(event.target.value)}
                  placeholder="Optional sprint label"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                />
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={5}
                  placeholder="Context, tickets, or repo notes..."
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3 text-sm text-slate-200"
                />
                <textarea
                  value={selectedPathsText}
                  onChange={(event) => setSelectedPathsText(event.target.value)}
                  rows={4}
                  placeholder="src/app/page.tsx&#10;packages/core/src/delivery"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-3 text-sm text-slate-200"
                />
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">What happens next</div>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">1. Orchestrum compiles repo context into role-specific work packets.</div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">2. Manual tools like ChatGPT, Cursor, Codex, Copilot, or Claude receive exported packets.</div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">3. Imported responses turn into findings, remediation tasks, and evidence on the same delivery session.</div>
              </div>
              <div className="mt-5 flex flex-wrap justify-between gap-3">
                <button
                  onClick={() => setStep(4)}
                  className="rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300"
                >
                  Back
                </button>
                <button
                  onClick={() => void createFirstDelivery()}
                  disabled={busy === "delivery"}
                  className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-emerald-200 disabled:opacity-50"
                >
                  {busy === "delivery" ? "Creating..." : "Create First Delivery Session"}
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 6 && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-5">
              <div className="text-sm font-semibold text-emerald-100">Delivery session ready</div>
              <div className="mt-2 text-sm text-emerald-50">{createdRunId || "Your first session is ready."}</div>
              {createdSession?.summary && <div className="mt-2 text-xs text-emerald-100/80">{createdSession.summary}</div>}
              {firstPacket && (
                <div className="mt-4 rounded-xl border border-emerald-300/20 bg-slate-950/30 px-4 py-3 text-sm text-slate-100">
                  First packet: <span className="font-medium">{firstPacket.roleId}</span> via <span className="font-medium">{toolLabel(firstPacket.target)}</span>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
              <div className="text-sm font-semibold text-white">Next actions</div>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">Open the session detail page and export the first packet for its target tool.</div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">Paste the response back into Orchestrum to generate findings and remediation tasks.</div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">Use Delivery as the control center and Metrics/Diagnostics for session health.</div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {createdRunId && (
                  <button
                    onClick={() => complete(`/runs/${encodeURIComponent(createdRunId)}?workspace=${encodeURIComponent(workspaceId)}`)}
                    className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-200"
                  >
                    Open Session
                  </button>
                )}
                <button
                  onClick={() => complete("/delivery")}
                  className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-emerald-200"
                >
                  Open Delivery
                </button>
                <button
                  onClick={() => complete()}
                  className="rounded-lg border border-slate-700 bg-slate-950/70 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300"
                >
                  Finish
                </button>
              </div>
            </div>
          </section>
        )}

        {message && <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">{message}</div>}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={skip}
            className="text-xs uppercase tracking-[0.18em] text-slate-500 hover:text-slate-300"
          >
            Skip for now
          </button>
          <div className="text-xs text-slate-500">
            Workspace: {workspaces.find((workspace) => workspace.id === workspaceId)?.name || workspaceId || "not selected"}
          </div>
        </div>
      </div>
    </div>
  );
}
