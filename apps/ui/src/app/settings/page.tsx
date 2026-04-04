"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { useAppUi } from "@/components/AppUiProvider";
import { WorkspaceSelector } from "@/components/WorkspaceSelector";
import { ProviderDiscoveryGrid } from "@/components/providers/ProviderDiscoveryGrid";
import { ProviderDiscoveryLoadingState } from "@/components/providers/ProviderDiscoveryLoadingState";
import { ProviderDiscoveryStatusSummary } from "@/components/providers/ProviderDiscoveryStatusSummary";
import { PageHeader, SegmentedTabs } from "@/components/ui/PagePrimitives";
import {
  type DeliveryBinding,
  type DeliveryCapability,
  type TeamPresetDraft,
  type TeamPresetDraftRole,
  normalizeTeamPresetDraft,
  serializeTeamPresetDraft,
  targetOptionsForMode,
  toolLabel
} from "@/lib/delivery";
import {
  transportLabel,
  vendorLabel,
  type ProviderEffort,
  type ProviderDiscoveryRecord
} from "@/lib/providers";
import { useProviderDiscovery } from "@/lib/queries/useProviderDiscovery";
import { useWorkspaces } from "@/lib/queries/useWorkspaces";

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
  efforts: z.record(z.enum(["minimal", "low", "medium", "high", "max"])).optional(),
  shell_allowlist: z.array(z.string()).optional(),
  telemetry: z
    .object({
      enabled: z.boolean().optional(),
      endpoint: z.string().optional()
    })
    .optional()
});

type Scope = "workspace" | "global";
const advancedTabs = ["Runtime", "Profile", "Advanced"] as const;
type Tab = (typeof advancedTabs)[number];
type SettingsMode = "basic" | "advanced";

type ModelOption = {
  value: string;
  label: string;
  hint: string;
};

type EffortOption = {
  value: "" | ProviderEffort;
  label: string;
  hint: string;
};

const PM_MODEL_FALLBACK_OPTIONS: ModelOption[] = [
  { value: "gpt-5", label: "GPT-5", hint: "broader planning and reasoning" },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "balanced fallback" },
  { value: "o4-mini", label: "o4-mini", hint: "lighter and cheaper" }
] as const;

const DEV_MODEL_FALLBACK_OPTIONS: ModelOption[] = [
  { value: "codex", label: "Codex", hint: "code-focused default" },
  { value: "gpt-5", label: "GPT-5", hint: "general implementation fallback" },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "balanced fallback" }
] as const;

const AUDIT_MODEL_FALLBACK_OPTIONS: ModelOption[] = [
  { value: "gpt-5", label: "GPT-5", hint: "review and risk analysis" },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "balanced fallback" },
  { value: "o4-mini", label: "o4-mini", hint: "lighter verification passes" }
] as const;

const ROLE_EFFORT_OPTIONS: EffortOption[] = [
  { value: "", label: "Provider default", hint: "let the selected provider choose" },
  { value: "minimal", label: "Minimal", hint: "lowest reasoning budget" },
  { value: "low", label: "Low", hint: "faster, lighter reasoning" },
  { value: "medium", label: "Medium", hint: "balanced default" },
  { value: "high", label: "High", hint: "deeper reasoning" },
  { value: "max", label: "Max", hint: "highest reasoning budget when supported" }
] as const;

const QUICK_TEAM_PRESETS = [
  {
    id: "solo_audit",
    label: "Solo Audit",
    description: "Planner plus auditor only. Best when you want a focused repo review without a delivery team.",
    name: "Solo Audit",
    runMode: "manual_supervised" as const,
    roles: {
      planner: { mode: "manual_browser" as const, preferredTargets: ["chatgpt", "claude"] },
      developer: { mode: "disabled" as const, preferredTargets: [] },
      tester: { mode: "disabled" as const, preferredTargets: [] },
      auditor: { mode: "manual_browser" as const, preferredTargets: ["claude", "chatgpt"] },
    },
  },
  {
    id: "backend_build",
    label: "Backend Build",
    description: "Planner, developer, tester, and auditor. Good default for API and server-heavy work.",
    name: "Backend Build",
    runMode: "max_auto_supervised_hybrid" as const,
    roles: {
      planner: { mode: "manual_browser" as const, preferredTargets: ["chatgpt", "claude"] },
      developer: { mode: "manual_ide" as const, preferredTargets: ["codex", "cursor", "copilot"] },
      tester: { mode: "auto_cli" as const, preferredTargets: ["local-shell"] },
      auditor: { mode: "manual_browser" as const, preferredTargets: ["claude", "chatgpt"] },
    },
  },
  {
    id: "ui_change",
    label: "UI Change",
    description: "Planner, developer, tester, and auditor with a UI-first implementation target.",
    name: "UI Change",
    runMode: "manual_supervised" as const,
    roles: {
      planner: { mode: "manual_browser" as const, preferredTargets: ["chatgpt", "claude"] },
      developer: { mode: "manual_ide" as const, preferredTargets: ["cursor", "codex", "copilot"] },
      tester: { mode: "manual_ide" as const, preferredTargets: ["cursor", "codex", "copilot"] },
      auditor: { mode: "manual_browser" as const, preferredTargets: ["claude", "chatgpt"] },
    },
  },
  {
    id: "cross_stack_delivery",
    label: "Cross-stack Delivery",
    description: "Full delivery preset with implementation, validation, and audit all active.",
    name: "Cross-stack Delivery",
    runMode: "max_auto_supervised_hybrid" as const,
    roles: {
      planner: { mode: "manual_browser" as const, preferredTargets: ["chatgpt", "claude"] },
      developer: { mode: "manual_ide" as const, preferredTargets: ["cursor", "codex", "copilot"] },
      tester: { mode: "auto_cli" as const, preferredTargets: ["local-shell"] },
      auditor: { mode: "manual_browser" as const, preferredTargets: ["claude", "chatgpt"] },
    },
  },
] as const;

function fallbackTargetForMode(
  mode: TeamPresetDraftRole["mode"],
  capabilities: DeliveryCapability[],
  preferredTargets: readonly string[]
) {
  const options = targetOptionsForMode(mode, capabilities);
  return preferredTargets.find((target) => options.includes(target)) ?? options[0] ?? (mode === "auto_cli" ? "local-shell" : "chatgpt");
}

function defaultDraftRole(
  id: "planner" | "developer" | "tester" | "auditor",
  mode: TeamPresetDraftRole["mode"],
  target: string
): TeamPresetDraftRole {
  if (id === "planner") {
    return {
      id,
      label: "Planner",
      description: "Clarifies scope, acceptance, and risks before implementation or review.",
      mode,
      target,
      objective: "Plan the requested work before execution begins.",
      acceptanceCriteria: ["Keep the plan grounded in the current repo context."],
      expectedOutput: ["Execution plan", "Risks and blockers"],
    };
  }
  if (id === "developer") {
    return {
      id,
      label: "Developer",
      description: "Implements the requested repo changes.",
      mode,
      target,
      objective: "Implement only the scoped change and avoid widening the patch.",
      acceptanceCriteria: ["Preserve existing patterns unless the request calls for change."],
      expectedOutput: ["Patch summary", "Changed files", "Validation notes"],
    };
  }
  if (id === "tester") {
    return {
      id,
      label: "Tester",
      description: "Runs the safest validation path available in the repo.",
      mode,
      target,
      objective: "Validate the branch with the safest available local commands.",
      acceptanceCriteria: ["Record failing commands with evidence when validation does not pass."],
      expectedOutput: ["Validation command list", "Pass/fail evidence"],
    };
  }
  return {
    id,
    label: "Auditor",
    description: "Reviews correctness, regressions, and readiness before a human decision.",
    mode,
    target,
    objective: "Review the current change set critically and surface concrete findings.",
    acceptanceCriteria: ["Lead with concrete regressions or missing validation."],
    expectedOutput: ["Audit findings", "Readiness signal"],
  };
}

function buildQuickTeamPresetDraft(
  presetId: (typeof QUICK_TEAM_PRESETS)[number]["id"],
  capabilities: DeliveryCapability[]
): TeamPresetDraft {
  const preset = QUICK_TEAM_PRESETS.find((entry) => entry.id === presetId) ?? QUICK_TEAM_PRESETS[0];
  return {
    version: 1,
    name: preset.name,
    defaultRunMode: preset.runMode,
    roles: (["planner", "developer", "tester", "auditor"] as const).map((roleId) => {
      const config = preset.roles[roleId];
      const target =
        config.mode === "disabled"
          ? "disabled"
          : fallbackTargetForMode(config.mode, capabilities, config.preferredTargets);
      return defaultDraftRole(roleId, config.mode, target);
    }),
  };
}

function buildRoleModelOptions(
  providers: ProviderDiscoveryRecord[],
  role: "pm" | "dev" | "audit",
  fallbackOptions: ModelOption[],
  currentValue: string
): ModelOption[] {
  const options = new Map<string, ModelOption>();
  const addOption = (model: string, label: string, hint: string) => {
    const normalized = model.trim();
    if (!normalized || options.has(normalized)) return;
    options.set(normalized, { value: normalized, label, hint });
  };

  for (const record of providers) {
    for (const transport of record.transports) {
      for (const profile of transport.profiles) {
        const matchesRole =
          !profile.roleHints?.length ||
          profile.roleHints.includes(role) ||
          (role === "pm" && profile.roleHints.includes("plan"));
        if (!matchesRole) continue;
        addOption(
          profile.model,
          profile.label,
          profile.description || `${vendorLabel(record.vendor)} ${transportLabel(transport.transport)} profile`
        );
      }
      for (const model of transport.models ?? []) {
        addOption(
          model,
          model,
          `Discovered from ${vendorLabel(record.vendor)} ${transportLabel(transport.transport).toLowerCase()}.`
        );
      }
    }
  }

  for (const option of fallbackOptions) {
    addOption(option.value, option.label, option.hint);
  }
  if (currentValue.trim()) {
    addOption(currentValue, currentValue, "Currently selected model.");
  }
  return Array.from(options.values());
}

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
  const searchParams = useSearchParams();
  const { selectedWorkspaceId, setSelectedWorkspaceId, pushToast } = useAppUi();
  const [scope, setScope] = useState<Scope>("workspace");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [maxAgents, setMaxAgents] = useState<number>(3);
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [sandboxImage, setSandboxImage] = useState("node:20-alpine");
  const [sandboxNetwork, setSandboxNetwork] = useState(false);
  const [arbMode, setArbMode] = useState<"score" | "vote" | "fastest">("score");
  const [arbMin, setArbMin] = useState(2);
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
  const [pmEffortDefault, setPmEffortDefault] = useState<"" | ProviderEffort>("");
  const [devEffortDefault, setDevEffortDefault] = useState<"" | ProviderEffort>("");
  const [auditEffortDefault, setAuditEffortDefault] = useState<"" | ProviderEffort>("");
  const seededFromQueryRef = useRef(false);
  const { data: workspaces = [] } = useWorkspaces();
  const [settingsMode, setSettingsMode] = useState<SettingsMode>("basic");
  const [activeTab, setActiveTab] = useState<Tab>("Runtime");
  const resolvedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const hasResolvedWorkspace = Boolean(resolvedWorkspace);
  const resolvedWorkspaceId = resolvedWorkspace?.id ?? "";
  const effectiveScope: Scope = scope === "workspace" && hasResolvedWorkspace ? "workspace" : "global";
  const {
    providers: providerDiscovery,
    isLoading: providerDiscoveryLoading,
    error: providerDiscoveryError
  } = useProviderDiscovery({
    scope: effectiveScope,
    workspaceId,
    enabled: settingsMode === "basic"
  });
  const pmModelOptions = useMemo(
    () => buildRoleModelOptions(providerDiscovery, "pm", PM_MODEL_FALLBACK_OPTIONS, pmModelDefault),
    [pmModelDefault, providerDiscovery]
  );
  const devModelOptions = useMemo(
    () => buildRoleModelOptions(providerDiscovery, "dev", DEV_MODEL_FALLBACK_OPTIONS, devModelDefault),
    [devModelDefault, providerDiscovery]
  );
  const auditModelOptions = useMemo(
    () => buildRoleModelOptions(providerDiscovery, "audit", AUDIT_MODEL_FALLBACK_OPTIONS, auditModelDefault),
    [auditModelDefault, providerDiscovery]
  );

  useEffect(() => {
    if (seededFromQueryRef.current) return;
    const tabParam = searchParams.get("tab");
    const scopeParam = searchParams.get("scope");
    const workspaceParam = searchParams.get("workspace");

    if (tabParam === "Providers") {
      setSettingsMode("basic");
    } else if (tabParam && advancedTabs.includes(tabParam as Tab)) {
      setSettingsMode("advanced");
      setActiveTab(tabParam as Tab);
    }
    if (scopeParam === "workspace" || scopeParam === "global") {
      setScope(scopeParam);
    }
    if (workspaceParam) {
      setWorkspaceId(workspaceParam);
      setSelectedWorkspaceId(workspaceParam);
    } else if (selectedWorkspaceId && selectedWorkspaceId !== "undefined") {
      setWorkspaceId(selectedWorkspaceId);
    }
    seededFromQueryRef.current = true;
  }, [searchParams, selectedWorkspaceId, setSelectedWorkspaceId]);

  useEffect(() => {
    if (!seededFromQueryRef.current) return;
    if (searchParams.get("workspace")) return;
    setWorkspaceId(selectedWorkspaceId && selectedWorkspaceId !== "undefined" ? selectedWorkspaceId : "");
  }, [searchParams, selectedWorkspaceId]);

  useEffect(() => {
    if (scope !== "workspace") return;
    if (workspaceId) {
      if (workspaces.length === 0) return;
      if (workspaces.some((workspace) => workspace.id === workspaceId)) return;
      setWorkspaceId("");
      if (selectedWorkspaceId === workspaceId) {
        setSelectedWorkspaceId("");
      }
      return;
    }
    if (workspaces.length === 1) {
      const onlyWorkspaceId = workspaces[0]?.id ?? "";
      if (!onlyWorkspaceId) return;
      setWorkspaceId(onlyWorkspaceId);
      if (selectedWorkspaceId !== onlyWorkspaceId) {
        setSelectedWorkspaceId(onlyWorkspaceId);
      }
    }
  }, [scope, workspaceId, workspaces, selectedWorkspaceId, setSelectedWorkspaceId]);

  useEffect(() => {
    if (settingsMode !== "basic") return;
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
  }, [settingsMode, effectiveScope, workspaceId]);

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
      setModelsText(JSON.stringify(config.models ?? {}, null, 2));
      setPmModelDefault(config.models?.pm ?? "gpt-5");
      setDevModelDefault(config.models?.dev ?? "codex");
      setAuditModelDefault(config.models?.audit ?? "gpt-5");
      setPmEffortDefault(config.efforts?.pm ?? "");
      setDevEffortDefault(config.efforts?.dev ?? "");
      setAuditEffortDefault(config.efforts?.audit ?? "");
      setShellAllowlistText((config.shell_allowlist ?? []).join("\n"));
      setTelemetryEnabled(Boolean(config.telemetry?.enabled));
      setTelemetryEndpoint(config.telemetry?.endpoint ?? "");
    };
    void load();
  }, [effectiveScope, workspaceId]);

  useEffect(() => {
    if (scope !== "workspace" || !resolvedWorkspaceId) return;
    const loadProfile = async () => {
      const res = await fetch(`/api/profile?workspace=${encodeURIComponent(resolvedWorkspaceId)}`);
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
  }, [scope, resolvedWorkspaceId]);

  useEffect(() => {
    if (scope !== "workspace" || !resolvedWorkspaceId) {
      setTeamPresetText("");
      setCapabilities([]);
      setSuggestedBindings([]);
      return;
    }
    const loadDeliverySetup = async () => {
      const [presetRes, capabilityRes] = await Promise.all([
        fetch(`/api/team-preset?workspace=${encodeURIComponent(resolvedWorkspaceId)}`, { cache: "no-store" }),
        fetch(`/api/capabilities?workspace=${encodeURIComponent(resolvedWorkspaceId)}`, { cache: "no-store" })
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
  }, [scope, resolvedWorkspaceId]);

  const handleSave = async () => {
    setErrors([]);
    setSaved(false);
    if (scope === "workspace" && !resolvedWorkspaceId) {
      setErrors(["Choose a valid workspace first, or switch to Global scope."]);
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
    const efforts = {
      ...(pmEffortDefault ? { pm: pmEffortDefault } : {}),
      ...(devEffortDefault ? { dev: devEffortDefault } : {}),
      ...(auditEffortDefault ? { audit: auditEffortDefault } : {})
    };
    const shell_allowlist = shellAllowlistText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const config = {
      concurrency: { max_agents: maxAgents },
      sandbox: { enabled: sandboxEnabled, image: sandboxImage, network: sandboxNetwork },
      arbitration: { mode: arbMode, min_models: arbMin },
      models,
      efforts: Object.keys(efforts).length > 0 ? efforts : undefined,
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
        workspaceId: scope === "workspace" ? resolvedWorkspaceId : undefined,
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
    if (scope !== "workspace" || !hasResolvedWorkspace) {
      setProfileMessage("Switch to Workspace scope and select a valid workspace first.");
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
      body: JSON.stringify({ workspaceId: resolvedWorkspaceId, profile })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setProfileMessage(data.error ?? "Failed to save profile.");
      return;
    }
    setProfileMessage("Profile saved.");
  };

  const handleScaffoldPreset = async () => {
    if (scope !== "workspace" || !hasResolvedWorkspace) {
      setTeamPresetMessage("Switch to Workspace scope and select a valid workspace first.");
      return;
    }
    const res = await fetch("/api/team-preset/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: resolvedWorkspaceId,
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

  const handleUseQuickPreset = async (presetId: (typeof QUICK_TEAM_PRESETS)[number]["id"]) => {
    if (scope !== "workspace" || !hasResolvedWorkspace) {
      setTeamPresetMessage("Choose one workspace first, then apply a team preset.");
      return;
    }
    const draft = buildQuickTeamPresetDraft(presetId, capabilities);
    setTeamPresetDraft(draft);
    setTeamPresetText(JSON.stringify(serializeTeamPresetDraft(draft), null, 2));
    setTeamPresetEditor("confirm");
    await handleSaveTeamPresetPayload(serializeTeamPresetDraft(draft));
  };

  const handleSaveTeamPreset = async () => {
    setTeamPresetMessage("");
    if (scope !== "workspace" || !hasResolvedWorkspace) {
      setTeamPresetMessage("Switch to Workspace scope and select a valid workspace first.");
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
    if (scope !== "workspace" || !hasResolvedWorkspace) {
      setTeamPresetMessage("Switch to Workspace scope and select a valid workspace first.");
      return;
    }
    const res = await fetch("/api/team-preset", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: resolvedWorkspaceId,
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
    <main className="page-shell">
      <PageHeader
        eyebrow="Settings"
        title="Connect a provider, then pick a team preset"
        description="Basic mode now stays narrow on purpose: workspace scope, provider setup, and one understandable team preset. Runtime tuning and raw configuration remain in Advanced."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedTabs
              value={scope}
              onChange={(value) => setScope(value)}
              options={[
                { value: "workspace", label: "Workspace" },
                { value: "global", label: "Global" }
              ]}
            />
            {scope === "workspace" && (
              <WorkspaceSelector
                includeAll={false}
                className="min-w-[14rem] rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-200"
              />
            )}
            <button
              type="button"
              onClick={() => {
                if (settingsMode === "advanced") {
                  setSettingsMode("basic");
                  return;
                }
                setSettingsMode("advanced");
                if (!advancedTabs.includes(activeTab)) {
                  setActiveTab("Runtime");
                }
              }}
              className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
            >
              {settingsMode === "advanced" ? "Hide Advanced" : "Show Advanced"}
            </button>
            <Link
              href="/workspaces"
              className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
            >
              Manage Workspaces
            </Link>
          </div>
        }
      />

      {settingsMode === "advanced" && (
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">Advanced tuning</div>
              <div className="mt-1 text-xs text-slate-500">
                Provider connection and team preset stay above. Open these sections only when you really need runtime tuning or raw preset editing.
              </div>
            </div>
          </div>
          <nav className="flex flex-wrap gap-2">
            {advancedTabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`rounded-xl border px-4 py-2 text-sm transition-colors ${
                  activeTab === tab
                    ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                    : "border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200"
                }`}
              >
                {tab}
              </button>
            ))}
          </nav>
        </section>
      )}

      {settingsMode === "basic" && (
        <section className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Workspace</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Settings follows the currently selected workspace. Register or switch repos here only when Work cannot proceed yet.
                </p>
              </div>
              <Link
                href="/workspaces"
                className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-900"
              >
                Open workspace registry
              </Link>
            </div>
            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/30 px-4 py-4 text-sm text-slate-300">
              {resolvedWorkspace ? (
                <div className="space-y-1">
                  <div className="font-medium text-white">{resolvedWorkspace.name ?? resolvedWorkspace.id}</div>
                  <div className="text-xs text-slate-500">{resolvedWorkspace.path}</div>
                </div>
              ) : workspaces.length > 0 ? (
                "Choose a workspace above so provider setup and team presets are scoped to the right repo."
              ) : (
                "No workspace is registered yet. Add one from Work first or open the workspace registry here."
              )}
            </div>
          </div>

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
            <h3 className="text-sm font-semibold text-white">Team presets</h3>
            <p className="mt-1 text-xs text-slate-500">
              Start from a preset instead of creating individual specialists. Advanced still lets you tune role models, workspace behavior, and raw preset JSON later.
            </p>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {QUICK_TEAM_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => void handleUseQuickPreset(preset.id)}
                  className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4 text-left transition hover:border-slate-700 hover:bg-slate-900/55"
                >
                  <div className="text-sm font-semibold text-white">{preset.label}</div>
                  <div className="mt-1 text-sm leading-6 text-slate-400">{preset.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Current team preset</h3>
                <p className="mt-1 text-xs text-slate-500">Set the preset name and run mode here. Use Advanced if you want full role routing, role model defaults, or raw JSON editing.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleScaffoldPreset}
                  className="rounded-xl border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs font-medium text-slate-200"
                >
                  Load starter preset
                </button>
                <button
                  onClick={() => void handleSaveTeamPresetFromForm()}
                  disabled={!teamPresetDraft}
                  className="rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs font-medium text-emerald-200 disabled:opacity-40"
                >
                  Save preset
                </button>
              </div>
            </div>
            {scope !== "workspace" ? (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                Delivery presets are workspace-only. Switch to Workspace scope to edit them.
              </div>
            ) : !hasResolvedWorkspace ? (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                {workspaces.length === 0
                  ? "No workspace is registered yet. Add one from Work or open the workspace registry."
                  : "Choose a workspace above to edit or scaffold its delivery preset."}
              </div>
            ) : !teamPresetDraft ? (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-700 px-4 py-6 text-sm text-slate-500">
                No preset draft loaded yet. Generate a starter preset first.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Preset name</label>
                    <input
                      value={teamPresetDraft.name}
                      onChange={(event) => setTeamPresetDraft((prev) => prev ? { ...prev, name: event.target.value } : prev)}
                      className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Run mode</label>
                    <select
                      value={teamPresetDraft.defaultRunMode}
                      onChange={(event) =>
                        setTeamPresetDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                defaultRunMode:
                                  event.target.value === "manual_supervised"
                                    ? "manual_supervised"
                                    : "max_auto_supervised_hybrid"
                              }
                            : prev
                        )
                      }
                      className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                    >
                      <option value="max_auto_supervised_hybrid">{deliveryRunModeLabel("max_auto_supervised_hybrid")}</option>
                      <option value="manual_supervised">{deliveryRunModeLabel("manual_supervised")}</option>
                    </select>
                    <div className="mt-2 text-[11px] text-slate-500">
                      {deliveryRunModeHint(teamPresetDraft.defaultRunMode)}
                    </div>
                  </div>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {teamPresetDraft.roles.map((role) => (
                    <div key={role.id} className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
                      <div className="text-sm font-medium text-white">{role.label}</div>
                      <div className="mt-1 text-xs text-slate-500">{role.description ?? role.id}</div>
                      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-400">
                        <span className="rounded-full border border-slate-700 px-2.5 py-1">
                          {deliveryRoleModeLabel(role.mode)}
                        </span>
                        <span className="rounded-full border border-slate-700 px-2.5 py-1">
                          {role.mode === "disabled" ? "Disabled" : toolLabel(role.target)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {teamPresetMessage && <div className="mt-4 text-xs text-slate-400">{teamPresetMessage}</div>}
          </div>
        </section>
      )}

      {/* ── Runtime Tab ── */}
      {settingsMode === "advanced" && activeTab === "Runtime" && (
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
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3 text-[11px] text-slate-500">
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2">Docker isolation: safer, more predictable, slightly slower.</div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2">Network in sandbox: only enable if runs need package installs, APIs, or remote services.</div>
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

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Role model defaults</h3>
            <p className="mt-1 text-xs text-slate-500">
              These stay in Advanced because they are role-level preferences, not provider accounts. The provider picks the tool; this section picks the model family that role should ask for by default.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3 max-w-4xl">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">PM</label>
                <select
                  value={pmModelDefault}
                  onChange={(event) => setPmModelDefault(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {pmModelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Developer</label>
                <select
                  value={devModelDefault}
                  onChange={(event) => setDevModelDefault(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {devModelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Auditor</label>
                <select
                  value={auditModelDefault}
                  onChange={(event) => setAuditModelDefault(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {auditModelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
            <h3 className="text-sm font-semibold text-white">Role reasoning defaults</h3>
            <p className="mt-1 text-xs text-slate-500">
              Set reasoning effort separately per role. Leave a role on provider default when you only want model separation, or pin it when PM, developer, and auditor should reason at different depths.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3 max-w-4xl">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">PM</label>
                <select
                  value={pmEffortDefault}
                  onChange={(event) => setPmEffortDefault(event.target.value as "" | ProviderEffort)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {ROLE_EFFORT_OPTIONS.map((option) => (
                    <option key={`pm-${option.value || "default"}`} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Developer</label>
                <select
                  value={devEffortDefault}
                  onChange={(event) => setDevEffortDefault(event.target.value as "" | ProviderEffort)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {ROLE_EFFORT_OPTIONS.map((option) => (
                    <option key={`dev-${option.value || "default"}`} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Auditor</label>
                <select
                  value={auditEffortDefault}
                  onChange={(event) => setAuditEffortDefault(event.target.value as "" | ProviderEffort)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
                >
                  {ROLE_EFFORT_OPTIONS.map((option) => (
                    <option key={`audit-${option.value || "default"}`} value={option.value}>
                      {option.label} · {option.hint}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-4 text-[11px] text-slate-500">
              Some CLI/model pairs still reject `max`. Orchestrum now steps down to the highest supported effort instead of hard-failing the run.
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
      {settingsMode === "advanced" && activeTab === "Profile" && (
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
                Profile settings define how a workspace should execute: its safety posture, budget ceiling, editing style, and delivery defaults.
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
      {settingsMode === "advanced" && activeTab === "Advanced" && (
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
