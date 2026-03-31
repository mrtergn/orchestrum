import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { AppUiProvider } from "@/components/AppUiProvider";
import { StatusCenter } from "@/components/StatusCenter";
import { RunConfigModal } from "@/components/RunConfigModal";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Notifications } from "@/components/Notifications";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export const metadata: Metadata = {
  title: {
    default: "Orchestrum — AI Engineering OS",
    template: "%s | Orchestrum",
  },
  description: "Local-first AI Engineering OS. Define agents, wire org charts, and let AI plan, build, audit, and deploy — all without sending code to third parties.",
  keywords: ["ai", "agents", "engineering", "automation", "local-first", "open-source", "orchestration"],
  authors: [{ name: "Orchestrum Contributors" }],
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.svg",
  },
  openGraph: {
    title: "Orchestrum — AI Engineering OS",
    description: "Local-first AI Engineering OS. Define agents, wire org charts, and let AI plan, build, audit, and deploy.",
    type: "website",
    siteName: "Orchestrum",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100">
        <AppUiProvider>
          <div className="flex">
            <Sidebar />
            <div className="min-h-screen flex-1 px-8 py-6">
              <header className="mb-6 flex flex-wrap items-center justify-end gap-3">
                <StatusBar />
              </header>
              <div className="mb-4">
                <ErrorBoundary fallbackTitle="Notifications failed to render.">
                  <Notifications />
                </ErrorBoundary>
              </div>
              <div className="mb-6">
                <ErrorBoundary fallbackTitle="Status Center failed to render.">
                  <StatusCenter />
                </ErrorBoundary>
              </div>
              <ErrorBoundary fallbackTitle="Page content failed to render.">
                {children}
              </ErrorBoundary>
            </div>
          </div>
          <RunConfigModal />
          <CommandPalette />
          <ConfirmDialog />
        </AppUiProvider>
      </body>
    </html>
  );
}
