"use client";

export type DeliveryCapability = {
  id: string;
  kind: string;
  label: string;
  available: boolean;
  details?: string;
};

export type DeliveryBinding = {
  roleId: string;
  mode: string;
  target: string;
  available: boolean;
  reason?: string;
};

export type TeamPresetDraftRole = {
  id: string;
  label: string;
  description?: string;
  mode: "auto_cli" | "manual_browser" | "manual_ide" | "disabled";
  target: string;
  objective?: string;
  acceptanceCriteria: string[];
  expectedOutput: string[];
};

export type TeamPresetDraft = {
  version: 1;
  name: string;
  defaultRunMode: "max_auto_supervised_hybrid" | "manual_supervised";
  roles: TeamPresetDraftRole[];
  toolProfiles?: Record<string, { label?: string; guidance?: string[]; response_contract?: string[]; text_variant?: string }>;
  governanceDefaults?: Record<string, unknown>;
  packetTemplates?: Record<string, unknown>;
};

export const DELIVERY_TOOLS = ["chatgpt", "cursor", "codex", "copilot", "claude"] as const;

export function toolLabel(tool: string): string {
  switch (tool) {
    case "chatgpt":
      return "ChatGPT";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex";
    case "copilot":
      return "Copilot";
    case "claude":
      return "Claude";
    case "local-shell":
      return "Local Shell";
    default:
      return tool;
  }
}

export function targetOptionsForMode(
  mode: TeamPresetDraftRole["mode"],
  capabilities: DeliveryCapability[]
): string[] {
  const binaryTargets = capabilities
    .filter((capability) => capability.kind === "binary" && capability.available)
    .map((capability) => capability.id.replace(/^binary:/, ""));
  if (mode === "manual_browser") {
    return DELIVERY_TOOLS.filter((tool) => tool === "chatgpt" || tool === "claude");
  }
  if (mode === "manual_ide") {
    return Array.from(new Set(["cursor", "codex", "copilot", ...binaryTargets.filter((name) => ["cursor", "codex", "copilot", "code"].includes(name))]));
  }
  if (mode === "auto_cli") {
    return ["local-shell"];
  }
  return ["disabled"];
}

export function normalizeTeamPresetDraft(source: unknown, bindings: DeliveryBinding[] = []): TeamPresetDraft {
  const data = (source && typeof source === "object" ? source : {}) as Record<string, any>;
  const bindingMap = new Map(bindings.map((binding) => [binding.roleId, binding]));
  const roles = Array.isArray(data.roles) ? data.roles : [];
  return {
    version: 1,
    name: typeof data.name === "string" && data.name.trim() ? data.name : "Team Default",
    defaultRunMode: data.default_run_mode === "manual_supervised" ? "manual_supervised" : "max_auto_supervised_hybrid",
    toolProfiles: typeof data.tool_profiles === "object" && data.tool_profiles ? data.tool_profiles : undefined,
    governanceDefaults: typeof data.governance_defaults === "object" && data.governance_defaults ? data.governance_defaults : undefined,
    packetTemplates: typeof data.packet_templates === "object" && data.packet_templates ? data.packet_templates : undefined,
    roles: roles.map((role): TeamPresetDraftRole => {
      const binding = bindingMap.get(String(role.id ?? ""));
      const preferredTargets = Array.isArray(role.preferred_targets)
        ? role.preferred_targets.map((item: unknown) => String(item))
        : [];
      return {
        id: String(role.id ?? ""),
        label: typeof role.label === "string" ? role.label : String(role.id ?? ""),
        description: typeof role.description === "string" ? role.description : undefined,
        mode: role.mode === "auto_cli" || role.mode === "manual_browser" || role.mode === "manual_ide" || role.mode === "disabled"
          ? role.mode
          : "manual_browser",
        target: binding?.target || preferredTargets[0] || defaultTargetForRole(String(role.id ?? ""), role.mode),
        objective: typeof role.objective === "string" ? role.objective : undefined,
        acceptanceCriteria: Array.isArray(role.acceptance_criteria)
          ? role.acceptance_criteria.map((item: unknown) => String(item))
          : [],
        expectedOutput: Array.isArray(role.expected_output)
          ? role.expected_output.map((item: unknown) => String(item))
          : []
      };
    })
  };
}

export function serializeTeamPresetDraft(draft: TeamPresetDraft) {
  return {
    version: 1,
    name: draft.name.trim() || "Team Default",
    default_run_mode: draft.defaultRunMode,
    tool_profiles: draft.toolProfiles,
    governance_defaults: draft.governanceDefaults,
    packet_templates: draft.packetTemplates,
    roles: draft.roles.map((role) => ({
      id: role.id,
      label: role.label,
      description: role.description,
      mode: role.mode,
      preferred_targets: role.mode === "disabled" ? [] : [role.target].filter(Boolean),
      objective: role.objective,
      acceptance_criteria: role.acceptanceCriteria.filter(Boolean),
      expected_output: role.expectedOutput.filter(Boolean)
    })),
    tool_preferences: Object.fromEntries(
      draft.roles
        .filter((role) => role.mode !== "disabled" && role.target)
        .map((role) => [role.id, [role.target]])
    )
  };
}

function defaultTargetForRole(roleId: string, mode: string | undefined): string {
  if (mode === "auto_cli") return "local-shell";
  if (roleId === "developer") return "cursor";
  if (roleId === "auditor") return "claude";
  return "chatgpt";
}
