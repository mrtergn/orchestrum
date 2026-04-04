"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useAppUi } from "@/components/AppUiProvider";
import {
  EmptyState,
  MetricStrip,
  NoticePanel,
  PageHeader,
  SegmentedTabs,
  SurfacePanel
} from "@/components/ui/PagePrimitives";

type Plugin = {
  name: string;
  version: string;
  enabled: boolean;
  manifest?: { capabilities_required?: string[] };
};

type InspectMode = "overview" | "inspect";

export default function PluginsPage() {
  const confirm = useConfirm();
  const { selectedWorkspaceId } = useAppUi();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [message, setMessage] = useState<{ text: string; type: "info" | "error" | "success" } | null>(null);
  const [mode, setMode] = useState<InspectMode>("overview");

  const load = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setPlugins([]);
      return;
    }
    const params = new URLSearchParams();
    params.set("workspace", selectedWorkspaceId);
    const res = await fetch(`/api/plugins?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setPlugins(data.plugins ?? []);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (text: string, type: "info" | "error" | "success" = "info") => {
    setMessage({ text, type });
    window.setTimeout(() => setMessage(null), 4000);
  };

  const handleInstall = async () => {
    if (!pathInput.trim()) {
      flash("Provide a plugin path.", "error");
      return;
    }
    if (!selectedWorkspaceId) {
      flash("Select a workspace before installing plugins.", "error");
      return;
    }
    const res = await fetch("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pathInput.trim(), workspaceId: selectedWorkspaceId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      flash(data.error ?? "Install failed.", "error");
      return;
    }
    flash(`Installed ${data.plugin?.name ?? "plugin"} successfully.`, "success");
    setPathInput("");
    void load();
  };

  const toggle = async (name: string, enabled: boolean) => {
    if (!selectedWorkspaceId) {
      flash("Select a workspace before changing plugins.", "error");
      return;
    }
    const res = await fetch("/api/plugins/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled, workspaceId: selectedWorkspaceId })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      flash(data.error ?? "Failed to update plugin.", "error");
      return;
    }
    void load();
  };

  const remove = async (name: string) => {
    if (!selectedWorkspaceId) {
      flash("Select a workspace before removing plugins.", "error");
      return;
    }
    const ok = await confirm({
      title: "Remove plugin",
      message: `Remove "${name}"? This deletes Orchestrum's installed copy and unregisters it. Your original source folder is unchanged.`,
      confirmLabel: "Remove",
      tone: "danger"
    });
    if (!ok) return;
    const res = await fetch("/api/plugins/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workspaceId: selectedWorkspaceId })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      flash(data.error ?? "Failed to remove plugin.", "error");
      return;
    }
    flash(`Removed ${name}.`, "success");
    void load();
  };

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;
  const capabilityCount = useMemo(
    () => new Set(plugins.flatMap((plugin) => plugin.manifest?.capabilities_required ?? [])).size,
    [plugins]
  );

  return (
    <main className="page-shell">
      <PageHeader
        eyebrow="Plugins"
        title="Workspace-local plugin hooks"
        description="Plugins extend mission and browser workflows inside the selected workspace. They are trusted local JavaScript hooks, not sandboxed extensions."
        actions={
          <SegmentedTabs
            value={mode}
            onChange={setMode}
            options={[
              { value: "overview", label: "Overview" },
              { value: "inspect", label: "Inspect" }
            ]}
          />
        }
      />

      {message ? (
        <NoticePanel
          tone={message.type === "error" ? "danger" : message.type === "success" ? "success" : "info"}
          title={message.type === "error" ? "Plugin action failed" : message.type === "success" ? "Plugin updated" : "Plugin notice"}
        >
          {message.text}
        </NoticePanel>
      ) : null}

      {!selectedWorkspaceId ? (
        <EmptyState
          icon="⧉"
          title="Select a workspace first"
          description="Plugin installation and enablement are workspace-scoped. Choose a workspace to review its installed hooks."
        />
      ) : (
        <>
          <MetricStrip
            items={[
              { label: "Installed", value: plugins.length },
              { label: "Enabled", value: enabledCount, accentClassName: "text-emerald-300" },
              { label: "Declared capabilities", value: capabilityCount }
            ]}
            className="xl:grid-cols-3"
          />

          <NoticePanel tone="warning" title="Trust boundary">
            Capability checks help Orchestrum validate expected hooks, but installed plugins still execute as trusted workspace-local code.
          </NoticePanel>

          <section className="page-columns">
            <div className="summary-stack">
              <SurfacePanel
                title="Install a plugin"
                description="Point Orchestrum at a local plugin folder inside or outside the selected workspace."
              >
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    value={pathInput}
                    onChange={(event) => setPathInput(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void handleInstall()}
                    placeholder="Path to plugin folder"
                    className="flex-1 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
                  />
                  <button
                    type="button"
                    onClick={() => void handleInstall()}
                    disabled={!pathInput.trim()}
                    className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium text-amber-200 disabled:opacity-40"
                  >
                    Install plugin
                  </button>
                </div>
              </SurfacePanel>

              <SurfacePanel
                title="Installed plugins"
                description="Use this view for the operational decision: what is installed, what is enabled, and what should stay active."
              >
                {plugins.length === 0 ? (
                  <EmptyState
                    icon="⧉"
                    title="No plugins installed"
                    description="Install a local plugin folder to add workspace hooks."
                  />
                ) : (
                  <div className="space-y-3">
                    {plugins.map((plugin) => (
                      <div key={plugin.name} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <div className="text-sm font-semibold text-white">{plugin.name}</div>
                              <span className="text-[11px] text-slate-500">v{plugin.version}</span>
                            </div>
                            <div className="text-sm text-slate-400">
                              {plugin.enabled ? "Enabled for this workspace." : "Installed but currently disabled."}
                            </div>
                          </div>
                          <span className={`rounded-full border px-3 py-1 text-xs ${
                            plugin.enabled
                              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                              : "border-slate-700 bg-slate-900/60 text-slate-400"
                          }`}>
                            {plugin.enabled ? "enabled" : "disabled"}
                          </span>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void toggle(plugin.name, !plugin.enabled)}
                            className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-200"
                          >
                            {plugin.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(plugin.name)}
                            className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs font-medium text-rose-200"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SurfacePanel>
            </div>

            <SurfacePanel
              title={mode === "overview" ? "Capability summary" : "Inspect plugin metadata"}
              description={
                mode === "overview"
                  ? "Read this first. Use Inspect only when you need the low-level capability declarations for each plugin."
                  : "Raw capability declarations are shown here for debugging and review."
              }
            >
              {plugins.length === 0 ? (
                <div className="text-sm text-slate-500">No plugin metadata to inspect yet.</div>
              ) : mode === "overview" ? (
                <div className="space-y-3">
                  {plugins.map((plugin) => (
                    <div key={plugin.name} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                      <div className="text-sm font-semibold text-white">{plugin.name}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(plugin.manifest?.capabilities_required ?? []).length === 0 ? (
                          <span className="text-xs text-slate-500">No capabilities declared.</span>
                        ) : (
                          (plugin.manifest?.capabilities_required ?? []).map((capability) => (
                            <span key={`${plugin.name}:${capability}`} className="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1 text-[11px] text-slate-300">
                              {capability}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <pre className="inspect-scroll max-h-[640px] whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-200">
                  {JSON.stringify(plugins, null, 2)}
                </pre>
              )}
            </SurfacePanel>
          </section>
        </>
      )}
    </main>
  );
}
