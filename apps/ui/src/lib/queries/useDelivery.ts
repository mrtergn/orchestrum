import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "./client";

export function useDeliverySummary(workspaceId?: string) {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return useQuery({
    queryKey: ["delivery", workspaceId ?? "all"],
    queryFn: () => fetchJson<Record<string, unknown>>(`/api/delivery/summary${query}`),
    staleTime: 5000
  });
}
