"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { useConfirm } from "@/components/ConfirmDialog";

/* ---------- types ---------- */
type Agent = { id: string; name: string; role: string };
type OrgNode = {
  id: string;
  agentId: string;
  parentId?: string;
  department?: string;
  position?: string;
  x?: number;
  y?: number;
};
type TreeNode = OrgNode & { children: TreeNode[] };

/* ---------- role colours ---------- */
const ROLE_COLORS: Record<string, { card: string; badge: string; selected: string; dot: string }> = {
  pm:    { card: "border-violet-500/30 bg-violet-500/5 hover:border-violet-400/50",  badge: "bg-violet-500/20 text-violet-300", selected: "border-violet-400 ring-2 ring-violet-400/20 shadow-lg shadow-violet-500/10", dot: "bg-violet-400" },
  dev:   { card: "border-sky-500/30 bg-sky-500/5 hover:border-sky-400/50",            badge: "bg-sky-500/20 text-sky-300",       selected: "border-sky-400 ring-2 ring-sky-400/20 shadow-lg shadow-sky-500/10",       dot: "bg-sky-400" },
  audit: { card: "border-amber-500/30 bg-amber-500/5 hover:border-amber-400/50",      badge: "bg-amber-500/20 text-amber-300",   selected: "border-amber-400 ring-2 ring-amber-400/20 shadow-lg shadow-amber-500/10",   dot: "bg-amber-400" },
  qa:    { card: "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-400/50", badge: "bg-emerald-500/20 text-emerald-300", selected: "border-emerald-400 ring-2 ring-emerald-400/20 shadow-lg shadow-emerald-500/10", dot: "bg-emerald-400" },
};
const DEFAULT_COLORS = { card: "border-slate-600/30 bg-slate-600/5 hover:border-slate-500/50", badge: "bg-slate-500/20 text-slate-300", selected: "border-amber-400 ring-2 ring-amber-400/20 shadow-lg shadow-amber-400/10", dot: "bg-slate-400" };
const roleColors = (role: string) => ROLE_COLORS[role?.toLowerCase()] ?? DEFAULT_COLORS;

/* ---------- tree builder ---------- */
function buildTree(nodes: OrgNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const n of nodes) map.set(n.id, { ...n, children: [] });
  const roots: TreeNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/* ---------- recursive tree node ---------- */
function TreeBranch({
  node,
  agentById,
  selectedId,
  onSelect,
  reportCounts,
}: {
  node: TreeNode;
  agentById: Map<string, Agent>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  reportCounts: Map<string, number>;
}) {
  const agent = agentById.get(node.agentId);
  const colors = roleColors(agent?.role ?? "");
  const isSelected = node.id === selectedId;
  const reports = reportCounts.get(node.id) ?? 0;

  return (
    <li>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.id);
        }}
        className={[
          "org-tree-card rounded-xl border-2 px-5 py-3 min-w-[160px] max-w-[200px] text-center transition-all cursor-pointer",
          isSelected ? colors.selected + " scale-[1.04]" : colors.card,
        ].join(" ")}
      >
        <div className="text-sm font-semibold text-white whitespace-nowrap leading-tight">
          {agent?.name ?? "Unknown"}
        </div>
        <span
          className={`mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${colors.badge}`}
        >
          {agent?.role ?? "agent"}
        </span>
        {reports > 0 && (
          <div className="mt-1.5 text-[10px] text-slate-500">
            {reports} direct report{reports !== 1 ? "s" : ""}
          </div>
        )}
      </button>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              agentById={agentById}
              selectedId={selectedId}
              onSelect={onSelect}
              reportCounts={reportCounts}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ========== main page ========== */
export default function OrgPage() {
  const { pushToast } = useAppUi();
  const confirm = useConfirm();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [orgNodes, setOrgNodes] = useState<OrgNode[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  /* load */
  const load = async () => {
    const [agentRes, orgRes] = await Promise.all([
      fetch("/api/agents", { cache: "no-store" }),
      fetch("/api/org", { cache: "no-store" }),
    ]);
    const agentData = await agentRes.json().catch(() => ({ agents: [] }));
    const orgData = await orgRes.json().catch(() => ({ nodes: [] }));
    const loadedAgents: Agent[] = Array.isArray(agentData.agents) ? agentData.agents : [];
    const loadedOrgNodes: OrgNode[] = Array.isArray(orgData.nodes) ? orgData.nodes : [];
    setAgents(loadedAgents);
    setOrgNodes(loadedOrgNodes);
    if (!selectedAgentId && loadedAgents[0]?.id) setSelectedAgentId(loadedAgents[0].id);
  };

  useEffect(() => {
    void load();
  }, []);

  /* report counts */
  const reportCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of orgNodes) {
      if (n.parentId) map.set(n.parentId, (map.get(n.parentId) ?? 0) + 1);
    }
    return map;
  }, [orgNodes]);

  /* tree structure */
  const tree = useMemo(() => buildTree(orgNodes), [orgNodes]);

  /* save */
  const save = async () => {
    await fetch("/api/org", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: orgNodes.filter((n) => n.agentId) }),
    });
    setDirty(false);
    pushToast({ tone: "success", title: "Org chart saved" });
    await load();
  };

  /* add node */
  const addNode = async () => {
    if (!selectedAgentId) return;
    const newNode: OrgNode = { id: crypto.randomUUID(), agentId: selectedAgentId };
    await fetch("/api/org/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newNode),
    });
    pushToast({ tone: "success", title: "Agent added to chart" });
    await load();
  };

  /* remove node */
  const removeNode = async (nodeId: string) => {
    const orgNode = orgNodes.find((n) => n.id === nodeId);
    const agent = orgNode ? agentById.get(orgNode.agentId) : undefined;
    const ok = await confirm({
      title: "Remove from chart",
      message: `Remove "${agent?.name ?? "this agent"}" from the org chart? The agent itself won't be deleted.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    const children = orgNodes.filter((n) => n.parentId === nodeId);
    const updatedNodes = orgNodes
      .filter((n) => n.id !== nodeId)
      .map((n) => (children.some((c) => c.id === n.id) ? { ...n, parentId: orgNode?.parentId } : n));
    await fetch("/api/org", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: updatedNodes }),
    });
    setSelectedNodeId(null);
    pushToast({ tone: "info", title: "Agent removed from chart" });
    await load();
  };

  /* change parent */
  const setParent = (nodeId: string, newParentId: string | undefined) => {
    const updated = orgNodes.map((n) => (n.id === nodeId ? { ...n, parentId: newParentId } : n));
    setOrgNodes(updated);
    setDirty(true);
  };

  /* node click */
  const onSelect = useCallback((id: string) => {
    setSelectedNodeId((prev) => (prev === id ? null : id));
  }, []);

  /* derived */
  const hasAgents = agents.length > 0;
  const hasNodes = orgNodes.length > 0;
  const selectedOrgNode = orgNodes.find((n) => n.id === selectedNodeId);
  const selectedAgent = selectedOrgNode ? agentById.get(selectedOrgNode.agentId) : undefined;
  const parentAgent = selectedOrgNode?.parentId
    ? agentById.get(orgNodes.find((n) => n.id === selectedOrgNode.parentId)?.agentId ?? "")
    : undefined;
  const directReports = orgNodes.filter((n) => n.parentId === selectedNodeId);

  /* possible parents (exclude self + descendants) */
  const possibleParents = useMemo(() => {
    if (!selectedNodeId) return [];
    const descendants = new Set<string>();
    const collect = (id: string) => {
      for (const n of orgNodes) {
        if (n.parentId === id && !descendants.has(n.id)) {
          descendants.add(n.id);
          collect(n.id);
        }
      }
    };
    collect(selectedNodeId);
    return orgNodes.filter((n) => n.id !== selectedNodeId && !descendants.has(n.id));
  }, [orgNodes, selectedNodeId]);

  return (
    <main className="space-y-5">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Org Chart</h2>
          <p className="text-sm text-slate-400">
            Build your agent hierarchy visually. Click a node to edit its reporting line.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-[10px] text-amber-300 animate-pulse">Unsaved changes</span>}
          <button
            onClick={() => void save()}
            className={`rounded-lg border px-4 py-2 text-xs uppercase tracking-[0.2em] transition-colors ${
              dirty
                ? "border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20"
                : "border-slate-700 bg-slate-900/40 text-slate-500 cursor-default"
            }`}
          >
            Save
          </button>
        </div>
      </section>

      {/* Empty state: no agents */}
      {!hasAgents && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 text-2xl text-slate-500">
            ⬡
          </div>
          <h3 className="mt-3 text-lg font-semibold text-white">Create agents first</h3>
          <p className="mt-1 text-sm text-slate-400">You need at least one agent before you can build an org chart.</p>
          <Link
            href="/agents"
            className="mt-4 inline-block rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 hover:bg-amber-400/20 transition-colors"
          >
            Go to Agents
          </Link>
        </section>
      )}

      {/* Tree + panel */}
      {hasAgents && (
        <section className="grid gap-4 lg:grid-cols-[1fr_280px]">
          {/* Tree canvas */}
          <div
            className="relative overflow-auto rounded-2xl border border-slate-800 bg-slate-950/60"
            style={{ minHeight: "60vh" }}
            onClick={() => setSelectedNodeId(null)}
          >
            {!hasNodes && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950/80 backdrop-blur-sm">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 text-3xl text-cyan-400">
                  ◎
                </div>
                <h3 className="text-base font-semibold text-white">Place your first agent</h3>
                <p className="max-w-xs text-center text-xs text-slate-400">
                  Select an agent from the panel on the right and click &ldquo;Place on Board&rdquo; to get started.
                </p>
              </div>
            )}
            {hasNodes && (
              <div className="org-tree p-8 pb-12 min-w-fit flex justify-center">
                <ul className="org-tree-root flex justify-center list-none p-0 m-0">
                  {tree.map((root) => (
                    <TreeBranch
                      key={root.id}
                      node={root}
                      agentById={agentById}
                      selectedId={selectedNodeId}
                      onSelect={onSelect}
                      reportCounts={reportCounts}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Right panel */}
          <div className="space-y-3">
            {/* Add to board */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-2">Add to Board</div>
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-200"
              >
                <option value="">Choose an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role})
                  </option>
                ))}
              </select>
              <button
                onClick={() => void addNode()}
                disabled={!selectedAgentId}
                className="mt-2 w-full rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs uppercase tracking-[0.2em] text-amber-200 hover:bg-amber-400/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Place on Board
              </button>
            </div>

            {/* Selected node detail */}
            {selectedOrgNode && selectedAgent && (
              <div className="animate-in rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 space-y-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-amber-400/70">Selected Node</div>

                <div>
                  <div className="text-sm font-semibold text-white">{selectedAgent.name}</div>
                  <span
                    className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${roleColors(selectedAgent.role).badge}`}
                  >
                    {selectedAgent.role}
                  </span>
                </div>

                {/* Reports to dropdown */}
                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-500 mb-1">Reports to</label>
                  <select
                    value={selectedOrgNode.parentId ?? ""}
                    onChange={(e) => setParent(selectedOrgNode.id, e.target.value || undefined)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-200"
                  >
                    <option value="">— None (top-level) —</option>
                    {possibleParents.map((n) => {
                      const a = agentById.get(n.agentId);
                      return (
                        <option key={n.id} value={n.id}>
                          {a?.name ?? "Unknown"} ({a?.role ?? "-"})
                        </option>
                      );
                    })}
                  </select>
                  {parentAgent && (
                    <div className="mt-1.5 text-[10px] text-slate-500">
                      Currently reporting to <span className="text-slate-300">{parentAgent.name}</span>
                    </div>
                  )}
                </div>

                {/* Direct reports */}
                {directReports.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 mb-1">
                      Direct Reports ({directReports.length})
                    </div>
                    <div className="space-y-1">
                      {directReports.map((r) => {
                        const a = agentById.get(r.agentId);
                        const c = roleColors(a?.role ?? "");
                        return (
                          <button
                            key={r.id}
                            onClick={() => setSelectedNodeId(r.id)}
                            className="flex w-full items-center gap-2 rounded-lg border border-slate-800/50 bg-slate-900/30 px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/40 transition-colors"
                          >
                            <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                            {a?.name ?? "Unknown"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <button
                  onClick={() => void removeNode(selectedOrgNode.id)}
                  className="w-full rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  Remove from Board
                </button>
              </div>
            )}

            {/* No selection hint */}
            {!selectedOrgNode && hasNodes && (
              <div className="rounded-xl border border-slate-800/50 bg-slate-900/20 p-4 text-center">
                <div className="text-2xl text-slate-600">◇</div>
                <p className="mt-2 text-[11px] text-slate-500">Click any node on the tree to edit its reporting line.</p>
              </div>
            )}

            {/* Tips */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/20 p-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-600 mb-1.5">How It Works</div>
              <ul className="space-y-1.5 text-[10px] text-slate-500">
                <li className="flex items-start gap-1.5">
                  <span className="text-amber-400/60 mt-px">①</span> Place agents on the board from the dropdown above
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="text-amber-400/60 mt-px">②</span> Click a node to select it
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="text-amber-400/60 mt-px">③</span> Use &ldquo;Reports to&rdquo; dropdown to set hierarchy
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="text-amber-400/60 mt-px">④</span> Click Save to persist your changes
                </li>
              </ul>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
