"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type ToastTone = "info" | "warning" | "danger" | "success";

export type AppToast = {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
  actionLabel?: string;
  actionHref?: string;
  actionPayload?: { type: "retry-run"; runId: string; workspaceId?: string };
};

export type RunConfigSeed = {
  workspaceId?: string;
  workflowId?: string;
  userGoal?: string;
  runKind?: "workflow" | "qa" | "benchmark" | "canary";
  baseUrl?: string;
  targetPath?: string;
};

type RunFiltersState = {
  search: string;
  status: string;
  tag: string;
  since: string;
};

type AppUiContextValue = {
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: (workspaceId: string) => void;
  lastTemplate: string;
  setLastTemplate: (template: string) => void;
  runFilters: RunFiltersState;
  setRunFilters: (filters: RunFiltersState) => void;
  runConfigOpen: boolean;
  runConfigSeed: RunConfigSeed | null;
  openRunConfig: (seed?: RunConfigSeed) => void;
  closeRunConfig: () => void;
  commandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toasts: AppToast[];
  pushToast: (toast: Omit<AppToast, "id"> & { id?: string }) => void;
  dismissToast: (id: string) => void;
  onboardingSkipped: boolean;
  setOnboardingSkipped: (value: boolean) => void;
};

const STORAGE_KEYS = {
  workspace: "orchestrum.workspace",
  lastTemplate: "orchestrum.ui.lastTemplate",
  runFilters: "orchestrum.ui.runFilters",
  onboardingSkipped: "orchestrum.onboarding.skipped"
} as const;

const DEFAULT_FILTERS: RunFiltersState = {
  search: "",
  status: "",
  tag: "",
  since: ""
};

const AppUiContext = createContext<AppUiContextValue | null>(null);

export function AppUiProvider({ children }: { children: React.ReactNode }) {
  const [selectedWorkspaceId, setSelectedWorkspaceIdState] = useState("");
  const [lastTemplate, setLastTemplateState] = useState("feature-dev.yaml");
  const [runFilters, setRunFiltersState] = useState<RunFiltersState>(DEFAULT_FILTERS);
  const [runConfigOpen, setRunConfigOpen] = useState(false);
  const [runConfigSeed, setRunConfigSeed] = useState<RunConfigSeed | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const [onboardingSkipped, setOnboardingSkippedState] = useState(false);

  useEffect(() => {
    const workspace = localStorage.getItem(STORAGE_KEYS.workspace) ?? "";
    const template = localStorage.getItem(STORAGE_KEYS.lastTemplate) ?? "feature-dev.yaml";
    const savedFilters = localStorage.getItem(STORAGE_KEYS.runFilters);
    const skipped = localStorage.getItem(STORAGE_KEYS.onboardingSkipped) === "1";
    setSelectedWorkspaceIdState(workspace);
    setLastTemplateState(template);
    if (savedFilters) {
      try {
        const parsed = JSON.parse(savedFilters) as Partial<RunFiltersState>;
        setRunFiltersState({
          search: parsed.search ?? "",
          status: parsed.status ?? "",
          tag: parsed.tag ?? "",
          since: parsed.since ?? ""
        });
      } catch {
        setRunFiltersState(DEFAULT_FILTERS);
      }
    }
    setOnboardingSkippedState(skipped);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isOpenShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isOpenShortcut) return;
      event.preventDefault();
      setCommandPaletteOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const setSelectedWorkspaceId = useCallback((workspaceId: string) => {
    setSelectedWorkspaceIdState(workspaceId);
    localStorage.setItem(STORAGE_KEYS.workspace, workspaceId);
  }, []);

  const setLastTemplate = useCallback((template: string) => {
    setLastTemplateState(template);
    localStorage.setItem(STORAGE_KEYS.lastTemplate, template);
  }, []);

  const setRunFilters = useCallback((filters: RunFiltersState) => {
    setRunFiltersState(filters);
    localStorage.setItem(STORAGE_KEYS.runFilters, JSON.stringify(filters));
  }, []);

  const openRunConfig = useCallback((seed?: RunConfigSeed) => {
    setRunConfigSeed(seed ?? null);
    setRunConfigOpen(true);
  }, []);

  const closeRunConfig = useCallback(() => {
    setRunConfigOpen(false);
    setRunConfigSeed(null);
  }, []);

  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<AppToast, "id"> & { id?: string }) => {
    const id = toast.id ?? `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setToasts((prev) => {
      if (prev.some((item) => item.id === id)) return prev;
      const next: AppToast = { ...toast, id };
      return [next, ...prev].slice(0, 6);
    });
  }, []);

  const setOnboardingSkipped = useCallback((value: boolean) => {
    setOnboardingSkippedState(value);
    if (value) {
      localStorage.setItem(STORAGE_KEYS.onboardingSkipped, "1");
    } else {
      localStorage.removeItem(STORAGE_KEYS.onboardingSkipped);
    }
  }, []);

  const value = useMemo<AppUiContextValue>(
    () => ({
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      lastTemplate,
      setLastTemplate,
      runFilters,
      setRunFilters,
      runConfigOpen,
      runConfigSeed,
      openRunConfig,
      closeRunConfig,
      commandPaletteOpen,
      openCommandPalette,
      closeCommandPalette,
      toasts,
      pushToast,
      dismissToast,
      onboardingSkipped,
      setOnboardingSkipped
    }),
    [
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      lastTemplate,
      setLastTemplate,
      runFilters,
      setRunFilters,
      runConfigOpen,
      runConfigSeed,
      openRunConfig,
      closeRunConfig,
      commandPaletteOpen,
      openCommandPalette,
      closeCommandPalette,
      toasts,
      pushToast,
      dismissToast,
      onboardingSkipped,
      setOnboardingSkipped
    ]
  );

  return <AppUiContext.Provider value={value}>{children}</AppUiContext.Provider>;
}

export function useAppUi() {
  const context = useContext(AppUiContext);
  if (!context) {
    throw new Error("useAppUi must be used within AppUiProvider");
  }
  return context;
}
