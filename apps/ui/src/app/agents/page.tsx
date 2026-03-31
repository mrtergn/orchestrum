"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  defaultProviderForRole,
  preferredTransport,
  profileLabel,
  providerSummary,
  transportLabel,
  vendorLabel,
  type ProviderDiscoveryRecord,
  type ProviderDiscoveryTransport,
  type ProviderSpec,
  type ProviderTransport,
  type ProviderVendor
} from "@/lib/providers";

type Agent = {
  id: string;
  name: string;
  role: string;
  tags: string[];
  provider: ProviderSpec;
  capabilities: { shell: boolean; fs: boolean; network: boolean };
  status: { state: string; currentTaskId?: string; lastHeartbeatAt: string };
};

type DiscoveryPayload = {
  providers?: ProviderDiscoveryRecord[];
};

type Draft = {
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

const roleSuggestions = [
  { role: "pm", label: "PM", desc: "Plans specs, coordinates work", icon: "📋" },
  { role: "dev", label: "Developer", desc: "Writes and edits code", icon: "⌨️" },
  { role: "audit", label: "Auditor", desc: "Reviews code and risks", icon: "🔍" }
];

function createDraft(role = ""): Draft {
  const provider = defaultProviderForRole(role || "pm");
  return {
    name: "",
    role: role || "",
    tags: "",
    provider,
    capabilities: {
      shell: false,
      fs: true,
      network: true
    }
  };
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

export default function AgentsPage() {
  const { pushToast, selectedWorkspaceId } = useAppUi();
  const confirm = useConfirm();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<ProviderDiscoveryRecord[]>([]);
  const [draft, setDraft] = useState<Draft>(createDraft());
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const loadAgents = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setAgents([]);
      return;
    }
    const res = await fetch(`/api/agents?workspace=${encodeURIComponent(selectedWorkspaceId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({ agents: [] }));
    setAgents(Array.isArray(data.agents) ? data.agents : []);
  }, [selectedWorkspaceId]);

  const loadProviders = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setProviders([]);
      return;
    }
    const res = await fetch(`/api/providers/discover?scope=workspace&workspace=${encodeURIComponent(selectedWorkspaceId)}`, {
      cache: "no-store"
    });
    const data = (res.ok ? await res.json() : { providers: [] }) as DiscoveryPayload;
    setProviders(Array.isArray(data.providers) ? data.providers : []);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    void Promise.all([loadAgents(), loadProviders()]);
    const timer = setInterval(() => {
      void loadAgents();
    }, 4000);
    return () => clearInterval(timer);
  }, [loadAgents, loadProviders]);

  const selectedVendor = useMemo(
    () => providers.find((provider) => provider.vendor === draft.provider.vendor),
    [draft.provider.vendor, providers]
  );
  const selectedTransport = useMemo(
    () => selectedVendor?.transports.find((entry) => entry.transport === draft.provider.transport) ?? null,
    [draft.provider.transport, selectedVendor]
  );
  const profileOptions = selectedTransport?.profiles ?? [];

  const syncProvider = useCallback((vendor: ProviderVendor, transport?: ProviderTransport) => {
    setDraft((prev) => {
      const role = prev.role || "general";
      const vendorRecord = providers.find((entry) => entry.vendor === vendor);
      const nextTransportRecord = transport
        ? vendorRecord?.transports.find((entry) => entry.transport === transport)
        : preferredTransport(vendorRecord ?? { vendor, label: vendorLabel(vendor), transports: [], preferredTransport: null });
      const nextTransport = nextTransportRecord?.transport ?? transport ?? prev.provider.transport;
      const nextProfile = nextTransportRecord?.profiles.find((profile) => profile.recommended) ?? nextTransportRecord?.profiles[0];
      const fallback = defaultProviderForRole(role).fallback ?? null;
      return {
        ...prev,
        provider: {
          vendor,
          transport: nextTransport,
          profileId: nextProfile?.id,
          modelOverride: prev.provider.modelOverride ?? nextProfile?.model,
          effort: nextTransportRecord?.capabilities.supportsEffort ? (prev.provider.effort ?? "medium") : undefined,
          auth: nextTransport === "cli"
            ? { kind: "cli" }
            : nextTransport === "api"
              ? { kind: "api_key", secretRef: vendor === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY" }
              : { kind: "none" },
          fallback: fallback && fallback.vendor !== vendor ? fallback : prev.provider.fallback ?? fallback
        }
      };
    });
  }, [providers]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedWorkspaceId) {
      pushToast({ tone: "warning", title: "Select a workspace first" });
      return;
    }
    setBusy(true);
    const payload = {
      workspaceId: selectedWorkspaceId,
      name: draft.name,
      role: draft.role,
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
    setDraft(createDraft());
    setEditingId("");
    setShowForm(false);
    pushToast({ tone: "success", title: editingId ? "Agent updated" : "Agent created", message: payload.name });
    await loadAgents();
  };

  const edit = (agent: Agent) => {
    setEditingId(agent.id);
    setDraft({
      name: agent.name,
      role: agent.role,
      tags: agent.tags.join(", "),
      provider: agent.provider,
      capabilities: agent.capabilities
    });
    setShowForm(true);
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
    await loadAgents();
  };

  const applyQuickRole = (role: string) => {
    const base = createDraft(role);
    const label = role === "pm" ? "PM Agent" : role === "dev" ? "Dev Agent" : role === "audit" ? "Audit Agent" : "Agent";
    setDraft({ ...base, name: label, role });
    setShowForm(true);
  };

  const transportBadge = (transport: ProviderDiscoveryTransport | null) => {
    if (!transport) return "No transport";
    if (transport.configured) return `${transportLabel(transport.transport)} ready`;
    if (transport.available) return `${transportLabel(transport.transport)} available`;
    return `${transportLabel(transport.transport)} unavailable`;
  };

  return (
    <main className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Agents</h2>
          <p className="text-sm text-slate-400">
            {agents.length === 0
              ? "Create workspace agents with CLI-first provider routing."
              : `${agents.length} agent${agents.length !== 1 ? "s" : ""} registered`}
          </p>
        </div>
        <button
          onClick={() => {
            setEditingId("");
            setDraft(createDraft());
            setShowForm(true);
          }}
          className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-amber-200"
        >
          + Add Agent
        </button>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {providers.map((record) => {
          const transport = preferredTransport(record);
          return (
            <div key={record.vendor} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">{record.label}</div>
                  <div className="mt-1 text-[11px] text-slate-500">{transportBadge(transport)}</div>
                </div>
                <button
                  onClick={() => {
                    syncProvider(record.vendor, transport?.transport);
                    setShowForm(true);
                  }}
                  className="rounded-md border border-slate-700 px-2 py-1 text-[10px] text-slate-300"
                >
                  Use
                </button>
              </div>
              <div className="mt-3 space-y-1 text-[11px] text-slate-500">
                {record.transports.map((entry) => (
                  <div key={`${record.vendor}-${entry.transport}`} className="flex items-center justify-between rounded-lg bg-slate-900/30 px-2.5 py-1.5">
                    <span>{transportLabel(entry.transport)}</span>
                    <span className={entry.configured ? "text-emerald-300" : entry.available ? "text-amber-300" : "text-slate-600"}>
                      {entry.configured ? "ready" : entry.available ? "available" : "off"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      {agents.length === 0 && !showForm && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-8">
          <div className="text-center">
            <div className="text-2xl">◆</div>
            <h3 className="mt-2 text-lg font-semibold text-white">No agents yet</h3>
            <p className="mt-1 text-sm text-slate-400">Pick a role to scaffold a CLI-first agent configuration.</p>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {roleSuggestions.map((suggestion) => (
              <button
                key={suggestion.role}
                onClick={() => applyQuickRole(suggestion.role)}
                className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 text-left transition hover:border-amber-400/40"
              >
                <div className="text-lg">{suggestion.icon}</div>
                <div className="mt-1 text-sm font-medium text-white">{suggestion.label}</div>
                <div className="mt-1 text-xs text-slate-500">{suggestion.desc}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {showForm && (
        <form onSubmit={save} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">{editingId ? "Edit Agent" : "Create Agent"}</h3>
              <p className="mt-1 text-xs text-slate-500">Choose vendor, transport, profile, and optional override fields.</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setEditingId("");
                setDraft(createDraft());
              }}
              className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300"
            >
              Close
            </button>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Name</label>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Role</label>
                <input
                  value={draft.role}
                  onChange={(event) => {
                    const role = event.target.value;
                    setDraft((prev) => ({ ...prev, role }));
                    if (!editingId) {
                      const next = defaultProviderForRole(role || "general");
                      setDraft((prev) => ({ ...prev, role, provider: next }));
                    }
                  }}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Tags</label>
                <input
                  value={draft.tags}
                  onChange={(event) => setDraft((prev) => ({ ...prev, tags: event.target.value }))}
                  placeholder="pm, product, planner"
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-200"
                />
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Vendor</label>
                <select
                  value={draft.provider.vendor}
                  onChange={(event) => syncProvider(event.target.value as ProviderVendor)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                >
                  {providers.map((record) => (
                    <option key={record.vendor} value={record.vendor}>
                      {record.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Transport</label>
                <select
                  value={draft.provider.transport}
                  onChange={(event) => syncProvider(draft.provider.vendor, event.target.value as ProviderTransport)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                >
                  {(selectedVendor?.transports ?? []).map((transport) => (
                    <option key={transport.transport} value={transport.transport}>
                      {transportLabel(transport.transport)}
                    </option>
                  ))}
                </select>
                {selectedTransport?.reason && (
                  <div className="mt-2 text-[11px] text-slate-500">{selectedTransport.reason}</div>
                )}
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Profile</label>
                <select
                  value={draft.provider.profileId ?? ""}
                  onChange={(event) => {
                    const nextProfile = profileOptions.find((profile) => profile.id === event.target.value);
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
                  {profileOptions.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Model Override</label>
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
              {selectedTransport?.capabilities.supportsEffort && (
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Effort</label>
                  <select
                    value={draft.provider.effort ?? "medium"}
                    onChange={(event) => setDraft((prev) => ({
                      ...prev,
                      provider: { ...prev.provider, effort: event.target.value as Draft["provider"]["effort"] }
                    }))}
                    className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="max">max</option>
                  </select>
                </div>
              )}
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-[11px] text-slate-500">
                Primary: {providerSummary(draft.provider)}
                {draft.provider.fallback && <div className="mt-1">Fallback: {providerSummary(draft.provider.fallback)}</div>}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-5 text-xs text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.capabilities.shell}
                onChange={(event) => setDraft((prev) => ({ ...prev, capabilities: { ...prev.capabilities, shell: event.target.checked } }))}
              />
              shell
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.capabilities.fs}
                onChange={(event) => setDraft((prev) => ({ ...prev, capabilities: { ...prev.capabilities, fs: event.target.checked } }))}
              />
              fs
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.capabilities.network}
                onChange={(event) => setDraft((prev) => ({ ...prev, capabilities: { ...prev.capabilities, network: event.target.checked } }))}
              />
              network
            </label>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-200 disabled:opacity-50"
            >
              {busy ? "Saving..." : editingId ? "Update Agent" : "Create Agent"}
            </button>
          </div>
        </form>
      )}

      {agents.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => {
            const record = providers.find((provider) => provider.vendor === agent.provider.vendor);
            return (
              <div key={agent.id} className="group rounded-xl border border-slate-800 bg-slate-950/40 p-4 transition hover:border-slate-700">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className={`h-2.5 w-2.5 rounded-full ${stateColor(agent.status.state)}`} />
                    <div>
                      <div className="text-sm font-semibold text-white">{agent.name}</div>
                      <div className="text-[10px] text-slate-500">{agent.role}</div>
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

                <div className="mt-2 flex gap-1.5 text-[10px] text-slate-600">
                  {agent.capabilities.shell && <span className="rounded bg-slate-800/60 px-1.5 py-0.5">shell</span>}
                  {agent.capabilities.fs && <span className="rounded bg-slate-800/60 px-1.5 py-0.5">fs</span>}
                  {agent.capabilities.network && <span className="rounded bg-slate-800/60 px-1.5 py-0.5">net</span>}
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
    </main>
  );
}
