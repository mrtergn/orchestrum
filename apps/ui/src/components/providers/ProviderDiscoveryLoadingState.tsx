"use client";

import { useEffect, useMemo, useState } from "react";
import { PROVIDER_DISCOVERY_ORDER, vendorLabel, type ProviderVendor } from "@/lib/providers";

type ProviderDiscoveryLoadingStateProps = {
  variant?: "full" | "compact";
};

type PhaseId = "bootstrap" | "cli_probe" | "local_probe" | "finalize";

const PHASES: Array<{ id: PhaseId; label: string; detail: string; atMs: number }> = [
  { id: "bootstrap", label: "Loading local config", detail: "Reading provider config and saved runtime hints.", atMs: 0 },
  { id: "cli_probe", label: "Checking CLI sessions", detail: "Looking for Codex, Copilot, Claude, and Cursor availability.", atMs: 600 },
  { id: "local_probe", label: "Probing local transports", detail: "Checking Ollama and llama.cpp HTTP endpoints.", atMs: 1600 },
  { id: "finalize", label: "Preparing provider cards", detail: "Turning discovery results into transport summaries.", atMs: 2600 }
];

const ACTIVE_VENDORS_BY_PHASE: Record<PhaseId, ProviderVendor[]> = {
  bootstrap: ["codex", "copilot", "claude"],
  cli_probe: ["codex", "copilot", "claude", "cursor"],
  local_probe: ["ollama", "llama.cpp"],
  finalize: ["openai", "codex", "copilot", "claude", "cursor", "ollama", "llama.cpp"]
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ProviderDiscoveryLoadingState({
  variant = "full"
}: ProviderDiscoveryLoadingStateProps) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 120);
    return () => window.clearInterval(interval);
  }, []);

  const activePhase = useMemo(() => {
    const initialPhase = PHASES[0];
    if (!initialPhase) {
      return { id: "bootstrap", label: "Loading local config", detail: "", atMs: 0 } as const;
    }
    let current = initialPhase;
    for (const phase of PHASES) {
      if (elapsedMs >= phase.atMs) current = phase;
    }
    return current;
  }, [elapsedMs]);

  const phaseProgress = useMemo(
    () => (PHASES.findIndex((phase) => phase.id === activePhase.id) + 1) / PHASES.length,
    [activePhase.id]
  );

  const activeVendors = ACTIVE_VENDORS_BY_PHASE[activePhase.id];

  return (
    <div className="space-y-4">
      <div className={cx(
        "rounded-2xl border border-cyan-400/20 bg-gradient-to-r from-cyan-400/8 via-slate-950/60 to-amber-400/8",
        variant === "full" ? "p-5" : "p-4"
      )}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className={cx("font-semibold text-white", variant === "full" ? "text-sm" : "text-xs uppercase tracking-[0.18em]")}>
              Detecting local provider sessions
            </div>
            <p className={cx("mt-1 text-slate-400", variant === "full" ? "text-xs" : "text-[11px]")}>
              CLI and local provider discovery is running. API fallback settings will appear after this scan completes.
            </p>
          </div>
          <span className={cx(
            "rounded-full border border-cyan-400/20 bg-cyan-400/10 text-cyan-200",
            variant === "full" ? "px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]" : "px-2 py-1 text-[10px]"
          )}>
            scanning
          </span>
        </div>

        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-900/80">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-emerald-400 to-amber-300 transition-all duration-300"
            style={{ width: `${phaseProgress * 100}%` }}
          />
        </div>

        <div className={cx("mt-4", variant === "full" ? "grid gap-3 md:grid-cols-3" : "space-y-2")}>
          {PHASES.slice(variant === "full" ? 0 : 0, variant === "full" ? PHASES.length : 3).map((phase) => {
            const phaseIndex = PHASES.findIndex((entry) => entry.id === phase.id);
            const activeIndex = PHASES.findIndex((entry) => entry.id === activePhase.id);
            const isCurrent = phase.id === activePhase.id;
            const isReached = phaseIndex <= activeIndex;
            return (
              <div
                key={phase.id}
                className={cx(
                  "rounded-xl border px-3 py-2",
                  isCurrent
                    ? "border-cyan-400/30 bg-cyan-400/10"
                    : isReached
                      ? "border-slate-700 bg-slate-900/35"
                      : "border-slate-800 bg-slate-950/50"
                )}
              >
                <div className="flex items-center gap-2 text-xs text-slate-200">
                  <span className={cx("h-2 w-2 rounded-full", isCurrent ? "animate-pulse bg-cyan-300" : isReached ? "bg-emerald-300/70" : "bg-slate-600")} />
                  <span>{phase.label}</span>
                </div>
                {variant === "full" && <div className="mt-1 text-[11px] text-slate-500">{phase.detail}</div>}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {PROVIDER_DISCOVERY_ORDER.map((vendor) => (
            <span
              key={vendor}
              className={cx(
                "rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                activeVendors.includes(vendor)
                  ? "border-cyan-400/20 bg-cyan-400/10 text-cyan-200"
                  : "border-slate-800 bg-slate-900/40 text-slate-500"
              )}
            >
              {vendorLabel(vendor)}
            </span>
          ))}
        </div>
      </div>

      <div className={cx("grid gap-4", variant === "full" ? "lg:grid-cols-3" : "sm:grid-cols-2")}>
        {PROVIDER_DISCOVERY_ORDER.map((vendor) => (
          <div key={vendor} className={cx(
            "animate-pulse rounded-2xl border border-slate-800 bg-slate-950/40",
            variant === "full" ? "p-5" : "p-4"
          )}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-white">{vendorLabel(vendor)}</h4>
                <div className="mt-1 h-3 w-28 rounded bg-slate-800/80" />
              </div>
              <div className="h-6 w-20 rounded-full bg-slate-800/80" />
            </div>
            <div className="mt-3 space-y-1">
              <div className="h-8 rounded-lg bg-slate-900/40" />
              <div className="h-8 rounded-lg bg-slate-900/30" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
