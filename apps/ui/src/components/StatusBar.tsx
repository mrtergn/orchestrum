"use client";

import { useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";
import { WorkspaceSelector } from "@/components/WorkspaceSelector";

export function StatusBar() {
  const { openRunConfig } = useAppUi();
  const [cost, setCost] = useState("0.00");
  const [version, setVersion] = useState<string | null>(null);
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    setCost(localStorage.getItem("orchestrum.session.cost") ?? "0.00");
    const savedTheme = localStorage.getItem("orchestrum.theme") ?? "dark";
    setTheme(savedTheme);
    applyTheme(savedTheme);
  }, []);

  useEffect(() => {
    const load = async () => {
      const versionRes = await fetch("/api/meta/version", { cache: "no-store" });
      if (!versionRes.ok) return;
      const data = await versionRes.json();
      setVersion(data.version?.version ?? null);
    };
    void load();
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("orchestrum.theme", next);
    applyTheme(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
      <WorkspaceSelector />
      <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1">${cost}</span>
      {version && <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1">v{version}</span>}
      <button
        onClick={() => openRunConfig()}
        className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.15em] text-amber-200"
      >
        New Run
      </button>
      <button
        onClick={toggleTheme}
        className="rounded-md border border-slate-700 bg-slate-900/40 px-2.5 py-1 text-[10px] text-slate-400 hover:text-slate-200"
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
    </div>
  );
}

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "light") {
    root.classList.add("theme-light");
  } else {
    root.classList.remove("theme-light");
  }
}
