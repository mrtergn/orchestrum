import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { AppUiProvider } from "@/components/AppUiProvider";
import { RunConfigModal } from "@/components/RunConfigModal";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Notifications } from "@/components/Notifications";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export const metadata: Metadata = {
  title: {
    default: "Orchestrum — Work Launcher + Live Session",
    template: "%s | Orchestrum",
  },
  description: "Local-first AI repo work launcher with a supervised live session for baton flow, commands, changes, validation, and findings on your machine.",
  keywords: ["ai", "agents", "engineering", "automation", "local-first", "open-source", "orchestration"],
  authors: [{ name: "Orchestrum Contributors" }],
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.svg",
  },
  openGraph: {
    title: "Orchestrum — Work Launcher + Live Session",
    description: "Local-first AI repo work launcher with a supervised live session for baton flow, commands, changes, validation, and findings.",
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
          <div className="flex min-h-screen overflow-x-hidden">
            <Sidebar />
            <div className="min-h-screen min-w-0 flex-1 overflow-x-hidden px-5 py-5 lg:px-8 lg:py-6">
              <div className="mx-auto min-w-0 max-w-[1600px]">
                <header className="mb-4 flex flex-wrap items-center justify-end gap-3">
                  <StatusBar />
                </header>
                <div className="mb-5">
                  <ErrorBoundary fallbackTitle="Notifications failed to render.">
                    <Notifications />
                  </ErrorBoundary>
                </div>
                <ErrorBoundary fallbackTitle="Page content failed to render.">
                  {children}
                </ErrorBoundary>
              </div>
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
