"use client";

import { useEffect, useState } from "react";
import { useAppUi } from "@/components/AppUiProvider";

type Workspace = {
  id: string;
  name?: string;
  path: string;
};

export function WorkspaceSelector({
  className,
  includeAll = true
}: {
  className?: string;
  includeAll?: boolean;
}) {
  const { selectedWorkspaceId, setSelectedWorkspaceId } = useAppUi();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/workspaces", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setWorkspaces(data.workspaces ?? []);
    };
    void load();
  }, []);

  return (
    <select
      value={selectedWorkspaceId}
      onChange={(event) => setSelectedWorkspaceId(event.target.value)}
      className={className ?? "rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-200"}
    >
      {includeAll && <option value="">All Workspaces</option>}
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name || workspace.id}
        </option>
      ))}
      {!includeAll && workspaces.length === 0 && <option value="">No workspaces</option>}
    </select>
  );
}
