import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "./client";

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => fetchJson<Record<string, unknown>>("/api/config"),
    staleTime: 5000
  });
}
