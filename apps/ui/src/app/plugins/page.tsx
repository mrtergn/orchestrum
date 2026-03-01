"use client";

import { useEffect, useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";

type Plugin = {
  name: string;
  version: string;
  enabled: boolean;
  manifest?: { capabilities_required?: string[]; min_tier?: string };
};

export default function PluginsPage() {
  const confirm = useConfirm();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [message, setMessage] = useState<{ text: string; type: "info" | "error" | "success" } | null>(null);

  const load = async () => {
    const res = await fetch("/api/plugins", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setPlugins(data.plugins ?? []);
  };

  useEffect(() => { load(); }, []);

  const flash = (text: string, type: "info" | "error" | "success" = "info") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleInstall = async () => {
    if (!pathInput.trim()) { flash("Provide a plugin path.", "error"); return; }
    const res = await fetch("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pathInput.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { flash(data.error ?? "Install failed.", "error"); return; }
    flash(`Installed ${data.plugin?.name ?? "plugin"} successfully.`, "success");
    setPathInput("");
    load();
  };

  const toggle = async (name: string, enabled: boolean) => {
    const res = await fetch("/api/plugins/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      flash(data.error ?? "Failed to update plugin.", "error");
      return;
    }
    load();
  };

  const remove = async (name: string) => {
    const ok = await confirm({
      title: "Remove plugin",
      message: `Remove "${name}"? This will unregister the plugin but won't delete its files.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    const res = await fetch("/api/plugins/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      flash(data.error ?? "Failed to remove plugin.", "error");
      return;
    }
    flash(`Removed ${name}.`, "success");
    load();
  };

  const enabledCount = plugins.filter((p) => p.enabled).length;

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Plugins</h2>
          <p className="text-sm text-slate-400">
            {plugins.length} installed · {enabledCount} enabled
          </p>
        </div>
        <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-[10px] text-slate-500">
          Community Edition
        </span>
      </section>

      {/* Flash message */}
      {message && (
        <div
          className={`rounded-xl border p-3.5 text-xs flex items-center gap-2 animate-in ${
            message.type === "error"
              ? "border-rose-400/30 bg-rose-400/5 text-rose-300"
              : message.type === "success"
                ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-300"
                : "border-amber-400/30 bg-amber-400/5 text-amber-300"
          }`}
        >
          <span>{message.type === "error" ? "✗" : message.type === "success" ? "✓" : "⚠"}</span>
          {message.text}
        </div>
      )}

      {/* Install */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-3">Install Plugin</div>
        <div className="flex gap-3">
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInstall()}
            placeholder="Path to plugin folder…"
            className="flex-1 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-amber-500/40 focus:outline-none transition-colors"
          />
          <button
            onClick={handleInstall}
            disabled={!pathInput.trim()}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2 text-[10px] uppercase tracking-[0.2em] text-amber-200 hover:bg-amber-400/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Install
          </button>
        </div>
      </section>

      {/* Plugin grid */}
      {plugins.length === 0 && (
        <section className="rounded-2xl border border-dashed border-slate-700 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 text-2xl text-slate-500">⧉</div>
          <h3 className="mt-3 text-base font-semibold text-white">No plugins installed</h3>
          <p className="mt-1 text-sm text-slate-400">
            Add a local plugin folder above. Plugins extend Orchestrum with custom capabilities.
          </p>
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-2">
        {plugins.map((plugin) => (
          <div
            key={plugin.name}
            className={`rounded-2xl border bg-slate-950/40 p-5 space-y-3 transition-colors ${
              plugin.enabled ? "border-emerald-500/20" : "border-slate-800 opacity-70"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold ${
                  plugin.enabled ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-800 text-slate-500"
                }`}>
                  {plugin.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">{plugin.name}</div>
                  <div className="text-[10px] text-slate-500">v{plugin.version}</div>
                </div>
              </div>

              {/* Toggle switch */}
              <button
                onClick={() => toggle(plugin.name, !plugin.enabled)}
                className={`relative h-6 w-11 rounded-full transition-colors flex-shrink-0 ${
                  plugin.enabled ? "bg-emerald-500/40" : "bg-slate-700"
                }`}
                title={plugin.enabled ? "Disable plugin" : "Enable plugin"}
              >
                <span
                  className={`absolute top-1 h-4 w-4 rounded-full transition-all ${
                    plugin.enabled ? "left-6 bg-emerald-400" : "left-1 bg-slate-400"
                  }`}
                />
              </button>
            </div>

            {/* Capabilities */}
            {plugin.manifest?.capabilities_required && plugin.manifest.capabilities_required.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {plugin.manifest.capabilities_required.map((cap) => (
                  <span key={cap} className="rounded-full bg-slate-800/60 px-2 py-0.5 text-[9px] text-slate-400">
                    {cap}
                  </span>
                ))}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-1 border-t border-slate-800/50">
              {plugin.manifest?.min_tier && (
                <span className="text-[9px] text-slate-600 uppercase tracking-wider">Min: {plugin.manifest.min_tier}</span>
              )}
              {!plugin.manifest?.min_tier && <span />}
              <button
                onClick={() => remove(plugin.name)}
                className="text-[10px] text-rose-400/60 hover:text-rose-400 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
