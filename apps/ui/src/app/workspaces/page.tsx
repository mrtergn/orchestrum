"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAppUi } from "@/components/AppUiProvider";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  buildWorkspaceApiPath,
  forgetRecentWorkspacePath,
  rememberRecentWorkspacePath
} from "@/lib/workspaces";
import {
  EmptyState,
  MetricStrip,
  NoticePanel,
  PageHeader,
  SurfacePanel
} from "@/components/ui/PagePrimitives";

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

  const validCount = useMemo(
    () => workspaces.filter((workspace) => workspace.validation?.exists && workspace.validation?.readable).length,
    [workspaces]
  );

  const gitCount = useMemo(
    () => workspaces.filter((workspace) => workspace.validation?.isGitRepo).length,
    [workspaces]
  );

  const loadWorkspaces = async () => {
    const res = await fetch(buildWorkspaceApiPath("/api/workspaces"), { cache: "no-store" });
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
      rememberRecentWorkspacePath(workspace.path);
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
      tone: "danger"
    });
    if (!confirmed) return;
    const res = await fetch(`/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspace.path })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(payload.error ?? "Failed to remove workspace.");
      return;
    }
    forgetRecentWorkspacePath(workspace.path);
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
    <main className="page-shell">
      <PageHeader
        eyebrow="Workspaces"
        title="Choose where Orchestrum can operate"
        description="A workspace is the local repo or project folder Orchestrum reads, edits, and indexes. Add the path once, then keep using Work as the main operator surface."
      />

      <MetricStrip
        items={[
          { label: "Registered", value: workspaces.length },
          { label: "Healthy", value: validCount, accentClassName: "text-emerald-300" },
          { label: "Git repos", value: gitCount }
        ]}
        className="xl:grid-cols-3"
      />

      {selected ? (
        <NoticePanel tone="success" title="Current active workspace">
          <strong className="text-white">{selected.name || selected.id}</strong> is active.
        </NoticePanel>
      ) : null}

      <section className="page-columns">
        <div className="summary-stack">
          <SurfacePanel
            title="Add workspace"
            description="Use this only when you want to register another local repo. After that, the main product flow stays in Work."
          >
            {highlightAddWorkspace ? (
              <div className="mb-4 text-sm text-amber-200">Add the local repository you want to use for your first run.</div>
            ) : null}
            <div className="grid gap-3 md:grid-cols-[1.5fr_1fr_auto_auto]">
              <input
                ref={pathInputRef}
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                placeholder="/Users/you/project"
                className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              />
              <input
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="Display name (optional)"
                className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              />
              <button
                type="button"
                onClick={() => void pickDirectory()}
                className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2 text-xs font-medium text-slate-300"
              >
                Browse
              </button>
              <button
                type="button"
                onClick={() => void addWorkspace()}
                disabled={submitting}
                className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium text-amber-200 disabled:opacity-50"
              >
                {submitting ? "Adding..." : "Add"}
              </button>
            </div>
            {message ? <div className="mt-3 text-sm text-rose-300">{message}</div> : null}
          </SurfacePanel>

          <SurfacePanel
            title="Registered workspaces"
            description="Healthy workspaces should be readable local folders. Invalid or unreadable entries need attention before you can trust the runtime."
          >
            {loading ? (
              <div className="text-sm text-slate-500">Loading workspaces...</div>
            ) : workspaces.length === 0 ? (
              <EmptyState
                icon="◈"
                title="No workspaces yet"
                description="Add a local project folder above. Workspaces are typically Git repositories, but any readable project folder can be registered."
              />
            ) : (
              <div className="space-y-3">
                {workspaces.map((workspace) => {
                  const healthLabel =
                    workspace.validation?.exists && workspace.validation?.readable
                      ? "healthy"
                      : workspace.validation?.error
                        ? "needs attention"
                        : workspace.status;
                  return (
                    <div
                      key={workspace.id}
                      className={`rounded-2xl border px-4 py-4 ${
                        selectedWorkspaceId === workspace.id
                          ? "border-amber-400/30 bg-amber-400/10"
                          : "border-slate-800 bg-slate-900/35"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-semibold text-white">{workspace.name || workspace.id}</div>
                            <span className={`rounded-full border px-2.5 py-0.5 text-[10px] ${
                              healthLabel === "healthy"
                                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                                : "border-amber-400/30 bg-amber-400/10 text-amber-200"
                            }`}>
                              {healthLabel}
                            </span>
                            {workspace.validation?.isGitRepo ? (
                              <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">git repo</span>
                            ) : null}
                          </div>
                          <div className="text-sm text-slate-400 break-all">{workspace.path}</div>
                          {workspace.lastRun ? (
                            <div className="text-xs text-slate-500">
                              Last run: {workspace.lastRun.status} · {workspace.lastRun.runId.slice(0, 8)}
                            </div>
                          ) : null}
                          {workspace.validation?.error ? (
                            <div className="text-xs text-rose-300">{workspace.validation.error}</div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {selectedWorkspaceId !== workspace.id ? (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedWorkspaceId(workspace.id);
                                setMessage("");
                              }}
                              className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-200"
                            >
                              Select
                            </button>
                          ) : null}
                          {!workspace.validation?.isGitRepo && workspace.validation?.exists ? (
                            <button
                              type="button"
                              onClick={() => void initGit(workspace)}
                              className="rounded-xl border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs font-medium text-sky-200"
                            >
                              Git init
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void removeWorkspace(workspace)}
                            className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs font-medium text-rose-200"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                        <input
                          value={editingName[workspace.id] ?? workspace.name ?? ""}
                          onChange={(event) => setEditingName((prev) => ({ ...prev, [workspace.id]: event.target.value }))}
                          placeholder="Rename workspace"
                          className="flex-1 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
                        />
                        <button
                          type="button"
                          onClick={() => void saveName(workspace)}
                          className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-medium text-slate-200"
                        >
                          Save name
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SurfacePanel>
        </div>

        <SurfacePanel
          title="Next steps"
          description="Once a workspace is healthy and selected, move back into Work. Workspaces is only the registration surface."
        >
          <div className="space-y-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
              <div className="text-sm font-semibold text-white">1. Pick the active repo</div>
              <div className="mt-1 text-sm text-slate-400">Select the workspace you want the rest of the app to operate on.</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
              <div className="text-sm font-semibold text-white">2. Confirm provider setup</div>
              <div className="mt-1 text-sm text-slate-400">If runs fail immediately, check provider detection in Settings before debugging anything else.</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
              <div className="text-sm font-semibold text-white">3. Return to Work</div>
              <div className="mt-1 text-sm text-slate-400">Use Work as the main launch, review, and continuation surface.</div>
            </div>
          </div>
        </SurfacePanel>
      </section>
    </main>
  );
}
