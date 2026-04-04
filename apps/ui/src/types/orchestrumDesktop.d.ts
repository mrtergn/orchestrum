export {};

declare global {
  interface Window {
    orchestrumDesktop?: {
      pickDirectory?: () => Promise<string | null>;
      runtimeStatus?: () => Promise<{
        boot?: {
          status?: string;
          startedAt?: string | null;
          completedAt?: string | null;
          lastError?: string | null;
        };
        ports?: {
          service?: number;
          ui?: number;
        };
        paths?: {
          operatorRoot?: string;
          installRoot?: string;
          serviceRoot?: string;
          uiRoot?: string;
        } | null;
        service?: {
          kind?: string;
          status?: string;
          pid?: number | null;
          lastStartedAt?: string | null;
          lastExitAt?: string | null;
          lastExitCode?: number | null;
          lastExitSignal?: string | null;
          lastError?: string | null;
          restartCountInWindow?: number;
        };
        ui?: {
          kind?: string;
          status?: string;
          pid?: number | null;
          lastStartedAt?: string | null;
          lastExitAt?: string | null;
          lastExitCode?: number | null;
          lastExitSignal?: string | null;
          lastError?: string | null;
          restartCountInWindow?: number;
        };
      }>;
      restartService?: () => Promise<unknown>;
      restartUi?: () => Promise<unknown>;
    };
  }
}
