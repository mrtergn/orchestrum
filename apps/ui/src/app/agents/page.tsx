"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { useConfirm } from "@/components/ConfirmDialog";

type Agent = {
  id: string;
  name: string;
  role: string;
  tags: string[];
  provider: { type: "openai" | "claude" | "ollama" | "local"; model: string; apiKeyRef?: string };
  capabilities: { shell: boolean; fs: boolean; network: boolean };
  status: { state: string; currentTaskId?: string; lastHeartbeatAt: string };
};

type Draft = {
  name: string;
  role: string;
  tags: string;
  providerType: "openai" | "claude" | "ollama";
  model: string;
  apiKeyRef: string;
  shell: boolean;
  fs: boolean;
  network: boolean;
};

const emptyDraft: Draft = {
  name: "",
  role: "",
  tags: "",
  providerType: "openai",
  model: "gpt-4.1-mini",
  apiKeyRef: "OPENAI_API_KEY",
  shell: false,
  fs: true,
  network: true
};

const roleSuggestions = [
  { role: "pm", label: "PM", desc: "Plans specs, coordinates tasks", icon: "📋" },
  { role: "dev", label: "Developer", desc: "Writes and edits code", icon: "⌨️" },
  { role: "audit", label: "Auditor", desc: "Reviews code for quality & security", icon: "🔍" },
];

function stateColor(state: string) {
  if (state === "running") return "bg-amber-400";
  if (state === "sleeping" || state === "idle") return "bg-emerald-400";
  return "bg-slate-600";
}

function stateLabel(state: string) {
  if (state === "running") return "text-amber-300";
  if (state === "sleeping" || state === "idle") return "text-emerald-300";
  return "text-slate-500";
}

export default function AgentsPage() {
  const { pushToast } = useAppUi();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const confirm = useConfirm();

  const loadAgents = async () => {
    const res = await fetch("/api/agents", { cache: "no-store" });
    const data = await res.json().catch(() => ({ agents: [] }));
    setAgents(Array.isArray(data.agents) ? data.agents : []);
  };

  useEffect(() => {
    void loadAgents();
    const timer = setInterval(() => void loadAgents(), 4000);
    return () => clearInterval(timer);
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const payload = {
      name: draft.name,
      role: draft.role,
      tags: draft.tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      provider: {
        type: draft.providerType,
        model: draft.model,
        apiKeyRef: draft.providerType === "ollama" ? undefined : draft.apiKeyRef
      },
      capabilities: {
        shell: draft.shell,
        fs: draft.fs,
        network: draft.network
      }
    };

    if (editingId) {
      await fetch(`/api/agents/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
    setDraft(emptyDraft);
    setEditingId("");
    setBusy(false);
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
      providerType: agent.provider.type === "local" ? "ollama" : agent.provider.type,
      model: agent.provider.model,
      apiKeyRef: agent.provider.apiKeyRef ?? "OPENAI_API_KEY",
      shell: agent.capabilities.shell,
      fs: agent.capabilities.fs,
      network: agent.capabilities.network
    });
    setShowForm(true);
  };

  const remove = async (id: string) => {
    const agent = agents.find((a) => a.id === id);
    const confirmed = await confirm({
      title: "Remove Agent",
      message: `Are you sure you want to remove "${agent?.name ?? id}"? This cannot be undone.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    pushToast({ tone: "info", title: "Agent removed" });
    await loadAgents();
  };

  const applyQuickRole = (role: string) => {
    const defaults: Record<string, Partial<Draft>> = {
      pm: { name: "PM Agent", role: "pm" },
      dev: { name: "Dev Agent", role: "dev" },
      audit: { name: "Audit Agent", role: "audit" },
    };
    setDraft((prev) => ({ ...prev, ...defaults[role] }));
    setShowForm(true);
  };

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Agents</h2>
          <p className="text-sm text-slate-400">
            {agents.length === 0
              ? "Create agents to build your autonomous team."
              : `${agents.length} agent${agents.length !== 1 ? "s" : ""} registered`}
          </p>
        </div>
        <button
          onClick={() => { setEditingId(""); setDraft(emptyDraft); setShowForm(true); }}
          className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-amber-200"
        >
          + Add Agent
        </button>
      </section>

      {/* Empty state with role quick-start */}
      {agents.length === 0 && !showForm && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-8">
          <div className="text-center">
            <div className="text-2xl">◆</div>
            <h3 className="mt-2 text-lg font-semibold text-white">No agents yet</h3>
            <p className="mt-1 text-sm text-slate-400">
              Pick a role to quickly scaffold your first agent, or create a custom one.
            </p>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {roleSuggestions.map((rs) => (
              <button
                key={rs.role}
                onClick={() => applyQuickRole(rs.role)}
                className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 text-left transition hover:border-amber-400/40"
              >
                <div className="text-lg">{rs.icon}</div>
                <div className="mt-1 text-sm font-medium text-white">{rs.label}</div>
                <div className="mt-1 text-xs text-slate-500">{rs.desc}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Agent grid */}
      {agents.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="group rounded-xl border border-slate-800 bg-slate-950/40 p-4 transition hover:border-slate-700"
            >
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
              <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-500">
                <span className="rounded bg-slate-800/80 px-1.5 py-0.5">{agent.provider.type}</span>
                <span className="rounded bg-slate-800/80 px-1.5 py-0.5">{agent.provider.model}</span>
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
          ))}
        </section>
      )}

      {/* Add/Edit form - slide-down */}
      {showForm && (
        <section className="rounded-2xl border border-amber-400/20 bg-slate-950/60 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">{editingId ? "Edit Agent" : "New Agent"}</h3>
            <button
              onClick={() => { setShowForm(false); setEditingId(""); setDraft(emptyDraft); }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Cancel
            </button>
          </div>
          <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500">Name</label>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="e.g. PM Agent"
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
                  required
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500">Role</label>
                <input
                  value={draft.role}
                  onChange={(event) => setDraft((prev) => ({ ...prev, role: event.target.value }))}
                  placeholder="pm, dev, audit..."
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
                  required
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500">Tags</label>
                <input
                  value={draft.tags}
                  onChange={(event) => setDraft((prev) => ({ ...prev, tags: event.target.value }))}
                  placeholder="comma separated"
                  className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
                />
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500">Provider</label>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <select
                    value={draft.providerType}
                    onChange={(event) =>
                      setDraft((prev) => {
                        const providerType = event.target.value as "openai" | "claude" | "ollama";
                        const model =
                          providerType === "claude"
                            ? "claude-3-5-sonnet-latest"
                            : providerType === "ollama"
                              ? prev.model || "llama3.1:8b"
                              : "gpt-4.1-mini";
                        const apiKeyRef =
                          providerType === "claude"
                            ? "ANTHROPIC_API_KEY"
                            : providerType === "openai"
                              ? "OPENAI_API_KEY"
                              : "";
                        return { ...prev, providerType, model, apiKeyRef };
                      })
                    }
                    className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="claude">Claude (Anthropic)</option>
                    <option value="ollama">Ollama (Local)</option>
                  </select>
                  <input
                    value={draft.model}
                    onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
                    placeholder="Model name"
                    className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
                  />
                </div>
              </div>
              {draft.providerType !== "ollama" && (
                <div>
                  <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500">API Key Reference</label>
                  <input
                    value={draft.apiKeyRef}
                    onChange={(event) => setDraft((prev) => ({ ...prev, apiKeyRef: event.target.value }))}
                    placeholder="OPENAI_API_KEY"
                    className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
                  />
                </div>
              )}
              <div>
                <label className="text-[10px] uppercase tracking-[0.15em] text-slate-500">Capabilities</label>
                <div className="mt-1 flex gap-4 text-xs text-slate-300">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draft.shell}
                      onChange={(event) => setDraft((prev) => ({ ...prev, shell: event.target.checked }))}
                    />
                    Shell
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draft.fs}
                      onChange={(event) => setDraft((prev) => ({ ...prev, fs: event.target.checked }))}
                    />
                    Filesystem
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draft.network}
                      onChange={(event) => setDraft((prev) => ({ ...prev, network: event.target.checked }))}
                    />
                    Network
                  </label>
                </div>
              </div>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-amber-200 disabled:opacity-50"
              >
                {busy ? "Saving..." : editingId ? "Update Agent" : "Create Agent"}
              </button>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
