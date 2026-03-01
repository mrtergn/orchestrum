"use client";

import { useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";

type TemplateEntry = {
  name: string;
  title: string;
  description: string;
  source?: string;
};

type TemplateManifest = {
  templates: TemplateEntry[];
};

type Workspace = {
  id: string;
  name?: string;
  path: string;
};

export default function TemplatesPage() {
  const { selectedWorkspaceId, setSelectedWorkspaceId, setLastTemplate, openRunConfig } = useAppUi();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [cloneWorkspace, setCloneWorkspace] = useState(selectedWorkspaceId);
  const [message, setMessage] = useState<string>("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    setCloneWorkspace(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const load = async () => {
      const [templateRes, workspaceRes] = await Promise.all([
        fetch("/api/templates", { cache: "no-store" }),
        fetch("/api/workspaces", { cache: "no-store" })
      ]);
      const templateData = templateRes.ok ? ((await templateRes.json()) as TemplateManifest) : { templates: [] };
      const workspaceData = workspaceRes.ok ? await workspaceRes.json() : { workspaces: [] };
      setTemplates(templateData.templates ?? []);
      setWorkspaces(workspaceData.workspaces ?? []);
    };
    void load();
  }, []);

  const handleClone = async (template: TemplateEntry) => {
    setMessage("");
    if (!cloneWorkspace) {
      setMessage("Select a workspace before cloning templates.");
      return;
    }
    const targetName = targets[template.name] || template.name;
    const res = await fetch("/api/templates/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: template.name, targetName, workspaceId: cloneWorkspace, source: template.source })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data.error ?? "Failed to clone template.");
      return;
    }
    setSelectedWorkspaceId(cloneWorkspace);
    setMessage(`Cloned to ${data.path}`);
  };

  const handleImport = async (file: File) => {
    setMessage("");
    if (!cloneWorkspace) {
      setMessage("Select a workspace before importing templates.");
      return;
    }
    setImporting(true);
    const data = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(data);
    const res = await fetch("/api/templates/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: cloneWorkspace, data: base64 })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(payload.error ?? "Template import failed.");
    } else {
      setMessage(`Imported template ${payload.result?.name ?? ""}`.trim());
    }
    setImporting(false);
  };

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Templates</h2>
          <p className="text-sm text-slate-400">Clone workflow templates and run them in any workspace.</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={cloneWorkspace}
            onChange={(event) => setCloneWorkspace(event.target.value)}
            className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
          >
            <option value="">Target workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name || workspace.id}
              </option>
            ))}
          </select>
          <label className="cursor-pointer rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs text-slate-300 hover:border-slate-600">
            <input
              type="file"
              accept=".orct"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleImport(file);
                  event.currentTarget.value = "";
                }
              }}
            />
            {importing ? "Importing..." : "Import .orct"}
          </label>
        </div>
      </section>

      {/* Drop zone */}
      <section
        className="group/drop rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/20 p-6 text-center transition-colors hover:border-amber-400/30 hover:bg-amber-400/5"
        onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add("border-amber-400/40", "bg-amber-400/5"); }}
        onDragLeave={(event) => { event.currentTarget.classList.remove("border-amber-400/40", "bg-amber-400/5"); }}
        onDrop={(event) => {
          event.preventDefault();
          event.currentTarget.classList.remove("border-amber-400/40", "bg-amber-400/5");
          const file = event.dataTransfer.files?.[0];
          if (file) void handleImport(file);
        }}
      >
        <div className="text-lg text-slate-600 mb-1">↓</div>
        <div className="text-xs text-slate-500">Drop <span className="text-slate-400">.orct</span> files here to import</div>
      </section>

      {message && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          {message}
        </div>
      )}

      {/* Empty state */}
      {templates.length === 0 && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 text-2xl text-slate-500">◈</div>
          <h3 className="mt-3 text-base font-semibold text-white">No templates available</h3>
          <p className="mt-1 text-sm text-slate-400">Import .orct template files or add custom templates in your workspace.</p>
          <p className="mt-2 text-[10px] text-slate-600 font-mono">~/.orchestrum/templates/ or workspace .orchestrum/templates/</p>
        </section>
      )}

      {/* Template grid */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => (
          <article key={template.name} className="group rounded-2xl border border-slate-800 bg-slate-950/40 p-5 transition-all hover:border-slate-700 hover:shadow-lg hover:shadow-slate-950/50">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/15 to-sky-500/5 text-cyan-400 text-sm font-bold flex-shrink-0">
                {template.title.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white truncate">{template.title}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[9px] text-slate-600 font-mono truncate">{template.name}</span>
                  {template.source === "custom" && (
                    <span className="rounded-full bg-amber-500/15 px-1.5 py-px text-[8px] uppercase tracking-wider text-amber-400 border border-amber-500/20">custom</span>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400 line-clamp-2">{template.description}</p>
            <div className="mt-4 space-y-2">
              <input
                value={targets[template.name] ?? ""}
                onChange={(event) =>
                  setTargets((prev) => ({ ...prev, [template.name]: event.target.value }))
                }
                placeholder={template.name}
                className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-1.5 text-[10px] text-slate-300 placeholder:text-slate-600"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void handleClone(template)}
                  className="flex-1 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-amber-200"
                >
                  Clone
                </button>
                <button
                  onClick={() => {
                    if (cloneWorkspace) setSelectedWorkspaceId(cloneWorkspace);
                    setLastTemplate(template.name);
                    openRunConfig({
                      workspaceId: cloneWorkspace || selectedWorkspaceId || undefined,
                      workflowId: template.name
                    });
                  }}
                  className="flex-1 rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-sky-200"
                >
                  Run
                </button>
              </div>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}
