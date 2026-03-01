"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Uncaught error:", error);
  }, [error]);

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-rose-400/10 text-4xl text-rose-300/60">
        ⚠
      </div>
      <h1 className="mt-6 text-2xl font-bold text-white">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-slate-400">
        An unexpected error occurred. You can try again or go back to the dashboard.
      </p>
      {error.message && (
        <pre className="mt-4 max-w-lg rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-2 text-left text-[11px] text-rose-300/80">
          {error.message}
        </pre>
      )}
      <div className="mt-6 flex gap-3">
        <button
          onClick={reset}
          className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
        >
          Try Again
        </button>
        <a
          href="/"
          className="rounded-lg border border-slate-700 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-slate-300 transition-colors hover:border-slate-600"
        >
          Dashboard
        </a>
      </div>
    </main>
  );
}
