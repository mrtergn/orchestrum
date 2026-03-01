"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const DONE_KEY = "orchestrum.agentOnboarded";

type Agent = { id: string; name: string; role: string };

export function AgentOnboarding() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);

  const loadAgents = async () => {
    const res = await fetch("/api/agents", { cache: "no-store" });
    const data = await res.json().catch(() => ({ agents: [] }));
    setAgents(Array.isArray(data.agents) ? data.agents : []);
  };

  useEffect(() => {
    const init = async () => {
      const done = localStorage.getItem(DONE_KEY) === "1";
      if (done) return;
      await loadAgents();
      setOpen(true);
    };
    void init();
  }, []);

  const saveProvider = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    await fetch("/api/secrets/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyName: "OPENAI_API_KEY", value: apiKey.trim(), scope: "global" })
    });
    setBusy(false);
    setStep(2);
  };

  const createDefaultAgents = async () => {
    setBusy(true);
    const presets = [
      { name: "PM Agent", role: "pm", model: "gpt-4.1-mini" },
      { name: "Dev Agent", role: "dev", model: "gpt-4.1-mini" },
      { name: "Audit Agent", role: "audit", model: "gpt-4.1-mini" }
    ];
    for (const preset of presets) {
      await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: preset.name,
          role: preset.role,
          tags: [preset.role],
          provider: { type: "openai", model: preset.model, apiKeyRef: "OPENAI_API_KEY" },
          capabilities: { shell: false, fs: true, network: true }
        })
      });
    }
    await loadAgents();
    setBusy(false);
    setStep(3);
  };

  const createOrg = async () => {
    setBusy(true);
    const listRes = await fetch("/api/agents", { cache: "no-store" });
    const listData = await listRes.json().catch(() => ({ agents: [] }));
    const list: Agent[] = Array.isArray(listData.agents) ? listData.agents : [];
    const pm = list.find((agent) => agent.role.toLowerCase().includes("pm")) ?? list[0];
    const dev = list.find((agent) => agent.role.toLowerCase().includes("dev"));
    const audit = list.find((agent) => agent.role.toLowerCase().includes("audit"));
    const nodes = [
      pm
        ? { id: crypto.randomUUID(), agentId: pm.id, x: 320, y: 80, position: "Head" }
        : null,
      dev && pm ? { id: crypto.randomUUID(), agentId: dev.id, parentId: pm.id, x: 180, y: 220, position: "Engineer" } : null,
      audit && pm
        ? { id: crypto.randomUUID(), agentId: audit.id, parentId: pm.id, x: 460, y: 220, position: "Reviewer" }
        : null
    ].filter(Boolean);
    await fetch("/api/org", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes })
    });
    setBusy(false);
    setStep(4);
  };

  const createDemoTask = async () => {
    setBusy(true);
    const devAgent = agents.find((agent) => agent.role.toLowerCase().includes("dev")) ?? agents[0];
    if (devAgent) {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Demo Implement Task",
          description: "Create a small implementation diff for onboarding verification.",
          type: "implement",
          assignedToAgentId: devAgent.id,
          payload: {}
        })
      });
    }
    setBusy(false);
    localStorage.setItem(DONE_KEY, "1");
    setOpen(false);
    router.push("/mission");
  };

  if (!open) return null;

  const stages = [
    { id: 1, title: "Model Access", subtitle: "Store provider key" },
    { id: 2, title: "Team Seeds", subtitle: "Create starter agents" },
    { id: 3, title: "Command Chain", subtitle: "Wire reporting lines" },
    { id: 4, title: "Live Pulse", subtitle: "Queue first mission" }
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-6">
      <div className="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-950 p-7">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-white">Orchestrum Studio Bootstrap</h2>
            <p className="mt-1 text-sm text-slate-400">Build your first autonomous pod in four fast steps.</p>
          </div>
          <div className="text-xs text-slate-500">Stage {step}/4</div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-4">
          {stages.map((stage) => {
            const active = stage.id === step;
            const done = stage.id < step;
            return (
              <div
                key={stage.id}
                className={`rounded-xl border px-3 py-3 ${
                  active
                    ? "border-cyan-400/60 bg-cyan-400/10"
                    : done
                      ? "border-emerald-400/40 bg-emerald-400/10"
                      : "border-slate-800 bg-slate-900/40"
                }`}
              >
                <div className="text-[10px] uppercase tracking-[0.25em] text-slate-400">Stage {stage.id}</div>
                <div className="mt-1 text-sm font-medium text-white">{stage.title}</div>
                <div className="text-xs text-slate-400">{stage.subtitle}</div>
              </div>
            );
          })}
        </div>

        {step === 1 && (
          <div className="mt-6 space-y-3">
            <div className="text-sm text-slate-300">Store one provider credential to activate managed runs.</div>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              placeholder="OPENAI_API_KEY"
              className="w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200"
            />
            <button
              onClick={() => void saveProvider()}
              disabled={busy || !apiKey.trim()}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-amber-200 disabled:opacity-50"
            >
              {busy ? "Saving..." : "Enable Model Access"}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="mt-6 space-y-3">
            <div className="text-sm text-slate-300">Generate a starter pod: Planner, Builder, Reviewer.</div>
            <button
              onClick={() => void createDefaultAgents()}
              disabled={busy}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-amber-200 disabled:opacity-50"
            >
              {busy ? "Creating..." : "Seed Team"}
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="mt-6 space-y-3">
            <div className="text-sm text-slate-300">Link the team into a command chain with default reporting lines.</div>
            <button
              onClick={() => void createOrg()}
              disabled={busy}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-amber-200 disabled:opacity-50"
            >
              {busy ? "Building..." : "Wire Command Chain"}
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="mt-6 space-y-3">
            <div className="text-sm text-slate-300">Queue a first mission and switch to live mission control.</div>
            <button
              onClick={() => void createDemoTask()}
              disabled={busy}
              className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs uppercase tracking-[0.25em] text-emerald-200 disabled:opacity-50"
            >
              {busy ? "Queuing..." : "Launch First Mission"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
