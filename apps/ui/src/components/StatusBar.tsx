"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function StatusBar() {
  const [version, setVersion] = useState<string | null>(null);
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
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
      <Link
        href="/settings"
        className="rounded-md border border-slate-700 bg-slate-900/40 px-2.5 py-1 text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
      >
        Settings
      </Link>
      {version && <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1">v{version}</span>}
      <button
        onClick={toggleTheme}
        className="rounded-md border border-slate-700 bg-slate-900/40 px-2.5 py-1 text-[10px] text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      >
        {theme === "dark" ? "Light" : "Dark"}
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
