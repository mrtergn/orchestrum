export default function Loading() {
  return (
    <main className="space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <div className="h-5 w-48 rounded bg-slate-800" />
        <div className="mt-2 h-3 w-72 rounded bg-slate-800/60" />
      </div>

      {/* Content skeleton */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="h-3 w-16 rounded bg-slate-800/60" />
          <div className="mt-3 h-6 w-24 rounded bg-slate-800" />
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="h-3 w-16 rounded bg-slate-800/60" />
          <div className="mt-3 h-6 w-24 rounded bg-slate-800" />
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
          <div className="h-3 w-16 rounded bg-slate-800/60" />
          <div className="mt-3 h-6 w-24 rounded bg-slate-800" />
        </div>
      </div>

      {/* Body skeleton */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <div className="space-y-3">
          <div className="h-3 w-full rounded bg-slate-800/40" />
          <div className="h-3 w-5/6 rounded bg-slate-800/40" />
          <div className="h-3 w-4/6 rounded bg-slate-800/40" />
          <div className="h-3 w-3/4 rounded bg-slate-800/40" />
        </div>
      </div>
    </main>
  );
}
