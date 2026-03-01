"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WorkspaceSelector } from "@/components/WorkspaceSelector";

type NavItem = { href: string; label: string; icon: string };
type NavGroup = { title: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    title: "Command",
    items: [
      { href: "/", label: "Dashboard", icon: "◉" },
      { href: "/agents", label: "Agents", icon: "◆" },
      { href: "/org", label: "Org Chart", icon: "⬡" },
      { href: "/tasks", label: "Tasks", icon: "▶" },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/workspaces", label: "Workspaces", icon: "◫" },
      { href: "/templates", label: "Templates", icon: "❖" },
      { href: "/plugins", label: "Plugins", icon: "⧉" },
    ],
  },
  {
    title: "Observe",
    items: [
      { href: "/mission", label: "Live Feed", icon: "◈" },
      { href: "/metrics", label: "Metrics", icon: "▤" },
      { href: "/roadmap", label: "Roadmap", icon: "◧" },
      { href: "/diagnostics", label: "Diagnostics", icon: "⚙" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/settings", label: "Settings", icon: "⚙" },
      { href: "/help", label: "Help & Docs", icon: "?" },
      { href: "/about", label: "About", icon: "ⓘ" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <aside className="flex h-screen w-56 flex-shrink-0 flex-col border-r border-slate-800 bg-slate-950/80">
      {/* Brand */}
      <div className="border-b border-slate-800/60 px-5 pb-4 pt-5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400/20 to-cyan-400/20 text-xs text-amber-300">◉</div>
          <div>
            <div className="text-sm font-semibold text-white leading-tight">Orchestrum</div>
            <div className="text-[10px] text-slate-500">AI Engineering OS</div>
          </div>
        </div>
      </div>

      {/* Workspace selector */}
      <div className="border-b border-slate-800/60 px-4 py-3">
        <WorkspaceSelector className="w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-200" />
      </div>

      {/* Navigation groups */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {navGroups.map((group) => (
          <div key={group.title} className="mb-4">
            <div className="mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.2em] text-slate-600">
              {group.title}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                      active
                        ? "bg-amber-400/10 text-amber-200 font-medium"
                        : "text-slate-400 hover:bg-slate-900/60 hover:text-slate-200"
                    }`}
                  >
                    <span className={`text-[11px] w-4 text-center ${active ? "text-amber-300" : "text-slate-600"}`}>{item.icon}</span>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-800/60 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-slate-600">Local-first · Open source</div>
          <div className="flex items-center gap-1 text-[10px] text-slate-600">
            <kbd className="rounded border border-slate-800 bg-slate-900/40 px-1 py-0.5 text-[9px]">⌘K</kbd>
          </div>
        </div>
      </div>
    </aside>
  );
}
