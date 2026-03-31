"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { useAppUi } from "@/components/AppUiProvider";
import { ProviderDiscoveryGrid } from "@/components/providers/ProviderDiscoveryGrid";
import { ProviderDiscoveryLoadingState } from "@/components/providers/ProviderDiscoveryLoadingState";
import { ProviderDiscoveryStatusSummary } from "@/components/providers/ProviderDiscoveryStatusSummary";
import {
  type DeliveryBinding,
  type DeliveryCapability,
  type TeamPresetDraft,
  normalizeTeamPresetDraft,
  serializeTeamPresetDraft,
  targetOptionsForMode,
  toolLabel
} from "@/lib/delivery";
import { useProviderDiscovery } from "@/lib/queries/useProviderDiscovery";

type CapabilityDiscovery = {
  capabilities?: DeliveryCapability[];
  suggestedBindings?: DeliveryBinding[];
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

const PM_MODEL_OPTIONS = [
  { value: "gpt-5", label: "GPT-5", hint: "broader planning and reasoning" },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "balanced fallback" },
  { value: "o4-mini", label: "o4-mini", hint: "lighter and cheaper" }
] as const;

const DEV_MODEL_OPTIONS = [
  { value: "codex", label: "Codex", hint: "code-focused default" },
  { value: "gpt-5", label: "GPT-5", hint: "general implementation fallback" },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "balanced fallback" }
] as const;

const AUDIT_MODEL_OPTIONS = [
  { value: "gpt-5", label: "GPT-5", hint: "review and risk analysis" },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "balanced fallback" },
  { value: "o4-mini", label: "o4-mini", hint: "lighter verification passes" }
] as const;

function deliveryRunModeLabel(value: string) {
  if (value === "manual_supervised") return "Manual and supervised";
  return "Mostly automatic with supervision";
}

function deliveryRunModeHint(value: string) {
  if (value === "manual_supervised") return "Humans stay in the loop for most delivery steps.";
  return "Orchestrum automates more of the flow and asks for help only when needed.";
}

function deliveryRoleModeLabel(value: string) {
  if (value === "manual_browser") return "Manual in browser";
  if (value === "manual_ide") return "Manual in IDE";
  if (value === "auto_cli") return "Automatic in CLI";
  return "Disabled";
}

function deliveryRoleModeHint(value: string) {
  if (value === "manual_browser") return "A human handles this role in a browser tool such as ChatGPT.";
  if (value === "manual_ide") return "A human handles this role in an IDE such as Cursor.";
  if (value === "auto_cli") return "Orchestrum can execute this role directly through a CLI tool.";
  return "This role will not participate in the preset.";
}

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
  const [teamPresetDraft, setTeamPresetDraft] = useState<TeamPresetDraft | null>(null);
  const [teamPresetEditor, setTeamPresetEditor] = useState<"confirm" | "raw">("confirm");
  const [teamPresetMessage, setTeamPresetMessage] = useState("");
  const [capabilities, setCapabilities] = useState<DeliveryCapability[]>([]);
  const [suggestedBindings, setSuggestedBindings] = useState<DeliveryBinding[]>([]);
  const [openAiSet, setOpenAiSet] = useState(false);
  const [claudeSet, setClaudeSet] = useState(false);
  const [openAiKey, setOpenAiKey] = useState("");
  const [claudeKey, setClaudeKey] = useState("");
  const [providerPassphrase, setProviderPassphrase] = useState("");
  const [providerMessage, setProviderMessage] = useState("");
  const [showApiFallbacks, setShowApiFallbacks] = useState(false);
  const [pmModelDefault, setPmModelDefault] = useState("gpt-5");
  const [devModelDefault, setDevModelDefault] = useState("codex");
  const [auditModelDefault, setAuditModelDefault] = useState("gpt-5");
  const effectiveScope: Scope = scope === "workspace" && !workspaceId ? "global" : scope;
  const [activeTab, setActiveTab] = useState("Providers" as Tab);
  const {
    providers: providerDiscovery,
    isLoading: providerDiscoveryLoading,
    error: providerDiscoveryError
  } = useProviderDiscovery({
    scope: effectiveScope,
    workspaceId,
    enabled: activeTab === "Providers"
  });

  useEffect(() => {
    setWorkspaceId(selectedWorkspaceId && selectedWorkspaceId !== "undefined" ? selectedWorkspaceId : "");
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (activeTab !== "Providers") return;
    let cancelled = false;

    const loadSecrets = async () => {
      const secretRes = await fetch("/api/secrets", { cache: "no-store" });
      if (!secretRes.ok || cancelled) return;
      const data = await secretRes.json();
      if (cancelled) return;
      setOpenAiSet(Boolean(data.keys?.OPENAI_API_KEY));
      setClaudeSet(Boolean(data.keys?.ANTHROPIC_API_KEY));
    };

    void loadSecrets();

    return () => {
      cancelled = true;
    };
  }, [activeTab, effectiveScope, workspaceId]);

  useEffect(() => {
    setShowApiFallbacks(false);
  }, [effectiveScope, workspaceId]);

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
      const nextBindings = capabilityPayload.suggestedBindings ?? presetPayload.suggestedBindings ?? [];
      setSuggestedBindings(nextBindings);
      setTeamPresetDraft(normalizeTeamPresetDraft(presetSource, nextBindings));
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

  const handleSaveProvider = async (provider: "openai" | "claude") => {
    setProviderMessage("");
    const keyName = provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const value = provider === "claude" ? claudeKey.trim() : openAiKey.trim();
    if (!value) {
      setProviderMessage(`Enter ${keyName}.`);
      return;
    }
    const res = await fetch("/api/secrets/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyName,
        value,
        scope: "global",
        passphrase: providerPassphrase.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setProviderMessage(payload.error ?? "Failed to save API key.");
      return;
    }
    if (provider === "claude") {
      setClaudeSet(true);
      setClaudeKey("");
    } else {
      setOpenAiSet(true);
      setOpenAiKey("");
    }
    pushToast({ tone: "success", title: `${keyName} saved` });
  };

  const handleUnsetProvider = async (provider: "openai" | "claude") => {
    setProviderMessage("");
    const keyName = provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const res = await fetch("/api/secrets/unset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyName,
        scope: "global",
        passphrase: providerPassphrase.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setProviderMessage(payload.error ?? "Failed to remove API key.");
      return;
    }
    if (provider === "claude") {
      setClaudeSet(false);
    } else {
      setOpenAiSet(false);
    }
    pushToast({ tone: "info", title: `${keyName} removed` });
  };

  const handleTestProvider = async (provider: "openai" | "claude") => {
    setProviderMessage("Testing...");
    const res = await fetch("/api/secrets/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
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
    const nextPreset = payload.preset ?? payload.scaffoldPreset ?? {};
    const nextBindings = payload.suggestedBindings ?? [];
    setTeamPresetText(JSON.stringify(nextPreset, null, 2));
    setCapabilities(payload.capabilities ?? []);
    setSuggestedBindings(nextBindings);
    setTeamPresetDraft(normalizeTeamPresetDraft(nextPreset, nextBindings));
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
    await handleSaveTeamPresetPayload(preset);
  };

  const handleSaveTeamPresetFromForm = async () => {
    if (!teamPresetDraft) {
      setTeamPresetMessage("No preset draft loaded.");
      return;
    }
    setTeamPresetText(JSON.stringify(serializeTeamPresetDraft(teamPresetDraft), null, 2));
    setTeamPresetEditor("confirm");
    await handleSaveTeamPresetPayload(serializeTeamPresetDraft(teamPresetDraft));
  };

  const handleSaveTeamPresetPayload = async (preset: unknown) => {
    setTeamPresetMessage("");
    if (!workspaceId) {
      setTeamPresetMessage("Select a workspace first.");
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
    const nextBindings = payload.suggestedBindings ?? [];
    const nextPreset = payload.preset ?? preset;
    setSuggestedBindings(nextBindings);
    setTeamPresetText(JSON.stringify(nextPreset, null, 2));
    setTeamPresetDraft(normalizeTeamPresetDraft(nextPreset, nextBindings));
  };

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
          <div>
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Local Provider Session Detection</h3>
                <p className="mt-1 text-xs text-slate-500">CLI and local transports are the primary path. API fallbacks remain optional and stay tucked away until you need them.</p>
              </div>
              {providerDiscoveryLoading && (
                <span className="rounded-full border border-slate-800 bg-slate-900/50 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                  scanning machine
                </span>
              )}
            </div>

            {providerDiscoveryLoading ? (
              <ProviderDiscoveryLoadingState variant="full" />
            ) : providerDiscoveryError ? (
              <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5">
                <div className="text-sm font-semibold text-rose-100">Provider discovery failed</div>
                <div className="mt-1 text-xs text-rose-200/80">
                  Unable to inspect local CLI and transport state right now. API fallbacks are still available below.
                </div>
                <div className="mt-3 rounded-xl border border-rose-400/20 bg-slate-950/40 px-3 py-2 text-xs text-rose-100">
                  {providerDiscoveryError}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <ProviderDiscoveryStatusSummary providers={providerDiscovery} variant="full" />
                <ProviderDiscoveryGrid providers={providerDiscovery} variant="full" />
              </div>
            )}
          </div>

          {!providerDiscoveryLoading && (
            <>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/35">
                <button
                  type="button"
                  onClick={() => setShowApiFallbacks((current) => !current)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                >
                  <div>
                    <h3 className="text-sm font-semibold text-white">API Fallbacks</h3>
                    <p className="mt-1 text-xs text-slate-500">Only configure these if you want direct API transport or a fallback when local auth is missing.</p>
                  </div>
                  <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                    {showApiFallbacks ? "Hide" : "Show"}
                  </span>
                </button>

                {showApiFallbacks && (
                  <div className="border-t border-slate-800 px-5 py-5">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <h3 className="text-sm font-semibold text-white">OpenAI</h3>
                            <p className="mt-1 text-xs text-slate-500">Optional API fallback. Keys are only required for API transport.</p>
                          </div>
                          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${openAiSet ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>
                            {openAiSet ? "Connected" : "Not configured"}
                          </span>
                        </div>
                        <div className="mt-4 space-y-3">
                          <input
                            value={openAiKey}
                            onChange={(event) => setOpenAiKey(event.target.value)}
                            type="password"
                            placeholder="sk-..."
                            className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveProvider("openai")}
                              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-amber-200"
                            >
                              Save Key
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleTestProvider("openai")}
                              className="rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-sky-200"
                            >
                              Test
                            </button>
                            {openAiSet && (
                              <button
                                type="button"
                                onClick={() => void handleUnsetProvider("openai")}
                                className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-rose-200"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <h3 className="text-sm font-semibold text-white">Claude</h3>
                            <p className="mt-1 text-xs text-slate-500">Optional API fallback when Claude CLI is unavailable.</p>
                          </div>
                          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${claudeSet ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>
                            {claudeSet ? "Connected" : "Not configured"}
                          </span>
                        </div>
                        <div className="mt-4 space-y-3">
                          <input
                            value={claudeKey}
                            onChange={(event) => setClaudeKey(event.target.value)}
                            type="password"
                            placeholder="sk-ant-..."
                            className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveProvider("claude")}
                              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-amber-200"
                            >
                              Save Key
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleTestProvider("claude")}
                              className="rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-sky-200"
                            >
                              Test
                            </button>
                            {claudeSet && (
                              <button
                                type="button"
                                onClick={() => void handleUnsetProvider("claude")}
                                className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-rose-200"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 max-w-md space-y-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Secret Storage</h3>
                        <p className="mt-1 text-xs text-slate-500">Optional passphrase used when encrypting provider secrets on disk.</p>
                      </div>
                      <input
                        value={providerPassphrase}
                        onChange={(event) => setProviderPassphrase(event.target.value)}
                        type="password"
                        placeholder="Passphrase for encrypted storage (optional)"
                        className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                      />
                      {providerMessage && <div className="text-xs text-slate-400">{providerMessage}</div>}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Role Default Models</h3>
            <p className="mt-1 text-xs text-slate-500">
              These are default model preferences by role. They are not provider accounts. The provider above decides which tool runs; this section only sets the model family that role should prefer when the provider supports it.
            </p>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-[11px] text-slate-400">
              Example: a Developer agent may still run through Cursor CLI or Codex CLI, while this setting tells Orchestrum which model family to ask for by default.
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3 max-w-4xl">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">PM</label>
                <div className="mt-1 text-[11px] text-slate-500">Used for planning, scoping, and task breakdown.</div>
                <select
                  value={pmModelDefault}
                  onChange={(event) => setPmModelDefault(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {PM_MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Developer</label>
                <div className="mt-1 text-[11px] text-slate-500">Used for implementation, patch generation, and code edits.</div>
                <select
                  value={devModelDefault}
                  onChange={(event) => setDevModelDefault(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {DEV_MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Auditor</label>
                <div className="mt-1 text-[11px] text-slate-500">Used for review, regression checks, and risk analysis.</div>
                <select
                  value={auditModelDefault}
                  onChange={(event) => setAuditModelDefault(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {AUDIT_MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Runtime Tab ── */}
      {activeTab === "Runtime" && (
        <section className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-5">
            <h3 className="text-sm font-semibold text-white">What this tab controls</h3>
            <p className="mt-1 text-xs text-slate-400">
              Runtime settings control how work runs under the hood: how many agents can work at once, whether runs use isolation, and how Orchestrum picks a winner when multiple models disagree.
            </p>
            <div className="mt-3 text-[11px] text-slate-500">
              Most teams can keep these defaults unless they are tuning speed, safety, or infrastructure cost.
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">How Work Runs</h3>
            <p className="mt-1 text-xs text-slate-500">Choose how much work runs in parallel and whether Orchestrum uses an isolated execution environment.</p>
            <div className="mt-4 grid gap-6 sm:grid-cols-2 max-w-2xl">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Agents Running At The Same Time</label>
                <div className="mt-1 text-[11px] text-slate-500">Higher values are faster, but consume more machine resources and create more overlapping edits.</div>
                <input
                  type="number"
                  value={maxAgents}
                  onChange={(e) => setMaxAgents(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Sandbox Container Image</label>
                <div className="mt-1 text-[11px] text-slate-500">Only used when sandboxing is enabled. This is the Docker image Orchestrum will run work inside.</div>
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
                Use Docker isolation for runs
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={sandboxNetwork} onChange={(e) => setSandboxNetwork(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                Allow network inside the sandbox
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={clusterEnabled} onChange={(e) => setClusterEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                Use background worker cluster
              </label>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 text-[11px] text-slate-500">
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2">Docker isolation: safer, more predictable, slightly slower.</div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2">Network in sandbox: only enable if runs need package installs, APIs, or remote services.</div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2">Worker cluster: useful when you want more background throughput on stronger machines.</div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">How Conflicts Are Resolved</h3>
            <p className="mt-1 text-xs text-slate-500">When multiple models propose different answers, this tells Orchestrum how to choose the final one.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 max-w-md">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Decision Rule</label>
                <div className="mt-1 text-[11px] text-slate-500">Pick quality-first, majority vote, or speed-first behavior.</div>
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
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Minimum Opinions To Compare</label>
                <div className="mt-1 text-[11px] text-slate-500">How many model outputs must exist before arbitration kicks in.</div>
                <input
                  type="number"
                  value={arbMin}
                  onChange={(e) => setArbMin(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                />
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 text-[11px] text-slate-500">
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2"><span className="text-slate-300">Score</span>: tries to pick the strongest answer.</div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2"><span className="text-slate-300">Vote</span>: majority wins.</div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2"><span className="text-slate-300">Fastest</span>: returns the first acceptable result.</div>
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
            <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-5">
              <h3 className="text-sm font-semibold text-white">What this tab controls</h3>
              <p className="mt-1 text-xs text-slate-400">
                Profile settings define how autonomous a workspace should feel: its safety posture, budget ceiling, editing style, and delivery defaults.
              </p>
              <div className="mt-3 text-[11px] text-slate-500">
                The upper section changes agent behavior for this workspace. The lower sections control delivery presets and suggested tool routing.
              </div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
              <h3 className="text-sm font-semibold text-white">Workspace Behavior Defaults</h3>
              <p className="mt-1 text-xs text-slate-500">These settings shape how agents behave inside this workspace by default.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 max-w-lg">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Autonomy Level</label>
                  <div className="mt-1 text-[11px] text-slate-500">Lower means more guardrails and caution. Higher means agents act more freely.</div>
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
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Execution Safety Mode</label>
                  <div className="mt-1 text-[11px] text-slate-500">Choose whether work runs inside Docker isolation or directly on the local machine.</div>
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
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Where Code Changes Happen</label>
                  <div className="mt-1 text-[11px] text-slate-500">Inline edits touch the current checkout. Worktree mode uses a separate git worktree for isolation.</div>
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
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Soft Budget Per Run (USD)</label>
                  <div className="mt-1 text-[11px] text-slate-500">Optional. Use this if you want Orchestrum to respect a rough spending ceiling per mission.</div>
                  <input
                    value={profileMaxCost}
                    onChange={(e) => setProfileMaxCost(e.target.value)}
                    placeholder="1.00"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Default Working Style</label>
                  <div className="mt-1 text-[11px] text-slate-500">Optional shorthand such as `balanced`, `fast`, or `careful` for prompts and orchestration defaults.</div>
                  <input
                    value={profileStrategy}
                    onChange={(e) => setProfileStrategy(e.target.value)}
                    placeholder="balanced"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Default Browser App URL</label>
                  <div className="mt-1 text-[11px] text-slate-500">Optional. Used when browser-based steps need a known local app URL to open or test.</div>
                  <input
                    value={profileBrowserBaseUrl}
                    onChange={(e) => setProfileBrowserBaseUrl(e.target.value)}
                    placeholder="http://localhost:3000"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                  />
                </div>
              </div>
              <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Safety Rules</div>
                <div className="mt-1 text-[11px] text-slate-500">These switches decide which protective checks Orchestrum should enforce before or during execution.</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceEnabled} onChange={(e) => setGovernanceEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Turn on workspace safety checks
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceDangerousCommand} onChange={(e) => setGovernanceDangerousCommand(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Block risky shell commands
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceConfigProtection} onChange={(e) => setGovernanceConfigProtection(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Protect config files from casual edits
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={governanceQualityGate} onChange={(e) => setGovernanceQualityGate(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
                    Require quality gate before finishing
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
                  <h3 className="text-sm font-semibold text-white">Delivery Team Preset</h3>
                  <p className="mt-1 text-xs text-slate-500">This decides which roles exist in delivery mode and which tool each role should use by default.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleScaffoldPreset}
                    className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs uppercase tracking-[0.2em] text-slate-300"
                  >
                    Generate Starter Preset
                  </button>
                  <button
                    onClick={() => void (teamPresetEditor === "confirm" ? handleSaveTeamPresetFromForm() : handleSaveTeamPreset())}
                    className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-emerald-200"
                  >
                    {teamPresetEditor === "confirm" ? "Save Preset" : "Save Raw JSON"}
                  </button>
                </div>
              </div>
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/20 px-4 py-3 text-[11px] text-slate-400">
                If you do not need to fine-tune delivery handoffs yet, you can leave this section alone. The guided editor is the safer path; raw JSON is only for advanced customization.
              </div>
              <div className="mt-4 inline-flex rounded-lg border border-slate-800 bg-slate-900/40 p-1">
                <button
                  onClick={() => setTeamPresetEditor("confirm")}
                  className={`rounded-md px-3 py-1.5 text-xs ${teamPresetEditor === "confirm" ? "bg-slate-800 text-white" : "text-slate-400"}`}
                >
                  Guided Editor
                </button>
                <button
                  onClick={() => setTeamPresetEditor("raw")}
                  className={`rounded-md px-3 py-1.5 text-xs ${teamPresetEditor === "raw" ? "bg-slate-800 text-white" : "text-slate-400"}`}
                >
                  Advanced JSON
                </button>
              </div>
              {teamPresetEditor === "confirm" ? (
                <div className="mt-4 space-y-4">
                  {!teamPresetDraft ? (
                    <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-5 text-xs text-slate-500">
                      No preset draft loaded yet. Scaffold or load a workspace preset first.
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-4 lg:grid-cols-[0.65fr_1.35fr]">
                        <div>
                          <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Preset Name</label>
                          <input
                            value={teamPresetDraft.name}
                            onChange={(event) => setTeamPresetDraft((prev) => prev ? { ...prev, name: event.target.value } : prev)}
                            className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Run Mode</label>
                          <div className="mt-1 text-[11px] text-slate-500">How automatic the overall delivery loop should be by default.</div>
                          <select
                            value={teamPresetDraft.defaultRunMode}
                            onChange={(event) => setTeamPresetDraft((prev) => prev ? {
                              ...prev,
                              defaultRunMode: event.target.value === "manual_supervised" ? "manual_supervised" : "max_auto_supervised_hybrid"
                            } : prev)}
                            className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                          >
                            <option value="max_auto_supervised_hybrid">{deliveryRunModeLabel("max_auto_supervised_hybrid")} · {deliveryRunModeHint("max_auto_supervised_hybrid")}</option>
                            <option value="manual_supervised">{deliveryRunModeLabel("manual_supervised")} · {deliveryRunModeHint("manual_supervised")}</option>
                          </select>
                        </div>
                      </div>
                      <div className="grid gap-4 xl:grid-cols-2">
                        {teamPresetDraft.roles.map((role) => {
                          const options = targetOptionsForMode(role.mode, capabilities);
                          return (
                            <div key={role.id} className="rounded-xl border border-slate-800 bg-slate-900/30 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-sm font-medium text-white">{role.label}</div>
                                  <div className="mt-1 text-[11px] text-slate-500">{role.description || role.id}</div>
                                </div>
                                <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{role.id}</span>
                              </div>
                              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                                <div>
                                  <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Mode</label>
                                  <div className="mt-1 text-[11px] text-slate-500">How this specific role is executed.</div>
                                  <select
                                    value={role.mode}
                                    onChange={(event) => {
                                      const nextMode = event.target.value as TeamPresetDraft["roles"][number]["mode"];
                                      setTeamPresetDraft((prev) => prev ? {
                                        ...prev,
                                        roles: prev.roles.map((item) => item.id === role.id ? {
                                          ...item,
                                          mode: nextMode,
                                          target: targetOptionsForMode(nextMode, capabilities)[0] ?? item.target
                                        } : item)
                                      } : prev);
                                    }}
                                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                                  >
                                    <option value="manual_browser">{deliveryRoleModeLabel("manual_browser")} · {deliveryRoleModeHint("manual_browser")}</option>
                                    <option value="manual_ide">{deliveryRoleModeLabel("manual_ide")} · {deliveryRoleModeHint("manual_ide")}</option>
                                    <option value="auto_cli">{deliveryRoleModeLabel("auto_cli")} · {deliveryRoleModeHint("auto_cli")}</option>
                                    <option value="disabled">{deliveryRoleModeLabel("disabled")} · {deliveryRoleModeHint("disabled")}</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Primary Target</label>
                                  <div className="mt-1 text-[11px] text-slate-500">Which tool or endpoint this role should use first.</div>
                                  <select
                                    value={role.target}
                                    onChange={(event) => {
                                      const nextTarget = event.target.value;
                                      setTeamPresetDraft((prev) => prev ? {
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
                    </>
                  )}
                </div>
              ) : (
                <textarea
                  value={teamPresetText}
                  onChange={(event) => setTeamPresetText(event.target.value)}
                  className="mt-4 h-72 w-full rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-3 font-mono text-xs text-slate-200"
                />
              )}
              {teamPresetMessage && <div className="mt-3 text-xs text-slate-400">{teamPresetMessage}</div>}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
              <h3 className="text-sm font-semibold text-white">Detected Tools & Suggested Role Routing</h3>
              <p className="mt-1 text-xs text-slate-500">Orchestrum scans the machine and suggests how roles could be routed. Nothing changes until you save the preset above.</p>
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
          <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-5">
            <h3 className="text-sm font-semibold text-white">What this tab controls</h3>
            <p className="mt-1 text-xs text-slate-400">
              Advanced settings are low-level overrides. Most users will rarely need this tab unless they are customizing raw model maps, tightening shell permissions, or wiring telemetry.
            </p>
            <div className="mt-3 text-[11px] text-slate-500">
              If you are unsure, leave these settings at their defaults.
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Raw Model Map Overrides</h3>
            <p className="mt-1 text-xs text-slate-500">Advanced JSON override for model aliases and role mappings. This merges into the defaults from the simpler settings above.</p>
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/25 px-4 py-3 text-[11px] text-slate-400">
              Only edit this if you need precise model IDs beyond the standard role defaults.
            </div>
            <textarea
              value={modelsText}
              onChange={(e) => setModelsText(e.target.value)}
              className="mt-3 h-36 w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 font-mono text-xs text-slate-200"
            />
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Allowed Terminal Commands</h3>
            <p className="mt-1 text-xs text-slate-500">Optional safety restriction. If you list commands here, agents may only execute those commands.</p>
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/25 px-4 py-3 text-[11px] text-slate-400">
              Leave this empty if you do not want command restrictions. Add one command prefix per line if you need a stricter environment.
            </div>
            <textarea
              value={shellAllowlistText}
              onChange={(e) => setShellAllowlistText(e.target.value)}
              placeholder="npm test&#10;git status&#10;ls"
              className="mt-3 h-28 w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600"
            />
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Telemetry</h3>
            <p className="mt-1 text-xs text-slate-500">Optional usage reporting. This is for operational metrics, not your code contents or secrets.</p>
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={telemetryEnabled} onChange={(e) => setTelemetryEnabled(e.target.checked)} className="rounded border-slate-700 bg-slate-900" />
              Send anonymous operational telemetry
            </label>
            {telemetryEnabled && (
              <div className="mt-2">
                <div className="mb-2 text-[11px] text-slate-500">Optional custom endpoint if you do not want the default telemetry target.</div>
                <input
                  value={telemetryEndpoint}
                  onChange={(e) => setTelemetryEndpoint(e.target.value)}
                  placeholder="Custom endpoint (optional)"
                  className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                />
              </div>
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
