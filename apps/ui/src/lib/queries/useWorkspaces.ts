import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "./client";
import { buildWorkspaceApiPath } from "../workspaces";

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
      const data = await fetchJson<{ workspaces?: WorkspaceSummary[] }>(buildWorkspaceApiPath("/api/workspaces"));
      return data.workspaces ?? [];
    },
    staleTime: 5000
  });
}
