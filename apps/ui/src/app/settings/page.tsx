"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { useAppUi } from "@/components/AppUiProvider";

type CapabilityDiscovery = {
  capabilities?: Array<{
    id: string;
    kind: string;
    label: string;
    available: boolean;
    details?: string;
  }>;
  suggestedBindings?: Array<{
    roleId: string;
    mode: string;
    target: string;
    available: boolean;
    reason: string;
  }>;
  scaffoldPreset?: unknown;
};

type TeamPresetPayload = {
  preset?: unknown | null;
  scaffoldPreset?: unknown;
  capabilities?: CapabilityDiscovery["capabilities"];
  suggestedBindings?: CapabilityDiscovery["suggestedBindings"];
};

const ConfigSchema = z.object({
  concurrency: z
    .object({
      max_agents: z.number().int().min(1)
    })
    .optional(),
  sandbox: z
    .object({
      enabled: z.boolean().optional(),
      image: z.string().optional(),
      network: z.boolean().optional()
    })
    .optional(),
  arbitration: z
    .object({
      mode: z.enum(["vote", "score", "fastest"]).optional(),
      min_models: z.number().int().min(1).optional()
    })
    .optional(),
  models: z.record(z.string()).optional(),
  cluster: z
    .object({
      enabled: z.boolean().optional()
    })
    .optional(),
  shell_allowlist: z.array(z.string()).optional(),
  telemetry: z
    .object({
      enabled: z.boolean().optional(),
      endpoint: z.string().optional()
    })
    .optional()
});

type Scope = "workspace" | "global";
const tabs = ["Providers", "Runtime", "Profile", "Advanced"] as const;
type Tab = (typeof tabs)[number];

export default function SettingsPage() {
  const { selectedWorkspaceId, pushToast } = useAppUi();
  const [scope, setScope] = useState<Scope>("workspace");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [maxAgents, setMaxAgents] = useState<number>(3);
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [sandboxImage, setSandboxImage] = useState("node:20-alpine");
  const [sandboxNetwork, setSandboxNetwork] = useState(false);
  const [arbMode, setArbMode] = useState<"score" | "vote" | "fastest">("score");
  const [arbMin, setArbMin] = useState(2);
  const [clusterEnabled, setClusterEnabled] = useState(false);
  const [modelsText, setModelsText] = useState("{}");
  const [shellAllowlistText, setShellAllowlistText] = useState("");
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [telemetryEndpoint, setTelemetryEndpoint] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [profileRisk, setProfileRisk] = useState("medium");
  const [profileMaxCost, setProfileMaxCost] = useState("");
  const [profileStrategy, setProfileStrategy] = useState("");
  const [profileSandbox, setProfileSandbox] = useState("docker");
  const [profileExecutionMode, setProfileExecutionMode] = useState("inline");
  const [profileBrowserBaseUrl, setProfileBrowserBaseUrl] = useState("");
  const [governanceEnabled, setGovernanceEnabled] = useState(false);
  const [governanceDangerousCommand, setGovernanceDangerousCommand] = useState(true);
  const [governanceConfigProtection, setGovernanceConfigProtection] = useState(true);
  const [governanceQualityGate, setGovernanceQualityGate] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [teamPresetText, setTeamPresetText] = useState("");
  const [teamPresetMessage, setTeamPresetMessage] = useState("");
  const [capabilities, setCapabilities] = useState<NonNullable<CapabilityDiscovery["capabilities"]>>([]);
  const [suggestedBindings, setSuggestedBindings] = useState<NonNullable<CapabilityDiscovery["suggestedBindings"]>>([]);
  const [openAiSet, setOpenAiSet] = useState(false);
  const [openAiKey, setOpenAiKey] = useState("");
  const [providerPassphrase, setProviderPassphrase] = useState("");
  const [providerMessage, setProviderMessage] = useState("");
  const [pmModelDefault, setPmModelDefault] = useState("gpt-5");
  const [devModelDefault, setDevModelDefault] = useState("codex");
  const [auditModelDefault, setAuditModelDefault] = useState("gpt-5");
  const effectiveScope: Scope = scope === "workspace" && !workspaceId ? "global" : scope;

  useEffect(() => {
    setWorkspaceId(selectedWorkspaceId && selectedWorkspaceId !== "undefined" ? selectedWorkspaceId : "");
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const loadProviders = async () => {
      const res = await fetch("/api/secrets", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setOpenAiSet(Boolean(data.keys?.OPENAI_API_KEY));
    };
    void loadProviders();
  }, []);

  useEffect(() => {
    const load = async () => {
      const query =
        effectiveScope === "workspace"
          ? `?scope=workspace&workspace=${encodeURIComponent(workspaceId)}`
          : `?scope=${effectiveScope}`;
      const res = await fetch(`/api/config${query}`);
      if (!res.ok) return;
      const data = await res.json();
      const config = data.config ?? {};
      setMaxAgents(config.concurrency?.max_agents ?? 3);
      setSandboxEnabled(Boolean(config.sandbox?.enabled));
      setSandboxImage(config.sandbox?.image ?? "node:20-alpine");
      setSandboxNetwork(Boolean(config.sandbox?.network));
      setArbMode(config.arbitration?.mode ?? "score");
      setArbMin(config.arbitration?.min_models ?? 2);
      setClusterEnabled(Boolean(config.cluster?.enabled));
      setModelsText(JSON.stringify(config.models ?? {}, null, 2));
      setPmModelDefault(config.models?.pm ?? "gpt-5");
      setDevModelDefault(config.models?.dev ?? "codex");
      setAuditModelDefault(config.models?.audit ?? "gpt-5");
      setShellAllowlistText((config.shell_allowlist ?? []).join("\n"));
      setTelemetryEnabled(Boolean(config.telemetry?.enabled));
      setTelemetryEndpoint(config.telemetry?.endpoint ?? "");
    };
    void load();
  }, [effectiveScope, workspaceId]);

  useEffect(() => {
    if (scope !== "workspace" || !workspaceId) return;
    const loadProfile = async () => {
      const res = await fetch(`/api/profile?workspace=${encodeURIComponent(workspaceId)}`);
      if (!res.ok) return;
      const data = await res.json();
      const profile = data.profile ?? {};
      setProfileRisk(profile.risk_tolerance ?? "medium");
      setProfileMaxCost(profile.max_cost_per_run != null ? String(profile.max_cost_per_run) : "");
      setProfileStrategy(profile.default_strategy ?? "");
      setProfileSandbox(profile.sandbox_mode ?? "docker");
      setProfileExecutionMode(profile.execution_mode ?? "inline");
      setProfileBrowserBaseUrl(profile.browser_base_url ?? "");
      setGovernanceEnabled(Boolean(profile.governance?.enabled));
      setGovernanceDangerousCommand(profile.governance?.dangerous_command_guard ?? true);
      setGovernanceConfigProtection(profile.governance?.config_protection ?? true);
      setGovernanceQualityGate(Boolean(profile.governance?.quality_gate));
    };
    void loadProfile();
  }, [scope, workspaceId]);

  useEffect(() => {
    if (scope !== "workspace" || !workspaceId) {
      setTeamPresetText("");
      setCapabilities([]);
      setSuggestedBindings([]);
      return;
    }
    const loadDeliverySetup = async () => {
      const [presetRes, capabilityRes] = await Promise.all([
        fetch(`/api/team-preset?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }),
        fetch(`/api/capabilities?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
      ]);
      const presetPayload = presetRes.ok ? ((await presetRes.json()) as TeamPresetPayload) : {};
      const capabilityPayload = capabilityRes.ok ? ((await capabilityRes.json()) as CapabilityDiscovery) : {};
      const presetSource = presetPayload.preset ?? presetPayload.scaffoldPreset ?? capabilityPayload.scaffoldPreset ?? {};
      setTeamPresetText(JSON.stringify(presetSource, null, 2));
      setCapabilities(capabilityPayload.capabilities ?? presetPayload.capabilities ?? []);
      setSuggestedBindings(capabilityPayload.suggestedBindings ?? presetPayload.suggestedBindings ?? []);
    };
    void loadDeliverySetup();
  }, [scope, workspaceId]);

  const handleSave = async () => {
    setErrors([]);
    setSaved(false);
    if (scope === "workspace" && !workspaceId) {
      setErrors(["Select a workspace first, or switch to Global scope."]);
      return;
    }
    let models: Record<string, string> | undefined;
    try {
      models = JSON.parse(modelsText || "{}");
    } catch {
      setErrors(["Models JSON is invalid."]);
      return;
    }
    models = {
      ...(models ?? {}),
      pm: pmModelDefault,
      dev: devModelDefault,
      audit: auditModelDefault
    };
    const shell_allowlist = shellAllowlistText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const config = {
      concurrency: { max_agents: maxAgents },
      sandbox: { enabled: sandboxEnabled, image: sandboxImage, network: sandboxNetwork },
      arbitration: { mode: arbMode, min_models: arbMin },
      cluster: { enabled: clusterEnabled },
      models,
      shell_allowlist: shell_allowlist.length > 0 ? shell_allowlist : undefined,
      telemetry: { enabled: telemetryEnabled, endpoint: telemetryEndpoint || undefined }
    };
    const parsed = ConfigSchema.safeParse(config);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => i.message));
      return;
    }
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        workspaceId: scope === "workspace" ? workspaceId : undefined,
        config: parsed.data
      })
    });
    setSaved(true);
  };

  const handleSaveProvider = async () => {
    setProviderMessage("");
    if (!openAiKey.trim()) {
      setProviderMessage("Enter OPENAI_API_KEY.");
      return;
    }
    const res = await fetch("/api/secrets/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyName: "OPENAI_API_KEY",
        value: openAiKey.trim(),
        scope: "global",
        passphrase: providerPassphrase.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setProviderMessage(payload.error ?? "Failed to save API key.");
      return;
    }
    setOpenAiSet(true);
    setOpenAiKey("");
    pushToast({ tone: "success", title: "OPENAI_API_KEY saved" });
  };

  const handleUnsetProvider = async () => {
    setProviderMessage("");
    const res = await fetch("/api/secrets/unset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyName: "OPENAI_API_KEY",
        scope: "global",
        passphrase: providerPassphrase.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setProviderMessage(payload.error ?? "Failed to remove API key.");
      return;
    }
    setOpenAiSet(false);
    pushToast({ tone: "info", title: "OPENAI_API_KEY removed" });
  };

  const handleTestProvider = async () => {
    setProviderMessage("Testing...");
    const res = await fetch("/api/secrets/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        scope: "global",
        passphrase: providerPassphrase.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setProviderMessage(payload.error ?? "Connection test failed.");
      return;
    }
    setProviderMessage(`Connection successful${payload.model ? ` (${payload.model})` : ""}.`);
  };

  const handleSaveProfile = async () => {
    setProfileMessage("");
    if (!workspaceId) {
      setProfileMessage("Select a workspace to save profile.");
      return;
    }
    const maxCost = profileMaxCost ? Number(profileMaxCost) : undefined;
    if (profileMaxCost && Number.isNaN(maxCost)) {
      setProfileMessage("Max cost must be a number.");
      return;
    }
    const profile: any = {
      risk_tolerance: profileRisk,
      sandbox_mode: profileSandbox,
      execution_mode: profileExecutionMode,
      browser_base_url: profileBrowserBaseUrl || undefined,
      default_strategy: profileStrategy || undefined,
      max_cost_per_run: maxCost,
      governance: {
        enabled: governanceEnabled,
        dangerous_command_guard: governanceDangerousCommand,
        config_protection: governanceConfigProtection,
        quality_gate: governanceQualityGate
      }
    };
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, profile })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setProfileMessage(data.error ?? "Failed to save profile.");
      return;
    }
    setProfileMessage("Profile saved.");
  };

  const handleScaffoldPreset = async () => {
    if (!workspaceId) {
      setTeamPresetMessage("Select a workspace first.");
      return;
    }
    const res = await fetch("/api/team-preset/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        force: true
      })
    });
    const payload = (await res.json().catch(() => ({}))) as TeamPresetPayload & { error?: string };
    if (!res.ok) {
      setTeamPresetMessage(payload.error ?? "Unable to scaffold team preset.");
      return;
    }
    setTeamPresetText(JSON.stringify(payload.preset ?? payload.scaffoldPreset ?? {}, null, 2));
    setCapabilities(payload.capabilities ?? []);
    setSuggestedBindings(payload.suggestedBindings ?? []);
    setTeamPresetMessage("Scaffolded team preset created.");
  };

  const handleSaveTeamPreset = async () => {
    setTeamPresetMessage("");
    if (!workspaceId) {
      setTeamPresetMessage("Select a workspace first.");
      return;
    }
    let preset: unknown;
    try {
      preset = JSON.parse(teamPresetText);
    } catch {
      setTeamPresetMessage("Team preset JSON is invalid.");
      return;
    }
    const res = await fetch("/api/team-preset", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        preset
      })
    });
    const payload = (await res.json().catch(() => ({}))) as TeamPresetPayload & { error?: string };
    if (!res.ok) {
      setTeamPresetMessage(payload.error ?? "Failed to save team preset.");
      return;
    }
    setTeamPresetMessage("Team preset saved.");
    setCapabilities(payload.capabilities ?? []);
    setSuggestedBindings(payload.suggestedBindings ?? []);
    setTeamPresetText(JSON.stringify(payload.preset ?? preset, null, 2));
  };

  const [activeTab, setActiveTab] = useState("Providers" as Tab);

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Settings</h2>
          <p className="text-sm text-slate-400">Configure providers, runtime, and workspace profile.</p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-0.5">
          <button
            onClick={() => setScope("workspace")}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${scope === "workspace" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-300"}`}
          >
            Workspace
          </button>
          <button
            onClick={() => setScope("global")}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${scope === "global" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-300"}`}
          >
            Global
          </button>
        </div>
      </section>

      {/* Tab bar */}
      <nav className="flex gap-1 border-b border-slate-800 pb-px">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === tab
                ? "border-b-2 border-amber-400 text-amber-200"
                : "border-b-2 border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {tab}
          </button>
        ))}
      </nav>

      {/* ── Providers Tab ── */}
      {activeTab === "Providers" && (
        <section className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-white">OpenAI</h3>
                <p className="mt-1 text-xs text-slate-500">Store your API key locally. Keys are encrypted at rest.</p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${openAiSet ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>
                {openAiSet ? "Connected" : "Not configured"}
              </span>
            </div>
            <div className="mt-4 space-y-3 max-w-md">
              <input
                value={openAiKey}
                onChange={(event) => setOpenAiKey(event.target.value)}
                type="password"
                placeholder="sk-..."
                className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
              />
              <input
                value={providerPassphrase}
                onChange={(event) => setProviderPassphrase(event.target.value)}
                type="password"
                placeholder="Passphrase for encrypted storage (optional)"
                className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void handleSaveProvider()}
                  className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-amber-200"
                >
                  Save Key
                </button>
                <button
                  onClick={() => void handleTestProvider()}
                  className="rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-sky-200"
                >
                  Test
                </button>
                {openAiSet && (
                  <button
                    onClick={() => void handleUnsetProvider()}
                    className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-rose-200"
                  >
                    Remove
                  </button>
                )}
              </div>
              {providerMessage && <div className="text-xs text-slate-400">{providerMessage}</div>}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Model Defaults</h3>
            <p className="mt-1 text-xs text-slate-500">Default model per agent role. Can be overridden per-agent.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3 max-w-2xl">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">PM</label>
                <select
                  value={pmModelDefault}
                  onChange={(event) => setPmModelDefault(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="gpt-5">gpt-5</option>
                  <option value="gpt-4.1">gpt-4.1</option>
                  <option value="o4-mini">o4-mini</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Developer</label>
                <select
                  value={devModelDefault}
                  onChange={(event) => setDevModelDefault(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="codex">codex</option>
                  <option value="gpt-5">gpt-5</option>
                  <option value="gpt-4.1">gpt-4.1</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Auditor</label>
                <select
                  value={auditModelDefault}
                  onChange={(event) => setAuditModelDefault(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="gpt-5">gpt-5</option>
                  <option value="gpt-4.1">gpt-4.1</option>
                  <option value="o4-mini">o4-mini</option>
                </select>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Runtime Tab ── */}
      {activeTab === "Runtime" && (
        <section className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Concurrency &amp; Execution</h3>
            <p className="mt-1 text-xs text-slate-500">Control how many agents run in parallel and the execution environment.</p>
            <div className="mt-4 grid gap-6 sm:grid-cols-2 max-w-2xl">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Max Concurrent Agents</label>
                <input
                  type="number"
                  value={maxAgents}
                  onChange={(e) => setMaxAgents(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Sandbox Image</label>
                <input
                  value={sandboxImage}
                  onChange={(e) => setSandboxImage(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={sandboxEnabled} onChange={(e) => setSandboxEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                Docker sandbox
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={sandboxNetwork} onChange={(e) => setSandboxNetwork(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                Sandbox network
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={clusterEnabled} onChange={(e) => setClusterEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                Worker cluster
              </label>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Arbitration</h3>
            <p className="mt-1 text-xs text-slate-500">How multi-model decisions are resolved when agents propose competing solutions.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 max-w-md">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Mode</label>
                <select
                  value={arbMode}
                  onChange={(e) => setArbMode(e.target.value as "score" | "vote" | "fastest")}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="score">Score (best quality)</option>
                  <option value="vote">Vote (majority wins)</option>
                  <option value="fastest">Fastest (first response)</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Min Models</label>
                <input
                  type="number"
                  value={arbMin}
                  onChange={(e) => setArbMin(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                />
              </div>
            </div>
          </div>

          {errors.length > 0 && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
              {errors.map((err) => <div key={err}>{err}</div>)}
            </div>
          )}
          {saved && <div className="rounded-lg bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300">Settings saved.</div>}

          <button
            onClick={handleSave}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-amber-200"
          >
            Save Runtime Settings
          </button>
        </section>
      )}

      {/* ── Profile Tab ── */}
      {activeTab === "Profile" && (
        <section className="space-y-6">
          {scope === "workspace" && !workspaceId ? (
            <div className="rounded-2xl border border-dashed border-slate-700 p-8 text-center">
              <div className="text-2xl">◈</div>
              <h3 className="mt-2 text-sm font-semibold text-white">No workspace selected</h3>
              <p className="mt-1 text-xs text-slate-500">Select a workspace from the header to configure its profile, or switch to Global scope.</p>
            </div>
          ) : (
            <>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
              <h3 className="text-sm font-semibold text-white">Workspace Profile</h3>
              <p className="mt-1 text-xs text-slate-500">Per-workspace defaults for risk tolerance, costs, and strategy.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 max-w-lg">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Risk Tolerance</label>
                  <select
                    value={profileRisk}
                    onChange={(e) => setProfileRisk(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  >
                    <option value="low">Low — extra guardrails</option>
                    <option value="medium">Medium — balanced</option>
                    <option value="high">High — autonomy</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Sandbox Mode</label>
                  <select
                    value={profileSandbox}
                    onChange={(e) => setProfileSandbox(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  >
                    <option value="docker">Docker (isolated)</option>
                    <option value="local">Local (no isolation)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Execution Mode</label>
                  <select
                    value={profileExecutionMode}
                    onChange={(e) => setProfileExecutionMode(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                  >
                    <option value="inline">Inline workspace</option>
                    <option value="worktree">Isolated worktree</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Max Cost / Run (USD)</label>
                  <input
                    value={profileMaxCost}
                    onChange={(e) => setProfileMaxCost(e.target.value)}
                    placeholder="1.00"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Default Strategy</label>
                  <input
                    value={profileStrategy}
                    onChange={(e) => setProfileStrategy(e.target.value)}
                    placeholder="balanced"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Browser Base URL</label>
                  <input
                    value={profileBrowserBaseUrl}
                    onChange={(e) => setProfileBrowserBaseUrl(e.target.value)}
                    placeholder="http://localhost:3000"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                  />
                </div>
              </div>
              <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Governance</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceEnabled} onChange={(e) => setGovernanceEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Enable governance layer
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceDangerousCommand} onChange={(e) => setGovernanceDangerousCommand(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Dangerous command guard
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceConfigProtection} onChange={(e) => setGovernanceConfigProtection(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Config protection
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceQualityGate} onChange={(e) => setGovernanceQualityGate(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Quality gate
                  </label>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={handleSaveProfile}
                  className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-200"
                >
                  Save Profile
                </button>
                {profileMessage && <span className="text-xs text-slate-400">{profileMessage}</span>}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-white">Team Preset</h3>
                  <p className="mt-1 text-xs text-slate-500">Repo-scoped role bindings, handoff defaults, and packet templates for delivery sessions.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleScaffoldPreset}
                    className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs uppercase tracking-[0.2em] text-slate-300"
                  >
                    Scaffold
                  </button>
                  <button
                    onClick={handleSaveTeamPreset}
                    className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-emerald-200"
                  >
                    Save Preset
                  </button>
                </div>
              </div>
              <textarea
                value={teamPresetText}
                onChange={(event) => setTeamPresetText(event.target.value)}
                className="mt-4 h-72 w-full rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-3 font-mono text-xs text-slate-200"
              />
              {teamPresetMessage && <div className="mt-3 text-xs text-slate-400">{teamPresetMessage}</div>}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
              <h3 className="text-sm font-semibold text-white">Capabilities & Suggested Bindings</h3>
              <p className="mt-1 text-xs text-slate-500">Machine discovery is suggest-and-confirm. These detections do not change behavior until they are saved into the repo preset.</p>
              <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-2">
                  {(capabilities ?? []).map((capability) => (
                    <div key={capability.id} className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-white">{capability.label}</div>
                        <span className={`text-[10px] uppercase tracking-[0.18em] ${capability.available ? "text-emerald-300" : "text-slate-500"}`}>
                          {capability.available ? "available" : "missing"}
                        </span>
                      </div>
                      {capability.details && <div className="mt-1 text-[11px] text-slate-500">{capability.details}</div>}
                    </div>
                  ))}
                  {(!capabilities || capabilities.length === 0) && <div className="text-xs text-slate-500">No capability data loaded.</div>}
                </div>
                <div className="space-y-2">
                  {(suggestedBindings ?? []).map((binding) => (
                    <div key={binding.roleId} className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-white">{binding.roleId}</div>
                        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{binding.mode}</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{binding.target}</div>
                      <div className="mt-2 text-[11px] text-slate-500">{binding.reason}</div>
                    </div>
                  ))}
                  {(!suggestedBindings || suggestedBindings.length === 0) && <div className="text-xs text-slate-500">No suggested bindings yet.</div>}
                </div>
              </div>
            </div>
            </>
          )}
        </section>
      )}

      {/* ── Advanced Tab ── */}
      {activeTab === "Advanced" && (
        <section className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Model Overrides</h3>
            <p className="mt-1 text-xs text-slate-500">JSON map of model aliases. Merged with defaults.</p>
            <textarea
              value={modelsText}
              onChange={(e) => setModelsText(e.target.value)}
              className="mt-3 h-36 w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 font-mono text-xs text-slate-200"
            />
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Shell Allowlist</h3>
            <p className="mt-1 text-xs text-slate-500">Commands agents are permitted to execute (one per line). Leave empty to allow all.</p>
            <textarea
              value={shellAllowlistText}
              onChange={(e) => setShellAllowlistText(e.target.value)}
              placeholder="npm test&#10;git status&#10;ls"
              className="mt-3 h-28 w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600"
            />
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Telemetry</h3>
            <p className="mt-1 text-xs text-slate-500">Anonymized usage data. Never sends code or secrets.</p>
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={telemetryEnabled} onChange={(e) => setTelemetryEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
              Enable telemetry
            </label>
            {telemetryEnabled && (
              <input
                value={telemetryEndpoint}
                onChange={(e) => setTelemetryEndpoint(e.target.value)}
                placeholder="Custom endpoint (optional)"
                className="mt-2 w-full max-w-md rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
              />
            )}
          </div>

          {errors.length > 0 && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
              {errors.map((err) => <div key={err}>{err}</div>)}
            </div>
          )}
          {saved && <div className="rounded-lg bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300">Settings saved.</div>}

          <button
            onClick={handleSave}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-amber-200"
          >
            Save Advanced Settings
          </button>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">About Orchestrum</h3>
            <p className="mt-2 text-xs text-slate-400">
              Free and open source. No license keys, no tiered restrictions.
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Contributions welcome — see the repository for guidelines.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
