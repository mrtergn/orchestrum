"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WorkspaceSelector } from "@/components/WorkspaceSelector";

type NavIcon =
  | "work"
  | "runs"
  | "browser"
  | "delivery"
  | "diagnostics"
  | "workspaces"
  | "settings"
  | "help"
  | "about";
type NavItem = { href: string; label: string; icon: NavIcon };
type NavGroup = { title: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    title: "Primary",
    items: [
      { href: "/work", label: "Work", icon: "work" },
      { href: "/runs", label: "Runs", icon: "runs" },
      { href: "/diagnostics", label: "Diagnostics", icon: "diagnostics" },
    ],
  },
  {
    title: "Manage",
    items: [
      { href: "/workspaces", label: "Workspaces", icon: "workspaces" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

const footerLinks: NavItem[] = [
  { href: "/help", label: "Help & Docs", icon: "help" },
  { href: "/about", label: "About", icon: "about" },
];

function OrchestrumMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className="h-9 w-9">
      <rect width="32" height="32" rx="8" fill="#0f172a" />
      <circle cx="16" cy="16" r="9" stroke="#38bdf8" strokeWidth="2" fill="none" />
      <circle cx="16" cy="16" r="4" fill="#38bdf8" />
      <line x1="16" y1="7" x2="16" y2="12" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="16" y1="20" x2="16" y2="25" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="7" y1="16" x2="12" y2="16" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="20" y1="16" x2="25" y2="16" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="9.6" y1="9.6" x2="12.8" y2="12.8" stroke="#38bdf8" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
      <line x1="19.2" y1="19.2" x2="22.4" y2="22.4" stroke="#38bdf8" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
      <line x1="22.4" y1="9.6" x2="19.2" y2="12.8" stroke="#38bdf8" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
      <line x1="12.8" y1="19.2" x2="9.6" y2="22.4" stroke="#38bdf8" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

function SidebarIcon({ icon, active }: { icon: NavIcon; active: boolean }) {
  const tone = active ? "text-amber-300" : "text-slate-500";
  const common = "h-4 w-4";

  switch (icon) {
    case "work":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 4.5V3h6v1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M3 9h14" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "runs":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 6.5v3.8l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "browser":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <rect x="3" y="4" width="14" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 7h14" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="6" cy="5.5" r=".7" fill="currentColor" />
          <circle cx="8.5" cy="5.5" r=".7" fill="currentColor" />
          <circle cx="11" cy="5.5" r=".7" fill="currentColor" />
        </svg>
      );
    case "delivery":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <path d="M4 7.5 10 4l6 3.5v5L10 16l-6-3.5v-5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M10 9 16 5.5M10 9 4 5.5M10 9v7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      );
    case "diagnostics":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 3.5v2M10 14.5v2M16.5 10h-2M5.5 10h-2M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4M14.6 14.6l-1.4-1.4M6.8 6.8 5.4 5.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "workspaces":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 8.5h14" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 11.5h2.5M11.5 11.5H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 3.7v1.6M10 14.7v1.6M16.3 10h-1.6M5.3 10H3.7M14.5 5.5l-1.2 1.2M6.7 13.3l-1.2 1.2M14.5 14.5l-1.2-1.2M6.7 6.7 5.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "help":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <path d="M8.9 8.1a1.7 1.7 0 1 1 2.8 1.3c-.8.6-1.2 1-1.2 1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="10" cy="14.2" r=".8" fill="currentColor" />
          <circle cx="10" cy="10" r="6.7" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "about":
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={`${common} ${tone}`}>
          <circle cx="10" cy="10" r="6.7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 8.4v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="10" cy="6" r=".8" fill="currentColor" />
        </svg>
      );
  }
}

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <aside className="flex h-screen w-64 flex-shrink-0 flex-col border-r border-slate-800/80 bg-slate-950/90">
      <div className="border-b border-slate-800/60 px-5 pb-4 pt-5">
        <Link href="/work" className="flex items-center gap-3 rounded-2xl p-1 transition-colors hover:bg-slate-900/70">
          <OrchestrumMark />
          <div>
            <div className="text-base font-semibold leading-tight text-white">Orchestrum</div>
            <div className="text-[11px] text-slate-500">Work Launcher + Live Session</div>
          </div>
        </Link>
      </div>

      <div className="border-b border-slate-800/60 px-4 py-3">
        <WorkspaceSelector className="w-full rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-200" />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {navGroups.map((group) => (
          <div key={group.title} className="mb-5">
            <div className="mb-2 px-2 text-[11px] font-medium text-slate-500">
              {group.title}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-colors ${
                      active
                        ? "bg-amber-400/10 text-amber-100 font-medium shadow-[inset_0_0_0_1px_rgba(251,191,36,0.16)]"
                        : "text-slate-400 hover:bg-slate-900/60 hover:text-slate-200"
                    }`}
                  >
                    <span className="flex h-5 w-5 items-center justify-center">
                      <SidebarIcon icon={item.icon} active={active} />
                    </span>
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-800/60 px-3 py-3">
        <div className="space-y-1.5">
          {footerLinks.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] transition-colors ${
                  active
                    ? "bg-slate-900/80 text-slate-100"
                    : "text-slate-400 hover:bg-slate-900/60 hover:text-slate-200"
                }`}
              >
                <span className="flex h-5 w-5 items-center justify-center">
                  <SidebarIcon icon={item.icon} active={active} />
                </span>
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-between px-3 text-[10px] text-slate-600">
          <div>Launch one item. Follow one session.</div>
          <kbd className="rounded border border-slate-800 bg-slate-900/40 px-1 py-0.5 text-[9px]">⌘K</kbd>
        </div>
      </div>
    </aside>
  );
}
