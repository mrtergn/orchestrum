"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: "danger" | "warning" | "neutral";
};

let globalShow: ((options: ConfirmOptions) => Promise<boolean>) | null = null;

export function useConfirm() {
  return useCallback(
    (options: ConfirmOptions) => {
      if (!globalShow) return Promise.resolve(true);
      return globalShow(options);
    },
    []
  );
}

export function ConfirmDialog() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({
    title: "",
    message: "",
  });
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  useEffect(() => {
    globalShow = (opts) => {
      return new Promise<boolean>((resolve) => {
        setOptions(opts);
        setOpen(true);
        resolveRef.current = resolve;
      });
    };
    return () => {
      globalShow = null;
    };
  }, []);

  const handleConfirm = () => {
    setOpen(false);
    resolveRef.current?.(true);
  };

  const handleCancel = () => {
    setOpen(false);
    resolveRef.current?.(false);
  };

  if (!open) return null;

  const toneStyles = {
    danger: "border-rose-400/40 bg-rose-400/10 text-rose-200",
    warning: "border-amber-400/40 bg-amber-400/10 text-amber-200",
    neutral: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  };
  const tone = options.tone ?? "danger";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 p-4" onClick={handleCancel}>
      <div
        className="animate-in w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950/95 p-6 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white">{options.title}</h3>
        <p className="mt-2 text-sm text-slate-400">{options.message}</p>
        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={handleCancel}
            className="rounded-lg border border-slate-700 px-4 py-2 text-xs uppercase tracking-[0.15em] text-slate-300 transition-colors hover:border-slate-600"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className={`rounded-lg border px-4 py-2 text-xs uppercase tracking-[0.15em] transition-colors ${toneStyles[tone]}`}
          >
            {options.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
