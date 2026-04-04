"use client";

import type { ReactNode } from "react";

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={joinClasses("page-header", className)}>
      <div className="space-y-2">
        {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1>
          {description ? <div className="max-w-3xl text-sm leading-6 text-slate-400">{description}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </section>
  );
}

export function SurfacePanel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const hasHeader = title || description || actions;
  return (
    <section className={joinClasses("surface-panel", className)}>
      {hasHeader ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            {title ? <div className="text-base font-semibold text-white">{title}</div> : null}
            {description ? <div className="text-sm leading-6 text-slate-400">{description}</div> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={joinClasses("min-w-0", bodyClassName)}>{children}</div>
    </section>
  );
}

export function MetricStrip({
  items,
  className
}: {
  items: Array<{ label: string; value: ReactNode; sub?: ReactNode; accentClassName?: string }>;
  className?: string;
}) {
  return (
    <section className={joinClasses("metric-strip", className)}>
      {items.map((item) => (
        <div key={item.label} className="surface-panel min-w-0 px-4 py-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
          <div className={joinClasses("mt-2 text-xl font-semibold text-white", item.accentClassName)}>{item.value}</div>
          {item.sub ? <div className="mt-1 text-sm text-slate-500">{item.sub}</div> : null}
        </div>
      ))}
    </section>
  );
}

export function SegmentedTabs<T extends string>({
  value,
  onChange,
  options,
  className
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
}) {
  return (
    <div className={joinClasses("inline-flex rounded-2xl border border-slate-800 bg-slate-950/70 p-1", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={joinClasses(
              "rounded-xl px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-slate-900 text-white shadow-sm shadow-slate-950/40" : "text-slate-400 hover:text-slate-200"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon?: string;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="surface-panel border-dashed text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/10 to-cyan-400/10 text-2xl text-amber-300">
        {icon ?? "◎"}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-white">{title}</h2>
      <div className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-slate-400">{description}</div>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </section>
  );
}

export function NoticePanel({
  tone = "neutral",
  title,
  children,
  action,
  className
}: {
  tone?: "neutral" | "info" | "warning" | "danger" | "success";
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const toneClassName =
    tone === "info"
      ? "border-cyan-400/20 bg-cyan-400/10 text-cyan-100"
      : tone === "warning"
        ? "border-amber-400/20 bg-amber-400/10 text-amber-100"
        : tone === "danger"
          ? "border-rose-400/20 bg-rose-400/10 text-rose-100"
          : tone === "success"
            ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
            : "border-slate-800 bg-slate-900/40 text-slate-300";

  return (
    <section className={joinClasses("rounded-2xl border px-4 py-4", toneClassName, className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          {title ? <div className="text-sm font-semibold text-white">{title}</div> : null}
          <div className="text-sm leading-6">{children}</div>
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
    </section>
  );
}

export function KeyValueGrid({
  items,
  columns = 2,
  className
}: {
  items: Array<{ label: string; value: ReactNode }>;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const gridClassName =
    columns === 1 ? "grid-cols-1" : columns === 3 ? "grid-cols-1 md:grid-cols-3" : "grid-cols-1 sm:grid-cols-2";
  return (
    <div className={joinClasses("grid gap-3", gridClassName, className)}>
      {items.map((item) => (
        <div key={item.label} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
          <div className="mt-2 text-sm text-slate-200 break-words">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function InspectCodeBlock({
  title,
  value,
  empty = "No data available."
}: {
  title?: ReactNode;
  value?: string | null;
  empty?: string;
}) {
  return (
    <section className="inspect-surface">
      {title ? <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">{title}</div> : null}
      <pre className="inspect-scroll max-h-[520px] whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-200">
        {value && value.trim().length > 0 ? value : empty}
      </pre>
    </section>
  );
}
