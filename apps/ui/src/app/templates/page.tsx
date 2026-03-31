"use client";

import { useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";

type TemplateEntry = {
  name: string;
  title: string;
  description: string;
  source?: string;
  category?: string;
  defaultGoalHint?: string;
  recommendedRoles?: string[];
  outcomes?: string[];
  nodeCount?: number;
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
  const [workspaceId, setWorkspaceId] = useState(selectedWorkspaceId);

  useEffect(() => {
    setWorkspaceId(selectedWorkspaceId);
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

  return (
    <main className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Mission Templates</h2>
          <p className="text-sm text-slate-400">Built-in graph templates for autonomous PM, dev, audit, and delivery missions.</p>
        </div>
        <select
          value={workspaceId}
          onChange={(event) => {
            setWorkspaceId(event.target.value);
            setSelectedWorkspaceId(event.target.value);
          }}
          className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-200"
        >
          <option value="">Select workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name || workspace.id}
            </option>
          ))}
        </select>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5 text-sm text-slate-400">
        Legacy YAML execution was removed. Start missions from these built-in templates.
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => (
          <article key={template.name} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5 transition hover:border-slate-700">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/15 to-sky-500/5 text-sm font-bold text-cyan-400">
                {template.title.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white">{template.title}</div>
                <div className="mt-1 text-[10px] font-mono text-slate-500">{template.name}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {template.category && (
                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200">
                  {template.category}
                </span>
              )}
              {typeof template.nodeCount === "number" && (
                <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                  {template.nodeCount} node{template.nodeCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">{template.description}</p>
            {template.defaultGoalHint && (
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{template.defaultGoalHint}</p>
            )}
            {(template.recommendedRoles?.length ?? 0) > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {template.recommendedRoles?.map((role) => (
                  <span key={role} className="rounded-full border border-slate-700 bg-slate-950/60 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                    {role}
                  </span>
                ))}
              </div>
            )}
            {(template.outcomes?.length ?? 0) > 0 && (
              <div className="mt-4 space-y-1 text-[11px] text-slate-500">
                {template.outcomes?.slice(0, 3).map((item) => <div key={item}>- {item}</div>)}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  setLastTemplate(template.name);
                  openRunConfig({
                    workspaceId: workspaceId || selectedWorkspaceId || undefined,
                    missionTemplateId: template.name,
                    runKind: "mission"
                  });
                }}
                className="flex-1 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-amber-200"
              >
                Start Mission
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
