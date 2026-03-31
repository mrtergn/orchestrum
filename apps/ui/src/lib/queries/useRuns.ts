import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "./client";

export type RunSummary = {
  runId: string;
  status: string;
  workspaceId?: string;
  error?: string | null;
};

export function useRuns(workspaceId?: string) {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
  return useQuery({
    queryKey: ["runs", workspaceId ?? "all"],
    queryFn: () => fetchJson<RunSummary[]>(`/api/runs${query}`),
    staleTime: 5000
  });
}
