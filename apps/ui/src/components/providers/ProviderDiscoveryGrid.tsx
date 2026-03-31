"use client";

import {
  providerDiscoveryBadgeLabel,
  providerDiscoveryExplanation,
  providerDiscoveryState,
  providerDiscoverySummaryLabel,
  providerDiscoveryTransportLabel,
  preferredTransport,
  transportLabel,
  type ProviderDiscoveryRecord
} from "@/lib/providers";

type ProviderDiscoveryGridProps = {
  providers: ProviderDiscoveryRecord[];
  variant?: "full" | "compact";
  onUseProvider?: (record: ProviderDiscoveryRecord) => void;
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ProviderDiscoveryGrid({
  providers,
  variant = "full",
  onUseProvider
}: ProviderDiscoveryGridProps) {
  return (
    <div className={cx("grid gap-4", variant === "full" ? "lg:grid-cols-3" : "sm:grid-cols-2")}>
      {providers.map((record) => {
        const transport = preferredTransport(record);
        const statusLabel = providerDiscoveryBadgeLabel(transport);
        const state = providerDiscoveryState(transport);

        return (
          <div
            key={record.vendor}
            className={cx(
              "rounded-2xl border border-slate-800 bg-slate-950/40",
              variant === "full" ? "p-5" : "p-4"
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className={cx("font-semibold text-white", variant === "full" ? "text-sm" : "text-xs uppercase tracking-[0.18em]")}>
                  {record.label}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {providerDiscoverySummaryLabel(transport)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {onUseProvider && (
                  <button
                    onClick={() => onUseProvider(record)}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[10px] text-slate-300"
                  >
                    Use
                  </button>
                )}
                <span className={cx(
                  "rounded-full px-2.5 py-0.5 text-[10px] font-medium",
                  state === "connected"
                    ? "bg-emerald-400/10 text-emerald-300"
                    : state === "detected"
                      ? "bg-amber-400/10 text-amber-300"
                      : "bg-slate-800 text-slate-400"
                )}>
                  {statusLabel}
                </span>
              </div>
            </div>

            {variant === "full" && (
              <div className="mt-2 text-[11px] text-slate-500">
                {providerDiscoveryExplanation(transport)}
              </div>
            )}

            <div className="mt-3 space-y-1 text-[11px] text-slate-500">
              {record.transports.map((entry) => (
                <div key={`${record.vendor}-${entry.transport}`} className="flex items-center justify-between rounded-lg bg-slate-900/30 px-2.5 py-1.5">
                  <span>{transportLabel(entry.transport)}</span>
                  <span className={entry.configured ? "text-emerald-300" : entry.available ? "text-amber-300" : "text-slate-600"}>
                    {providerDiscoveryTransportLabel(entry)}
                  </span>
                </div>
              ))}
            </div>

            {transport?.reason && variant === "full" && (
              <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2 text-[11px] text-slate-500">
                {transport.reason}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
