"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  hasAnyLocalProvider,
  hasConfiguredLocalProvider,
  orderProviderDiscovery,
  type ProviderDiscoveryRecord
} from "@/lib/providers";
import { fetchJson } from "./client";

type Scope = "workspace" | "global";

type ProviderDiscoveryPayload = {
  providers?: ProviderDiscoveryRecord[];
};

type UseProviderDiscoveryOptions = {
  scope: Scope;
  workspaceId?: string;
  enabled?: boolean;
};

export function useProviderDiscovery({ scope, workspaceId, enabled = true }: UseProviderDiscoveryOptions) {
  const effectiveEnabled = enabled && (scope === "global" || Boolean(workspaceId));
  const query = scope === "workspace" && workspaceId
    ? `?scope=workspace&workspace=${encodeURIComponent(workspaceId)}`
    : `?scope=${scope}`;

  const result = useQuery({
    queryKey: ["providers", scope, workspaceId ?? "global"],
    queryFn: () => fetchJson<ProviderDiscoveryPayload>(`/api/providers/discover${query}`),
    staleTime: 30000,
    retry: false,
    enabled: effectiveEnabled
  });

  const providers = useMemo(
    () => orderProviderDiscovery(Array.isArray(result.data?.providers) ? result.data?.providers ?? [] : []),
    [result.data?.providers]
  );

  return {
    providers,
    isLoading: result.isLoading || (result.isFetching && !result.data),
    error: result.error instanceof Error ? result.error.message : "",
    isSuccess: result.isSuccess,
    hasConfiguredLocalProvider: hasConfiguredLocalProvider(providers),
    hasAnyLocalProvider: hasAnyLocalProvider(providers)
  };
}
