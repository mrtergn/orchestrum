import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "./client";

export type WorkspaceSummary = {
  id: string;
  name?: string;
  path: string;
  status?: string;
  validation?: {
    exists: boolean;
    readable: boolean;
    isDirectory: boolean;
    isGitRepo: boolean;
    error?: string;
  };
};

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const data = await fetchJson<{ workspaces?: WorkspaceSummary[] }>("/api/workspaces");
      return data.workspaces ?? [];
    },
    staleTime: 5000
  });
}
