"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAppUi } from "@/components/AppUiProvider";
import { useConfirm } from "@/components/ConfirmDialog";

type WorkspaceSummary = {
  id: string;
  name?: string;
  path: string;
  status: string;
  validation?: {
    exists: boolean;
    readable: boolean;
    isDirectory: boolean;
    isGitRepo: boolean;
    error?: string;
  };
  lastRun?: {
    runId: string;
    status: string;
    start: string;
    end: string | null;
  } | null;
};

declare global {
  interface Window {
    orchestrumDesktop?: {
      pickDirectory?: () => Promise<string | null>;
    };
  }
}

export default function WorkspacesPage() {
  const searchParams = useSearchParams();
  const { selectedWorkspaceId, setSelectedWorkspaceId, pushToast } = useAppUi();
  const confirm = useConfirm();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [editingName, setEditingName] = useState<Record<string, string>>({});
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const highlightAddWorkspace = searchParams.get("intent") === "add";

  const selected = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  );

  const loadWorkspaces = async () => {
    const res = await fetch("/api/workspaces", { cache: "no-store" });
    const data = res.ok ? await res.json() : { workspaces: [] };
    setWorkspaces(data.workspaces ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void loadWorkspaces();
  }, []);

  useEffect(() => {
    if (!highlightAddWorkspace) return;
    const timer = window.setTimeout(() => {
      pathInputRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [highlightAddWorkspace]);

  const addWorkspace = async () => {
    setMessage("");
    if (!pathInput.trim()) {
      setMessage("Path is required.");
      return;
    }
    setSubmitting(true);
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: pathInput.trim(),
        name: nameInput.trim() || undefined
      })
    });
    const payload = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to add workspace.");
      return;
    }
    setPathInput("");
    setNameInput("");
    const workspace = payload.workspace as WorkspaceSummary | undefined;
    if (workspace?.id) {
      setSelectedWorkspaceId(workspace.id);
      pushToast({
        tone: "success",
        title: "Workspace added",
        message: workspace.name || workspace.id
      });
    }
    await loadWorkspaces();
  };

  const saveName = async (workspace: WorkspaceSummary) => {
    const nextName = (editingName[workspace.id] ?? workspace.name ?? "").trim();
    const res = await fetch(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nextName })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to update workspace name.");
      return;
    }
    setEditingName((prev) => ({ ...prev, [workspace.id]: nextName }));
    await loadWorkspaces();
  };

  const removeWorkspace = async (workspace: WorkspaceSummary) => {
    const confirmed = await confirm({
      title: "Remove Workspace",
      message: `Are you sure you want to remove "${workspace.name ?? workspace.path}"? The files on disk will not be deleted.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    const res = await fetch(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to remove workspace.");
      return;
    }
    if (selectedWorkspaceId === workspace.id) {
      setSelectedWorkspaceId("");
    }
    await loadWorkspaces();
  };

  const initGit = async (workspace: WorkspaceSummary) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/git/init`, {
      method: "POST"
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to initialize git.");
      return;
    }
    pushToast({
      tone: "success",
      title: "Git initialized",
      message: workspace.name || workspace.id
    });
    await loadWorkspaces();
  };

  const pickDirectory = async () => {
    if (!window.orchestrumDesktop?.pickDirectory) {
      setMessage("Directory picker is available in desktop mode. Use path input in web mode.");
      return;
    }
    const picked = await window.orchestrumDesktop.pickDirectory();
    if (picked) {
      setPathInput(picked);
      setMessage("");
    }
  };

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Workspaces</h2>
          <p className="text-sm text-slate-400">
            {workspaces.length > 0
              ? `${workspaces.length} workspace${workspaces.length !== 1 ? "s" : ""} registered`
              : "Connect local repositories to run missions, delivery loops, and QA runs."}
          </p>
        </div>
        {selected && (
          <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-1.5 text-xs text-emerald-300">
            Active: {selected.name || selected.id}
          </div>
        )}
      </section>

      {/* Add workspace */}
      <section className={`rounded-2xl border bg-slate-950/40 p-5 ${highlightAddWorkspace ? "border-amber-400/30" : "border-slate-800"}`}>
        <div className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Add Workspace</div>
        {highlightAddWorkspace && (
          <div className="mt-2 text-xs text-amber-200">Add the local repository you want to use for your first mission.</div>
        )}
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto_auto]">
          <input
            ref={pathInputRef}
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="D:\\projects\\my-app"
            className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
          />
          <input
            value={nameInput}
            onChange={(event) => setNameInput(event.target.value)}
            placeholder="Display name (optional)"
            className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
          />
          <button
            onClick={() => void pickDirectory()}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs text-slate-300 hover:border-slate-600"
          >
            Browse
          </button>
          <button
            onClick={() => void addWorkspace()}
            disabled={submitting}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-amber-200 disabled:opacity-50"
          >
            {submitting ? "Adding..." : "Add"}
          </button>
        </div>
        {message && <div className="mt-2 text-xs text-rose-300">{message}</div>}
      </section>

      {/* Workspace list */}
      {loading && <div className="text-xs text-slate-500">Loading workspaces...</div>}

      {!loading && workspaces.length === 0 && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-8 text-center">
          <div className="text-2xl">◈</div>
          <h3 className="mt-2 text-lg font-semibold text-white">No workspaces yet</h3>
          <p className="mt-1 text-sm text-slate-400">
            Add a local directory path above — this is where agents will read and write files.
          </p>
          <p className="mt-2 text-xs text-slate-600">
            A workspace is typically a Git repository or project folder.
          </p>
        </section>
      )}

      <section className="grid gap-3">
        {workspaces.map((workspace) => (
          <article
            key={workspace.id}
            className={`rounded-2xl border p-4 transition-colors ${
              selectedWorkspaceId === workspace.id
                ? "border-amber-400/30 bg-amber-400/5"
                : "border-slate-800 bg-slate-950/40 hover:border-slate-700"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-white">{workspace.name || workspace.id}</span>
                  {selectedWorkspaceId === workspace.id && (
                    <span className="flex-shrink-0 rounded-full bg-amber-400/10 px-2 py-0.5 text-[9px] font-bold uppercase text-amber-300">active</span>
                  )}
                  {workspace.validation?.isGitRepo && (
                    <span className="flex-shrink-0 text-[10px] text-slate-600">git</span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-slate-500">{workspace.path}</div>
                {workspace.lastRun && (
                  <div className="mt-1 text-[10px] text-slate-600">
                    Last run: {workspace.lastRun.status} · {workspace.lastRun.runId.slice(0, 8)}
                  </div>
                )}
                {workspace.validation?.error && (
                  <div className="mt-1 text-[10px] text-rose-400">{workspace.validation.error}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selectedWorkspaceId !== workspace.id && (
                  <button
                    onClick={() => { setSelectedWorkspaceId(workspace.id); setMessage(""); }}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-[10px] text-slate-300 hover:border-slate-600"
                  >
                    Select
                  </button>
                )}
                {!workspace.validation?.isGitRepo && workspace.validation?.exists && (
                  <button
                    onClick={() => void initGit(workspace)}
                    className="rounded-md border border-sky-400/30 px-2.5 py-1 text-[10px] text-sky-300"
                  >
                    Git Init
                  </button>
                )}
                <button
                  onClick={() => void removeWorkspace(workspace)}
                  className="rounded-md border border-rose-400/30 px-2.5 py-1 text-[10px] text-rose-300"
                >
                  Remove
                </button>
              </div>
            </div>
            {/* Rename */}
            <div className="mt-3 flex items-center gap-2">
              <input
                value={editingName[workspace.id] ?? workspace.name ?? ""}
                onChange={(event) => setEditingName((prev) => ({ ...prev, [workspace.id]: event.target.value }))}
                placeholder="Rename workspace..."
                className="flex-1 rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1 text-[10px] text-slate-300 placeholder:text-slate-600"
              />
              <button
                onClick={() => void saveName(workspace)}
                className="rounded-md border border-sky-400/30 px-2.5 py-1 text-[10px] text-sky-300"
              >
                Save
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
