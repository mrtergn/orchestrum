"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SurfacePanel } from "@/components/ui/PagePrimitives";

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
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index];
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

export default function ChangelogPage() {
  const [content, setContent] = useState("");

  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/meta/changelog", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setContent(data.content ?? "");
    };
    void load();
  }, []);

  const entries = useMemo(() => parseChangelog(content), [content]);

  return (
    <main className="page-shell">
      <PageHeader
        eyebrow="Support"
        title="Changelog"
        description="Release notes stay available here for desktop, runtime, and product changes."
      />

      {!content ? (
        <EmptyState
          icon="📝"
          title="No changelog found"
          description="The changelog will appear here once release notes are available."
        />
      ) : entries.length > 0 ? (
        <section className="space-y-4">
          {entries.map((entry) => (
            <SurfacePanel key={entry.version} title={`v${entry.version}`} description={entry.date || "Release notes"}>
              <div className="space-y-4">
                {entry.sections.map((section) => (
                  <div key={section.label}>
                    <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">{section.label}</div>
                    <div className="mt-2 space-y-2">
                      {section.items.map((item, index) => (
                        <div key={`${section.label}:${index}`} className="text-sm text-slate-300">
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </SurfacePanel>
          ))}
        </section>
      ) : (
        <SurfacePanel title="Raw changelog">
          <pre className="inspect-scroll max-h-[720px] whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-200">
            {content}
          </pre>
        </SurfacePanel>
      )}
    </main>
  );
}
