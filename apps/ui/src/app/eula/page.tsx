"use client";

import { useEffect, useState } from "react";

export default function EulaPage() {
  const [content, setContent] = useState("");

  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/meta/eula", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setContent(data.content ?? "");
    };
    load();
  }, []);

  return (
    <main className="space-y-6">
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h2 className="text-xl font-semibold text-white">License</h2>
        <p className="text-sm text-slate-400">Open source license</p>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <pre className="whitespace-pre-wrap text-xs text-slate-200">{content || "License not found."}</pre>
      </section>
    </main>
  );
}
