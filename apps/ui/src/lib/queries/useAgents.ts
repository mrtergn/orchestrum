import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "./client";

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const data = await fetchJson<{ agents?: unknown[] }>("/api/agents");
      return data.agents ?? [];
    },
    staleTime: 5000
  });
}
