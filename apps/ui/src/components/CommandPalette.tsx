"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAppUi } from "@/components/AppUiProvider";
import { ModalFrame } from "@/components/ModalFrame";

type ActionItem = {
  id: string;
  label: string;
  section: string;
  shortcut?: string;
  run: () => void;
};

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const { commandPaletteOpen, closeCommandPalette, openRunConfig } = useAppUi();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const actions = useMemo<ActionItem[]>(
    () => [
      { id: "new-run", label: "New Run", section: "Actions", shortcut: "⌘N", run: () => openRunConfig() },
      { id: "nav-dashboard", label: "Go to Dashboard", section: "Navigation", run: () => router.push("/") },
      { id: "nav-work", label: "Go to Work", section: "Navigation", run: () => router.push("/work") },
      { id: "nav-agents", label: "Go to Specialists", section: "Navigation", run: () => router.push("/agents") },
      { id: "nav-org", label: "Go to Team Map", section: "Navigation", run: () => router.push("/org") },
      { id: "nav-browser", label: "Go to Browser Smoke", section: "Navigation", run: () => router.push("/browser") },
      { id: "nav-workspaces", label: "Go to Workspaces", section: "Navigation", run: () => router.push("/workspaces") },
      { id: "nav-templates", label: "Go to Mission Templates", section: "Navigation", run: () => router.push("/templates") },
      { id: "nav-plugins", label: "Go to Plugins", section: "Navigation", run: () => router.push("/plugins") },
      { id: "nav-runs", label: "Go to Runs", section: "Navigation", run: () => router.push("/runs") },
      { id: "nav-mission", label: "Go to Execution Feed", section: "Navigation", run: () => router.push("/mission") },
      { id: "nav-metrics", label: "Go to Metrics", section: "Navigation", run: () => router.push("/metrics") },
      { id: "nav-settings", label: "Open Settings", section: "Navigation", run: () => router.push("/settings") },
      { id: "nav-diagnostics", label: "Go to Diagnostics", section: "Navigation", run: () => router.push("/diagnostics") },
      { id: "nav-help", label: "Open Help & Docs", section: "Navigation", run: () => router.push("/help") },
      { id: "nav-about", label: "About Orchestrum", section: "Navigation", run: () => router.push("/about") },
      { id: "nav-changelog", label: "View Changelog", section: "Navigation", run: () => router.push("/changelog") },
    ],
    [openRunConfig, router]
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const needle = query.trim().toLowerCase();
    return actions.filter(
      (a) => a.label.toLowerCase().includes(needle) || a.section.toLowerCase().includes(needle)
    );
  }, [actions, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ActionItem[]>();
    for (const item of filtered) {
      const group = map.get(item.section) ?? [];
      group.push(item);
      map.set(item.section, group);
    }
    return map;
  }, [filtered]);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [commandPaletteOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const executeAction = useCallback((action: ActionItem) => {
    closeCommandPalette();
    action.run();
  }, [closeCommandPalette]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const action = filtered[selectedIndex];
        if (action) executeAction(action);
      }
    },
    [filtered, selectedIndex, executeAction]
  );

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  let flatIndex = -1;

  return (
    <ModalFrame
      open={commandPaletteOpen}
      onClose={closeCommandPalette}
      ariaLabel="Command palette"
      overlayClassName="z-50 bg-slate-950/70 p-4"
      containerClassName="items-start pt-[10vh]"
      panelClassName="animate-in w-full max-w-xl overflow-hidden"
      panelProps={{ onKeyDown: handleKeyDown }}
    >
        {/* Search input */}
        <div className="border-b border-slate-800/60 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search..."
            aria-label="Command palette search"
            className="w-full bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-slate-500">
              No matching commands found.
            </div>
          )}
          {Array.from(grouped.entries()).map(([section, items]) => (
            <div key={section}>
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.2em] text-slate-600">
                {section}
              </div>
              {items.map((action) => {
                flatIndex++;
                const idx = flatIndex;
                const isSelected = idx === selectedIndex;
                return (
                  <button
                    key={action.id}
                    data-index={idx}
                    onClick={() => executeAction(action)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      isSelected
                        ? "bg-amber-400/10 text-amber-200"
                        : "text-slate-300 hover:bg-slate-900/60"
                    }`}
                  >
                    <span>{action.label}</span>
                    {action.shortcut && (
                      <kbd className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[10px] text-slate-500">
                        {action.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-800/60 px-4 py-2.5 text-[11px] text-slate-500">
          <div className="flex items-center gap-3">
            <span><kbd className="rounded border border-slate-700 bg-slate-800/60 px-1 py-0.5 text-[10px]">↑↓</kbd> navigate</span>
            <span><kbd className="rounded border border-slate-700 bg-slate-800/60 px-1 py-0.5 text-[10px]">↵</kbd> select</span>
            <span><kbd className="rounded border border-slate-700 bg-slate-800/60 px-1 py-0.5 text-[10px]">esc</kbd> close</span>
          </div>
          <span>{filtered.length} command{filtered.length !== 1 ? "s" : ""}</span>
        </div>
    </ModalFrame>
  );
}
