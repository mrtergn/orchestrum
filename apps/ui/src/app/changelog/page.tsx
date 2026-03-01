"use client";

import { useEffect, useMemo, useState } from "react";

type ChangelogEntry = {
  version: string;
  date: string;
  sections: { label: string; items: string[] }[];
};

function parseChangelog(raw: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const versionBlocks = raw.split(/^## /m).filter(Boolean);
  for (const block of versionBlocks) {
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const versionMatch = header.match(/\[?([^\]\s]+)\]?(?:\s*[-–—]\s*(.+))?/);
    const version = versionMatch?.[1] ?? header.trim();
    const date = versionMatch?.[2]?.trim() ?? "";
    const sections: { label: string; items: string[] }[] = [];
    let currentSection: { label: string; items: string[] } | null = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const sectionMatch = line.match(/^###\s+(.+)/);
      if (sectionMatch && sectionMatch[1]) {
        currentSection = { label: sectionMatch[1].trim(), items: [] };
        sections.push(currentSection);
        continue;
      }
      const itemMatch = line.match(/^[-*]\s+(.+)/);
      if (itemMatch && itemMatch[1] && currentSection) {
        currentSection.items.push(itemMatch[1].trim());
      } else if (itemMatch && itemMatch[1]) {
        if (!currentSection) {
          currentSection = { label: "Changes", items: [] };
          sections.push(currentSection);
        }
        currentSection.items.push(itemMatch[1].trim());
      }
    }
    if (version) entries.push({ version, date, sections });
  }
  return entries;
}

function sectionColor(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("add") || l.includes("new") || l.includes("feature")) return "text-emerald-400";
  if (l.includes("fix") || l.includes("bug")) return "text-amber-400";
  if (l.includes("break") || l.includes("remove") || l.includes("deprecat")) return "text-rose-400";
  if (l.includes("change") || l.includes("refactor") || l.includes("improve")) return "text-cyan-400";
  return "text-slate-400";
}

export default function ChangelogPage() {
  const [content, setContent] = useState("");

  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/meta/changelog", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setContent(data.content ?? "");
    };
    load();
  }, []);

  const entries = useMemo(() => parseChangelog(content), [content]);

  return (
    <main className="space-y-6">
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h2 className="text-xl font-semibold text-white">Changelog</h2>
        <p className="text-sm text-slate-400">
          {entries.length > 0 ? `${entries.length} release${entries.length !== 1 ? "s" : ""} documented` : "Release history"}
        </p>
      </section>

      {!content && (
        <div className="rounded-2xl border border-dashed border-slate-700 p-8 text-center">
          <div className="text-2xl">📝</div>
          <h3 className="mt-2 text-lg font-semibold text-white">No changelog found</h3>
          <p className="mt-1 text-sm text-slate-400">The changelog will appear here once it&apos;s available.</p>
        </div>
      )}

      {entries.length > 0 ? (
        <section className="space-y-4">
          {entries.map((entry) => (
            <article key={entry.version} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="rounded-lg bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
                    v{entry.version}
                  </span>
                  {entry.date && <span className="text-xs text-slate-500">{entry.date}</span>}
                </div>
              </div>
              {entry.sections.map((section) => (
                <div key={section.label} className="mt-4">
                  <div className={`text-[10px] font-medium uppercase tracking-[0.2em] ${sectionColor(section.label)}`}>
                    {section.label}
                  </div>
                  <ul className="mt-2 space-y-1">
                    {section.items.map((item, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-xs text-slate-300">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-slate-600" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </article>
          ))}
        </section>
      ) : content ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
          <pre className="whitespace-pre-wrap text-xs leading-relaxed text-slate-200">{content}</pre>
        </section>
      ) : null}
    </main>
  );
}
