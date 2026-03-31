"use client";

import {
  hasAnyLocalProvider,
  hasConfiguredLocalProvider,
  providerDiscoveryState,
  preferredTransport,
  type ProviderDiscoveryRecord
} from "@/lib/providers";

type ProviderDiscoveryStatusSummaryProps = {
  providers: ProviderDiscoveryRecord[];
  variant?: "full" | "compact";
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ProviderDiscoveryStatusSummary({
  providers,
  variant = "full"
}: ProviderDiscoveryStatusSummaryProps) {
  const connectedCount = providers.filter((record) => providerDiscoveryState(preferredTransport(record)) === "connected").length;
  const needsSetupCount = providers.filter((record) => providerDiscoveryState(preferredTransport(record)) === "detected").length;
  const missingCount = providers.filter((record) => providerDiscoveryState(preferredTransport(record)) === "missing").length;
  const localReady = hasConfiguredLocalProvider(providers);
  const localPresent = hasAnyLocalProvider(providers);

  return (
    <div className={cx(
      "rounded-2xl border border-slate-800 bg-slate-950/35",
      variant === "full" ? "p-5" : "p-4"
    )}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className={cx("font-semibold text-white", variant === "full" ? "text-sm" : "text-xs uppercase tracking-[0.18em]")}>
            Local provider summary
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {localReady
              ? "At least one local provider can be used right now."
              : localPresent
                ? "Some local tools were found, but they still need sign-in or runtime setup."
                : "No usable local provider has been detected yet."}
          </div>
        </div>
        <span className={cx(
          "rounded-full px-2.5 py-0.5 text-[10px] font-medium",
          localReady ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-800 text-slate-400"
        )}>
          {localReady ? "Local routing available" : "API fallback optional"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
          {connectedCount} usable now
        </span>
        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
          {needsSetupCount} need setup
        </span>
        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
          {missingCount} not detected
        </span>
      </div>

      {variant === "full" && (
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[11px] text-slate-300">
            <div className="font-medium text-emerald-200">Usable now</div>
            <div className="mt-1 text-slate-400">Already signed in or reachable. You can route work there immediately.</div>
          </div>
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] text-slate-300">
            <div className="font-medium text-amber-200">Needs setup</div>
            <div className="mt-1 text-slate-400">Orchestrum found the tool, but auth or runtime setup is still incomplete.</div>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-900/35 px-3 py-2 text-[11px] text-slate-300">
            <div className="font-medium text-slate-200">Not detected</div>
            <div className="mt-1 text-slate-400">No installed or reachable transport was found for that provider on this machine.</div>
          </div>
        </div>
      )}
    </div>
  );
}
