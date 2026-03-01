import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/10 to-cyan-400/10 text-4xl text-amber-300/60">
        ◌
      </div>
      <h1 className="mt-6 text-3xl font-bold text-white">Page Not Found</h1>
      <p className="mt-2 max-w-md text-sm text-slate-400">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/"
          className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-400/20"
        >
          Go to Dashboard
        </Link>
        <Link
          href="/help"
          className="rounded-lg border border-slate-700 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-slate-300 transition-colors hover:border-slate-600"
        >
          Help & Docs
        </Link>
      </div>
    </main>
  );
}
