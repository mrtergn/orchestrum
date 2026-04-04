"use client";

import { useEffect, useState } from "react";
import { PageHeader, SurfacePanel } from "@/components/ui/PagePrimitives";

export default function EulaPage() {
  const [content, setContent] = useState("");

  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/meta/eula", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setContent(data.content ?? "");
    };
    void load();
  }, []);

  return (
    <main className="page-shell">
      <PageHeader
        eyebrow="Support"
        title="License"
        description="Open-source license text for the current Orchestrum build."
      />

      <SurfacePanel title="MIT license">
        <pre className="inspect-scroll max-h-[720px] whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-200">
          {content || "License not found."}
        </pre>
      </SurfacePanel>
    </main>
  );
}
