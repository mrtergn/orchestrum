"use client";

import Link from "next/link";
import { useAppUi } from "@/components/AppUiProvider";

const K = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-amber-300 font-mono">{children}</code>
);

export default function HelpPage() {
  const { openRunConfig } = useAppUi();

  return (
    <main className="space-y-6">
      {/* Header */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400/20 to-amber-400/5 text-lg text-amber-300">?</span>
          <div>
            <h2 className="text-xl font-semibold text-white">Help &amp; Guides</h2>
            <p className="text-sm text-slate-400">Setup instructions, usage tips, and troubleshooting.</p>
          </div>
        </div>
      </section>

      {/* Quick Start */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <span className="text-amber-400">①</span> Quick Start
        </h3>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-300">
          <li>Add a local workspace on the <Link href="/workspaces" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">Workspaces</Link> page.</li>
          <li>Set <K>OPENAI_API_KEY</K> (or another provider key) in <Link href="/settings" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">Settings → AI Providers</Link>.</li>
          <li>Pick a workflow template from <Link href="/templates" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">Templates</Link> and start a run.</li>
          <li>Watch the live graph and logs on the <strong className="text-white">Run Detail</strong> page.</li>
          <li>Inspect step artifacts to verify outputs and patches.</li>
        </ol>
      </section>

      {/* First Run Tutorial */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <span className="text-amber-400">②</span> First Run Tutorial
        </h3>
        <div className="mt-3 space-y-3 text-sm text-slate-300">
          <p className="text-slate-400">Use the onboarding wizard shown on first launch, or follow these steps manually:</p>
          <div className="grid gap-2">
            <div className="flex items-start gap-3 rounded-lg border border-slate-800/50 bg-slate-900/30 p-3">
              <span className="mt-0.5 text-xs font-bold text-amber-400/80">1</span>
              <span>Open <Link href="/workspaces" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">Workspaces</Link> and add a repo path.</span>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-slate-800/50 bg-slate-900/30 p-3">
              <span className="mt-0.5 text-xs font-bold text-amber-400/80">2</span>
              <span>Open <Link href="/settings" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">Settings</Link> and save your <K>OPENAI_API_KEY</K> or <K>ANTHROPIC_API_KEY</K>.</span>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-slate-800/50 bg-slate-900/30 p-3">
              <span className="mt-0.5 text-xs font-bold text-amber-400/80">3</span>
              <span>Open <Link href="/templates" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">Templates</Link>, choose a template, click <strong className="text-white">Run</strong>.</span>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-slate-800/50 bg-slate-900/30 p-3">
              <span className="mt-0.5 text-xs font-bold text-amber-400/80">4</span>
              <span>Open the created run and verify graph updates + artifact generation.</span>
            </div>
          </div>
        </div>
        <button
          onClick={() => openRunConfig()}
          className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-amber-200 hover:bg-amber-400/20 transition-colors"
        >
          Start New Run
        </button>
      </section>

      {/* Keyboard Shortcuts */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <span className="text-amber-400">③</span> Keyboard Shortcuts
        </h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            ["⌘ K / Ctrl+K", "Open Command Palette"],
            ["⌘ N / Ctrl+N", "New Run"],
            ["↑ ↓", "Navigate palette items"],
            ["Enter", "Select palette action"],
            ["Escape", "Close dialogs / palette"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between rounded-lg border border-slate-800/50 bg-slate-900/30 px-3 py-2 text-sm">
              <span className="text-slate-400">{desc}</span>
              <kbd className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">{key}</kbd>
            </div>
          ))}
        </div>
      </section>

      {/* Troubleshooting */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <span className="text-amber-400">④</span> Troubleshooting
        </h3>
        <div className="mt-3 space-y-2">
          {[
            ["Runs fail immediately", "Test your provider connection in Settings → AI Providers."],
            ["Workspace shows invalid", "Re-check the path in Workspaces — the directory must exist and be readable."],
            ["Live graph is empty", "Confirm the run exists and try opening the run detail URL directly."],
            ["Need more details", <>Use the <Link href="/diagnostics" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">Diagnostics</Link> page to export logs for debugging.</>],
          ].map(([title, desc], i) => (
            <div key={i} className="flex items-start gap-3 rounded-lg border border-slate-800/50 bg-slate-900/30 p-3 text-sm">
              <span className="mt-0.5 text-amber-400/60">●</span>
              <div>
                <span className="font-medium text-white">{title}</span>
                <p className="mt-0.5 text-slate-400">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Resources */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-6">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <span className="text-amber-400">⑤</span> Resources
        </h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            ["📖 Documentation", "https://github.com/nicholasconfer/orchestrum#readme", "README & architecture docs"],
            ["🐛 Report an Issue", "https://github.com/nicholasconfer/orchestrum/issues", "Bug reports & feature requests"],
            ["💬 Discussions", "https://github.com/nicholasconfer/orchestrum/discussions", "Community Q&A"],
            ["📋 Changelog", "/changelog", "Release history & updates"],
          ].map(([label, href, desc]) => (
            <a
              key={label}
              href={href}
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
              className="flex items-start gap-3 rounded-lg border border-slate-800/50 bg-slate-900/30 p-3 text-sm hover:bg-slate-800/30 transition-colors"
            >
              <div>
                <span className="font-medium text-white">{label}</span>
                <p className="mt-0.5 text-slate-500">{desc}</p>
              </div>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}
