"use client";

import Link from "next/link";
import {
  NoticePanel,
  PageHeader,
  SurfacePanel
} from "@/components/ui/PagePrimitives";

const steps = [
  {
    title: "Register a workspace",
    description: "Use Workspaces once to register the local repo you want Orchestrum to operate on.",
    href: "/workspaces",
    cta: "Open Workspaces"
  },
  {
    title: "Open Work",
    description: "Work is the normal operator surface after the repo is registered.",
    href: "/work",
    cta: "Open Work"
  },
  {
    title: "Connect a provider",
    description: "Use local CLI auth when possible. API keys remain an optional fallback in Settings.",
    href: "/settings",
    cta: "Open Settings"
  },
  {
    title: "Pick a team preset if needed",
    description: "You should not need to create agents one by one. Use a preset first, then keep moving.",
    href: "/settings",
    cta: "Open Team Presets"
  },
  {
    title: "Start work",
    description: "Use Work to launch Feature, Audit, or Browser Smoke, then stay with the live session instead of hopping across side pages.",
    href: "/work",
    cta: "Open Work"
  },
  {
    title: "Review the live session",
    description: "Use the work item detail as the main screen. Open Runs only when you need execution history or deeper troubleshooting.",
    href: "/work",
    cta: "Open Live Session"
  },
  {
    title: "Open Diagnostics only when needed",
    description: "Diagnostics is the inspect surface for provider detection, runtime health, and repair actions.",
    href: "/diagnostics",
    cta: "Open Diagnostics"
  }
];

export default function HelpPage() {
  return (
    <main className="page-shell">
      <PageHeader
        eyebrow="Help"
        title="Use Orchestrum without guessing"
        description="The fastest path is Work, provider setup if needed, then Live Session. Runs and Diagnostics only matter after the main session stops being enough."
        actions={
          <Link
            href="/work"
            className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-medium text-amber-200"
          >
            Open Work
          </Link>
        }
      />

        <NoticePanel tone="info" title="Recommended default">
        Register the repo in <strong className="text-white">Workspaces</strong>, then use <strong className="text-white">Work</strong> to launch one item and follow its <strong className="text-white">Live Session</strong>. Use <strong className="text-white">Runs</strong> only for history and troubleshooting.
      </NoticePanel>

      <section className="grid gap-4 xl:grid-cols-2">
        <SurfacePanel
          title="Quick start"
          description="Follow this order on a fresh machine or a new workspace."
        >
          <div className="space-y-3">
            {steps.map((step, index) => (
              <div key={step.title} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
                      Step {index + 1}
                    </div>
                    <div className="text-sm font-semibold text-white">{step.title}</div>
                    <div className="text-sm text-slate-400">{step.description}</div>
                  </div>
                  <Link href={step.href} className="text-xs font-medium text-cyan-300 hover:text-cyan-200">
                    {step.cta} →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </SurfacePanel>

        <SurfacePanel
          title="When something feels off"
          description="Only drop into lower-level pages when the guided flow stops being enough."
        >
          <div className="space-y-3">
            {[
              {
                title: "Provider or CLI not detected",
                body: "Open Settings first. Diagnostics is only for confirming the machine state after provider setup still looks wrong.",
                href: "/settings"
              },
              {
                title: "A run looks stuck or unclear",
                body: "Open the work item first. Use Runs only if the live session no longer explains the failing step, logs, or artifacts.",
                href: "/work"
              },
              {
                title: "Desktop shell behaves strangely",
                body: "Open Diagnostics for runtime health, restart actions, and support bundle export.",
                href: "/diagnostics"
              },
              {
                title: "Need docs or release notes",
                body: "Open About for product status, updates, and links to deeper documentation when the main workflow is not enough.",
                href: "/about"
              }
            ].map((item) => (
              <div key={item.title} className="rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-4">
                <div className="text-sm font-semibold text-white">{item.title}</div>
                <div className="mt-1 text-sm text-slate-400">{item.body}</div>
                <Link href={item.href} className="mt-3 inline-flex text-xs font-medium text-cyan-300 hover:text-cyan-200">
                  Open →
                </Link>
              </div>
            ))}
          </div>
        </SurfacePanel>
      </section>

      <section className="page-columns">
        <SurfacePanel
          title="Reference links"
          description="Use these for documentation and release notes, not for first-run navigation."
        >
          <div className="space-y-3">
            <a
              href="https://github.com/mrtergn/orchestrum#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              README
            </a>
            <a
              href="https://github.com/mrtergn/orchestrum/blob/main/docs/ARCHITECTURE.md"
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              Architecture
            </a>
            <Link
              href="/about"
              className="block rounded-2xl border border-slate-800 bg-slate-900/35 px-4 py-3 text-sm text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              About and update status
            </Link>
          </div>
        </SurfacePanel>
      </section>
    </main>
  );
}
