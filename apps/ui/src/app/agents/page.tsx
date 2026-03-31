"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { useConfirm } from "@/components/ConfirmDialog";
import { ModalFrame } from "@/components/ModalFrame";
import { ProviderDiscoveryLoadingState } from "@/components/providers/ProviderDiscoveryLoadingState";
import { ProviderDiscoveryStatusSummary } from "@/components/providers/ProviderDiscoveryStatusSummary";
import {
  PROVIDER_DISCOVERY_ORDER,
  defaultProviderForRole,
  preferredTransport,
  profileLabel,
  providerDiscoveryBadgeLabel,
  providerDiscoveryExplanation,
  providerDiscoverySummaryLabel,
  providerSummary,
  transportLabel,
  vendorLabel,
  type ProviderDiscoveryRecord,
  type ProviderEffort,
  type ProviderSpec,
  type ProviderTransport,
  type ProviderVendor
} from "@/lib/providers";
import { useProviderDiscovery } from "@/lib/queries/useProviderDiscovery";
import { useWorkspaces, type WorkspaceSummary } from "@/lib/queries/useWorkspaces";

type Agent = {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  tags: string[];
  provider: ProviderSpec;
  capabilities: { shell: boolean; fs: boolean; network: boolean };
  status: { state: string; currentTaskId?: string; lastHeartbeatAt: string };
};

type Draft = {
  workspaceId: string;
  name: string;
  role: string;
  tags: string;
  provider: ProviderSpec;
  capabilities: {
    shell: boolean;
    fs: boolean;
    network: boolean;
  };
};

type RolePreset = "pm" | "dev" | "audit" | "custom";

type PermissionKey = keyof Draft["capabilities"];

const roleSuggestions: Array<{
  preset: RolePreset;
  role: string;
  label: string;
  desc: string;
  defaultName: string;
}> = [
  { preset: "pm", role: "pm", label: "PM", desc: "Plans scope, writes specs, and coordinates work.", defaultName: "PM Agent" },
  { preset: "dev", role: "dev", label: "Developer", desc: "Implements changes, edits code, and verifies fixes.", defaultName: "Developer Agent" },
  { preset: "audit", role: "audit", label: "Auditor", desc: "Reviews quality, regressions, and delivery risks.", defaultName: "Auditor Agent" },
  { preset: "custom", role: "", label: "Custom", desc: "Start from a general-purpose template and tune it later.", defaultName: "Custom Agent" }
];

const permissionOptions: Array<{
  key: PermissionKey;
  label: string;
  description: string;
}> = [
  { key: "shell", label: "Run terminal commands", description: "Allow command execution like tests, builds, and repo tooling." },
  { key: "fs", label: "Read and edit project files", description: "Allow reading and writing files inside the workspace." },
  { key: "network", label: "Use internet/network access", description: "Allow outgoing network calls for APIs, docs, or hosted services." }
];

const TRANSPORT_OPTIONS: ProviderTransport[] = ["cli", "api", "local_http"];
const EFFORT_OPTIONS: ProviderEffort[] = ["low", "medium", "high", "max"];

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function rolePresetFromRole(role: string): RolePreset {
  const normalized = role.trim().toLowerCase();
  if (normalized === "pm") return "pm";
  if (normalized === "dev") return "dev";
  if (normalized === "audit") return "audit";
  return "custom";
}

function roleLabelForPreset(preset: RolePreset) {
  return roleSuggestions.find((entry) => entry.preset === preset)?.label ?? "Custom";
}

function displayRole(role: string) {
  const preset = rolePresetFromRole(role);
  return preset === "custom" ? role || "custom" : roleLabelForPreset(preset);
}

function defaultCapabilitiesForPreset(preset: RolePreset): Draft["capabilities"] {
  if (preset === "dev") {
    return { shell: true, fs: true, network: true };
  }
  if (preset === "audit") {
    return { shell: false, fs: true, network: false };
  }
  return { shell: false, fs: true, network: true };
}

function createDraft(workspaceId = "", preset: RolePreset = "dev"): Draft {
  const suggestion = roleSuggestions.find((entry) => entry.preset === preset) ?? {
    preset: "dev" as const,
    role: "dev",
    label: "Developer",
    desc: "Implements changes, edits code, and verifies fixes.",
    defaultName: "Developer Agent"
  };
  const role = suggestion.role;
  return {
    workspaceId,
    name: suggestion.defaultName,
    role,
    tags: "",
    provider: defaultProviderForRole(role || "general"),
    capabilities: defaultCapabilitiesForPreset(preset)
  };
}

function createDraftFromAgent(agent: Agent): Draft {
  return {
    workspaceId: agent.workspaceId,
    name: agent.name,
    role: agent.role,
    tags: agent.tags.join(", "),
    provider: agent.provider,
    capabilities: agent.capabilities
  };
}

function applyPresetToDraft(previous: Draft, preset: RolePreset): Draft {
  const next = createDraft(previous.workspaceId, preset);
  if (preset === "custom" && rolePresetFromRole(previous.role) === "custom" && previous.role.trim()) {
    next.role = previous.role;
  }
  return {
    ...next,
    workspaceId: previous.workspaceId,
    tags: previous.tags
  };
}

function capabilityBadgeLabel(key: PermissionKey) {
  if (key === "shell") return "Terminal";
  if (key === "fs") return "Files";
  return "Internet";
}

function defaultTransportForVendor(vendor: ProviderVendor): ProviderTransport {
  if (vendor === "openai") return "api";
  if (vendor === "ollama" || vendor === "llama.cpp") return "local_http";
  return "cli";
}

function defaultApiSecretRef(vendor: ProviderVendor): string | undefined {
  if (vendor === "claude") return "ANTHROPIC_API_KEY";
  if (vendor === "openai") return "OPENAI_API_KEY";
  return undefined;
}

function stateColor(state: string) {
  if (state === "running" || state === "active") return "bg-amber-400";
  if (state === "sleeping" || state === "idle") return "bg-emerald-400";
  return "bg-slate-600";
}

function stateLabel(state: string) {
  if (state === "running" || state === "active") return "text-amber-300";
  if (state === "sleeping" || state === "idle") return "text-emerald-300";
  return "text-slate-500";
}

function applyProviderSelection(
  current: Draft,
  providers: ProviderDiscoveryRecord[],
  vendor: ProviderVendor,
  transport?: ProviderTransport
): Draft {
  const role = current.role || "general";
  const vendorRecord = providers.find((entry) => entry.vendor === vendor);
  const nextTransportRecord = transport
    ? vendorRecord?.transports.find((entry) => entry.transport === transport)
    : preferredTransport(vendorRecord ?? { vendor, label: vendorLabel(vendor), transports: [], preferredTransport: null });
  const nextTransport = nextTransportRecord?.transport
    ?? transport
    ?? (vendor === current.provider.vendor ? current.provider.transport : defaultTransportForVendor(vendor));
  const nextProfile = nextTransportRecord?.profiles.find((profile) => profile.recommended) ?? nextTransportRecord?.profiles[0];
  const vendorChanged = vendor !== current.provider.vendor;
  const fallback = defaultProviderForRole(role).fallback ?? null;

  return {
    ...current,
    provider: {
      vendor,
      transport: nextTransport,
      profileId: nextProfile?.id ?? (vendorChanged ? undefined : current.provider.profileId),
      modelOverride: nextProfile?.model ?? (vendorChanged ? undefined : current.provider.modelOverride),
      effort: nextTransportRecord?.capabilities.supportsEffort ? (current.provider.effort ?? "medium") : undefined,
      auth: nextTransport === "cli"
        ? { kind: "cli" }
        : nextTransport === "api"
          ? { kind: "api_key", secretRef: defaultApiSecretRef(vendor) }
          : { kind: "none" },
      fallback: fallback && fallback.vendor !== vendor ? fallback : current.provider.fallback ?? fallback
    }
  };
}

type AgentEditorModalProps = {
  open: boolean;
  busy: boolean;
  draft: Draft;
  isEditing: boolean;
  advancedOpen: boolean;
  workspaces: WorkspaceSummary[];
  workspacesLoading: boolean;
  providers: ProviderDiscoveryRecord[];
  providerDiscoveryLoading: boolean;
  providerDiscoveryError: string;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleAdvanced: () => void;
  onPresetSelect: (preset: RolePreset) => void;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
};

function AgentEditorModal({
  open,
  busy,
  draft,
  isEditing,
  advancedOpen,
  workspaces,
  workspacesLoading,
  providers,
  providerDiscoveryLoading,
  providerDiscoveryError,
  onClose,
  onSubmit,
  onToggleAdvanced,
  onPresetSelect,
  setDraft
}: AgentEditorModalProps) {
  const activePreset = rolePresetFromRole(draft.role);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === draft.workspaceId) ?? null;
  const selectedVendor = providers.find((provider) => provider.vendor === draft.provider.vendor);
  const selectedTransport = selectedVendor?.transports.find((entry) => entry.transport === draft.provider.transport) ?? null;
  const selectedProfiles = selectedTransport?.profiles ?? [];
  const providerStatusLabel = providerDiscoveryBadgeLabel(selectedTransport);
  const providerStatusSummary = providerDiscoverySummaryLabel(selectedTransport);
  const providerStatusExplanation = providerDiscoveryExplanation(selectedTransport);
  const providerOptions = providers.length > 0
    ? providers.map((record) => record.vendor)
    : PROVIDER_DISCOVERY_ORDER;
  const transportOptions = selectedVendor?.transports.map((entry) => entry.transport) ?? TRANSPORT_OPTIONS;

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      ariaLabel={isEditing ? "Edit agent" : "Create agent"}
      overlayClassName="z-50 overflow-y-auto overscroll-contain bg-slate-950/85 p-4 md:p-6"
      containerClassName="items-start py-4 md:py-8"
      panelClassName="my-0 w-full max-w-4xl max-h-[calc(100vh-4rem)] overflow-y-auto p-6"
    >
      <form onSubmit={onSubmit} className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-white">{isEditing ? "Edit Agent" : "Create Agent"}</h3>
            <p className="mt-1 text-sm text-slate-400">
              Start with a role and workspace. Routing details stay tucked away unless you need to override them.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-300"
          >
            Close
          </button>
        </div>

        {workspacesLoading ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-5 text-sm text-slate-400">
            Loading workspaces...
          </div>
        ) : workspaces.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/35 p-6">
            <div className="text-sm font-semibold text-white">Add a workspace first</div>
            <div className="mt-2 text-sm text-slate-400">
              Agents are saved inside a workspace. Add a local repo first, then come back to create routing.
            </div>
            <div className="mt-4">
              <Link
                href="/workspaces?intent=add"
                className="inline-flex rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-200"
              >
                Open Workspaces
              </Link>
            </div>
          </div>
        ) : (
          <>
            <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/35 p-5">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Basic</div>
                  <div className="mt-2 text-sm text-slate-400">Choose where this agent lives and what its main job is.</div>
                </div>

                <div>
                  <label className="text-xs text-slate-400">Workspace</label>
                  {isEditing ? (
                    <div className="mt-2 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
                      <div className="text-sm font-medium text-white">{selectedWorkspace?.name || draft.workspaceId}</div>
                      <div className="mt-1 text-xs text-slate-500">Workspace is fixed for existing agents in this version.</div>
                    </div>
                  ) : (
                    <select
                      value={draft.workspaceId}
                      onChange={(event) => setDraft((prev) => ({ ...prev, workspaceId: event.target.value }))}
                      className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                    >
                      <option value="">Select workspace</option>
                      {workspaces.map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>
                          {workspace.name || workspace.id}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="text-xs text-slate-400">Role</label>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    {roleSuggestions.map((suggestion) => {
                      const selected = activePreset === suggestion.preset;
                      return (
                        <button
                          key={suggestion.preset}
                          type="button"
                          onClick={() => onPresetSelect(suggestion.preset)}
                          className={joinClasses(
                            "rounded-xl border p-4 text-left transition",
                            selected
                              ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                              : "border-slate-800 bg-slate-900/30 text-slate-300 hover:border-slate-700"
                          )}
                        >
                          <div className="text-sm font-medium">{suggestion.label}</div>
                          <div className="mt-1 text-xs text-slate-500">{suggestion.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {activePreset === "custom" && (
                  <div>
                    <label className="text-xs text-slate-400">Role key</label>
                    <input
                      value={draft.role}
                      onChange={(event) => setDraft((prev) => ({ ...prev, role: event.target.value }))}
                      placeholder="research, qa, security"
                      className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                    />
                    <div className="mt-2 text-xs text-slate-500">Use a short role key. This is what missions and presets will reference later.</div>
                  </div>
                )}

                <div>
                  <label className="text-xs text-slate-400">Agent name</label>
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                    className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-5">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Default routing</div>
                <div className="mt-2 text-sm text-slate-400">
                  Orchestrum will prefer local tools first. Open Advanced only if you want to override the default route.
                </div>

                <div className="mt-4">
                  {!draft.workspaceId ? (
                    <div className="rounded-xl border border-slate-800 bg-slate-900/35 p-4 text-sm text-slate-400">
                      Choose a workspace to inspect available local providers for this agent.
                    </div>
                  ) : providerDiscoveryLoading ? (
                    <ProviderDiscoveryLoadingState variant="compact" />
                  ) : providerDiscoveryError ? (
                    <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4">
                      <div className="text-sm font-medium text-amber-100">Provider discovery hit a problem</div>
                      <div className="mt-2 text-xs text-amber-100/80">{providerDiscoveryError}</div>
                      <div className="mt-3 text-xs text-slate-300">
                        You can still save the agent and override routing manually below.
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-800 bg-slate-900/35 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-white">{providerSummary(draft.provider)}</div>
                          <div className="mt-1 text-xs text-slate-500">{profileLabel(selectedVendor, draft.provider)}</div>
                        </div>
                        <span className={joinClasses(
                          "rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.15em]",
                          selectedTransport && providerStatusLabel === "Usable now"
                            ? "bg-emerald-400/10 text-emerald-300"
                            : selectedTransport && providerStatusLabel === "Needs setup"
                              ? "bg-amber-400/10 text-amber-300"
                              : "bg-slate-800 text-slate-400"
                        )}>
                          {providerStatusLabel}
                        </span>
                      </div>
                      <div className="mt-3 text-xs text-slate-300">{providerStatusSummary}</div>
                      <div className="mt-2 text-xs text-slate-500">{providerStatusExplanation}</div>
                      {draft.provider.fallback && (
                        <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
                          Fallback: {providerSummary(draft.provider.fallback)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-950/35">
              <button
                type="button"
                onClick={onToggleAdvanced}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
              >
                <div>
                  <div className="text-sm font-medium text-white">Advanced settings</div>
                  <div className="mt-1 text-xs text-slate-500">Tags, routing overrides, and permissions for power users.</div>
                </div>
                <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                  {advancedOpen ? "Hide" : "Show"}
                </span>
              </button>

              {advancedOpen && (
                <div className="space-y-5 border-t border-slate-800 px-5 py-5">
                  <div>
                    <label className="text-xs text-slate-400">Tags</label>
                    <input
                      value={draft.tags}
                      onChange={(event) => setDraft((prev) => ({ ...prev, tags: event.target.value }))}
                      placeholder="pm, delivery, frontend"
                      className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                    />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
                      <div>
                        <div className="text-xs font-medium text-white">Routing override</div>
                        <div className="mt-1 text-xs text-slate-500">
                          Use this only if the default route is not what you want.
                        </div>
                      </div>

                      <div>
                        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Vendor</label>
                        <select
                          value={draft.provider.vendor}
                          onChange={(event) => setDraft((prev) => applyProviderSelection(prev, providers, event.target.value as ProviderVendor))}
                          className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                        >
                          {providerOptions.map((vendor) => (
                            <option key={vendor} value={vendor}>
                              {vendorLabel(vendor)}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Transport</label>
                        <select
                          value={draft.provider.transport}
                          onChange={(event) => setDraft((prev) => applyProviderSelection(prev, providers, prev.provider.vendor, event.target.value as ProviderTransport))}
                          className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                        >
                          {transportOptions.map((transport) => (
                            <option key={transport} value={transport}>
                              {transportLabel(transport)}
                            </option>
                          ))}
                        </select>
                      </div>

                      {selectedProfiles.length > 0 ? (
                        <div>
                          <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Profile</label>
                          <select
                            value={draft.provider.profileId ?? ""}
                            onChange={(event) => {
                              const nextProfile = selectedProfiles.find((profile) => profile.id === event.target.value);
                              setDraft((prev) => ({
                                ...prev,
                                provider: {
                                  ...prev.provider,
                                  profileId: event.target.value || undefined,
                                  modelOverride: nextProfile?.model ?? prev.provider.modelOverride
                                }
                              }));
                            }}
                            className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                          >
                            <option value="">Default profile</option>
                            {selectedProfiles.map((profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div>
                          <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Profile</label>
                          <input
                            value={draft.provider.profileId ?? ""}
                            onChange={(event) => setDraft((prev) => ({
                              ...prev,
                              provider: { ...prev.provider, profileId: event.target.value || undefined }
                            }))}
                            placeholder="profile-id"
                            className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                          />
                        </div>
                      )}

                      <div>
                        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Model override</label>
                        <input
                          value={draft.provider.modelOverride ?? ""}
                          onChange={(event) => setDraft((prev) => ({
                            ...prev,
                            provider: { ...prev.provider, modelOverride: event.target.value || undefined }
                          }))}
                          placeholder={profileLabel(selectedVendor, draft.provider)}
                          className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                        />
                      </div>

                      <div>
                        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Reasoning effort</label>
                        <select
                          value={draft.provider.effort ?? "medium"}
                          onChange={(event) => setDraft((prev) => ({
                            ...prev,
                            provider: { ...prev.provider, effort: event.target.value as ProviderEffort }
                          }))}
                          className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                        >
                          {EFFORT_OPTIONS.map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                            </option>
                          ))}
                        </select>
                        <div className="mt-2 text-[11px] text-slate-500">Only used when the selected provider transport supports effort controls.</div>
                      </div>
                    </div>

                    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
                      <div>
                        <div className="text-xs font-medium text-white">Permissions</div>
                        <div className="mt-1 text-xs text-slate-500">
                          Keep these tight. They directly control how much this agent can do on your machine.
                        </div>
                      </div>

                      <div className="space-y-3">
                        {permissionOptions.map((option) => (
                          <label key={option.key} className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3">
                            <input
                              type="checkbox"
                              checked={draft.capabilities[option.key]}
                              onChange={(event) => setDraft((prev) => ({
                                ...prev,
                                capabilities: { ...prev.capabilities, [option.key]: event.target.checked }
                              }))}
                              className="mt-1"
                            />
                            <span>
                              <span className="block text-sm font-medium text-white">{option.label}</span>
                              <span className="mt-1 block text-xs text-slate-500">{option.description}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-4 py-2 text-xs uppercase tracking-[0.15em] text-slate-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || workspacesLoading || workspaces.length === 0}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-200 disabled:opacity-50"
          >
            {busy ? "Saving..." : isEditing ? "Update Agent" : "Create Agent"}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

export default function AgentsPage() {
  const searchParams = useSearchParams();
  const { pushToast, selectedWorkspaceId, setSelectedWorkspaceId } = useAppUi();
  const confirm = useConfirm();
  const { data: workspaces = [], isLoading: workspacesLoading } = useWorkspaces();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<Draft>(createDraft());
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const seededIntentKeyRef = useRef("");
  const {
    providers,
    isLoading: providerDiscoveryLoading,
    error: providerDiscoveryError
  } = useProviderDiscovery({
    scope: "workspace",
    workspaceId: selectedWorkspaceId,
    enabled: Boolean(selectedWorkspaceId)
  });
  const {
    providers: editorProviders,
    isLoading: editorProviderDiscoveryLoading,
    error: editorProviderDiscoveryError
  } = useProviderDiscovery({
    scope: "workspace",
    workspaceId: draft.workspaceId,
    enabled: editorOpen && Boolean(draft.workspaceId)
  });

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  );

  const loadAgentsForWorkspace = useCallback(async (workspaceId: string) => {
    const res = await fetch(`/api/agents?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({ agents: [] }));
    setAgents(Array.isArray(data.agents) ? data.agents : []);
  }, []);

  useEffect(() => {
    const workspaceParam = searchParams.get("workspace");
    if (!workspaceParam || workspaceParam === selectedWorkspaceId) return;
    setSelectedWorkspaceId(workspaceParam);
  }, [searchParams, selectedWorkspaceId, setSelectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setAgents([]);
      return;
    }
    void loadAgentsForWorkspace(selectedWorkspaceId);
    const timer = setInterval(() => {
      void loadAgentsForWorkspace(selectedWorkspaceId);
    }, 4000);
    return () => clearInterval(timer);
  }, [loadAgentsForWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    const intent = searchParams.get("intent");
    if (intent !== "create") return;

    const presetParam = searchParams.get("preset");
    const preset: RolePreset =
      presetParam === "pm" || presetParam === "dev" || presetParam === "audit" || presetParam === "custom"
        ? presetParam
        : "dev";
    const workspaceParam = searchParams.get("workspace") ?? selectedWorkspaceId ?? "";
    const seedKey = `${intent}:${preset}:${workspaceParam}`;

    if (seededIntentKeyRef.current === seedKey) return;

    setEditingId("");
    setAdvancedOpen(false);
    setDraft(createDraft(workspaceParam, preset));
    setEditorOpen(true);
    seededIntentKeyRef.current = seedKey;
  }, [searchParams, selectedWorkspaceId]);

  const resetEditor = useCallback((workspaceId = selectedWorkspaceId) => {
    setEditingId("");
    setAdvancedOpen(false);
    setDraft(createDraft(workspaceId || ""));
    setEditorOpen(false);
  }, [selectedWorkspaceId]);

  const openCreateEditor = useCallback((preset: RolePreset = "dev") => {
    setEditingId("");
    setAdvancedOpen(false);
    setDraft(createDraft(selectedWorkspaceId || "", preset));
    setEditorOpen(true);
  }, [selectedWorkspaceId]);

  const handlePresetSelect = useCallback((preset: RolePreset) => {
    setDraft((prev) => applyPresetToDraft(prev, preset));
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.workspaceId) {
      pushToast({ tone: "warning", title: "Select a workspace first" });
      return;
    }
    if (!draft.role.trim()) {
      pushToast({ tone: "warning", title: "Enter a role key" });
      return;
    }
    if (!draft.name.trim()) {
      pushToast({ tone: "warning", title: "Agent name is required" });
      return;
    }

    setBusy(true);
    const payload = {
      workspaceId: draft.workspaceId,
      name: draft.name.trim(),
      role: draft.role.trim(),
      tags: draft.tags.split(",").map((item) => item.trim()).filter(Boolean),
      provider: draft.provider,
      capabilities: draft.capabilities
    };

    const endpoint = editingId ? `/api/agents/${editingId}` : "/api/agents";
    const method = editingId ? "PATCH" : "POST";
    const res = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      pushToast({ tone: "warning", title: "Agent save failed", message: data.error ?? "Unable to save agent." });
      return;
    }

    setSelectedWorkspaceId(payload.workspaceId);
    pushToast({
      tone: "success",
      title: editingId ? "Agent updated" : "Agent created",
      message: payload.name
    });
    resetEditor(payload.workspaceId);
    await loadAgentsForWorkspace(payload.workspaceId);
  };

  const edit = (agent: Agent) => {
    setEditingId(agent.id);
    setAdvancedOpen(false);
    setDraft(createDraftFromAgent(agent));
    setEditorOpen(true);
  };

  const remove = async (id: string) => {
    const agent = agents.find((item) => item.id === id);
    const confirmed = await confirm({
      title: "Remove Agent",
      message: `Are you sure you want to remove "${agent?.name ?? id}"? This cannot be undone.`,
      confirmLabel: "Remove",
      tone: "danger"
    });
    if (!confirmed) return;
    await fetch(`/api/agents/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: selectedWorkspaceId })
    });
    pushToast({ tone: "info", title: "Agent removed" });
    if (selectedWorkspaceId) {
      await loadAgentsForWorkspace(selectedWorkspaceId);
    }
  };

  return (
    <main className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Agents</h2>
          <p className="text-sm text-slate-400">
            Create workspace agents with automatic local-provider routing and only open advanced settings when you need them.
          </p>
        </div>
        <button
          onClick={() => openCreateEditor("dev")}
          className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-amber-200"
        >
          + Add Agent
        </button>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Workspace status</div>
          {!selectedWorkspaceId ? (
            <>
              <div className="mt-2 text-sm font-medium text-white">No workspace selected</div>
              <div className="mt-2 text-sm text-slate-400">
                Pick a workspace from the header to browse existing agents, or choose one directly inside the create modal.
              </div>
            </>
          ) : (
            <>
              <div className="mt-2 text-sm font-medium text-white">{selectedWorkspace?.name || selectedWorkspaceId}</div>
              <div className="mt-1 text-xs text-slate-500 break-all">{selectedWorkspace?.path || "Workspace selected in header"}</div>
              <div className="mt-3 text-xs text-slate-400">
                Agent list and provider routing on this page are scoped to the selected workspace.
              </div>
            </>
          )}
        </div>

        {!selectedWorkspaceId ? (
          <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 p-5">
            <div className="text-sm font-medium text-white">Local routing summary will appear here</div>
            <div className="mt-2 text-sm text-slate-400">
              Once a workspace is selected, Orchestrum will summarize which local CLI or runtime paths are ready.
            </div>
          </div>
        ) : providerDiscoveryLoading ? (
          <ProviderDiscoveryLoadingState variant="compact" />
        ) : providerDiscoveryError ? (
          <section className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5">
            <div className="text-sm font-semibold text-rose-100">Provider discovery failed</div>
            <div className="mt-2 text-xs text-rose-100/80">{providerDiscoveryError}</div>
          </section>
        ) : providers.length > 0 ? (
          <ProviderDiscoveryStatusSummary providers={providers} variant="compact" />
        ) : (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-5 text-sm text-slate-400">
            No providers detected for this workspace yet. You can still create an agent and adjust routing later.
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white">Quick start roles</div>
            <div className="mt-1 text-sm text-slate-400">Start from a sensible default, then open Advanced only if you need overrides.</div>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {roleSuggestions.map((suggestion) => (
            <button
              key={suggestion.preset}
              onClick={() => openCreateEditor(suggestion.preset)}
              className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-left transition hover:border-amber-400/40"
            >
              <div className="text-sm font-medium text-white">{suggestion.label}</div>
              <div className="mt-2 text-xs text-slate-500">{suggestion.desc}</div>
            </button>
          ))}
        </div>
      </section>

      {!selectedWorkspaceId ? (
        <section className="rounded-2xl border border-dashed border-slate-700 p-8 text-center">
          <h3 className="text-lg font-semibold text-white">Select a workspace to inspect existing agents</h3>
          <p className="mt-2 text-sm text-slate-400">
            You can still create a new agent now. Existing agents will appear here after you choose a workspace from the header.
          </p>
        </section>
      ) : agents.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-slate-700 p-8 text-center">
          <h3 className="text-lg font-semibold text-white">No agents in this workspace yet</h3>
          <p className="mt-2 text-sm text-slate-400">
            Use one of the role presets above or open the create modal and customize the defaults.
          </p>
        </section>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => {
            const record = providers.find((provider) => provider.vendor === agent.provider.vendor);
            return (
              <div key={agent.id} className="group rounded-xl border border-slate-800 bg-slate-950/40 p-4 transition hover:border-slate-700">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`h-2.5 w-2.5 rounded-full ${stateColor(agent.status.state)}`} />
                    <div>
                      <div className="text-sm font-semibold text-white">{agent.name}</div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{displayRole(agent.role)}</div>
                    </div>
                  </div>
                  <div className={`text-[10px] uppercase tracking-widest ${stateLabel(agent.status.state)}`}>
                    {agent.status.state}
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/30 p-3 text-[11px] text-slate-400">
                  <div className="font-medium text-slate-200">{providerSummary(agent.provider)}</div>
                  <div className="mt-1">{profileLabel(record, agent.provider)}</div>
                  {agent.provider.fallback && <div className="mt-1 text-slate-500">Fallback: {providerSummary(agent.provider.fallback)}</div>}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-slate-400">
                  {permissionOptions
                    .filter((option) => agent.capabilities[option.key])
                    .map((option) => (
                      <span key={option.key} className="rounded bg-slate-800/60 px-1.5 py-0.5">
                        {capabilityBadgeLabel(option.key)}
                      </span>
                    ))}
                </div>

                <div className="mt-3 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => edit(agent)}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-slate-600"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void remove(agent.id)}
                    className="rounded-md border border-rose-500/30 px-2 py-1 text-[10px] text-rose-300 hover:border-rose-500/50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <AgentEditorModal
        open={editorOpen}
        busy={busy}
        draft={draft}
        isEditing={Boolean(editingId)}
        advancedOpen={advancedOpen}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        providers={editorProviders}
        providerDiscoveryLoading={editorProviderDiscoveryLoading}
        providerDiscoveryError={editorProviderDiscoveryError}
        onClose={() => resetEditor()}
        onSubmit={save}
        onToggleAdvanced={() => setAdvancedOpen((prev) => !prev)}
        onPresetSelect={handlePresetSelect}
        setDraft={setDraft}
      />
    </main>
  );
}
