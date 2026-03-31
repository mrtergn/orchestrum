import type { DeliveryTargetTool } from "./types.js";

export type ToolProfileMap = Record<DeliveryTargetTool, { title: string; guidance: string[] }>;

export const BUILTIN_TOOL_PROFILES: ToolProfileMap = {
  chatgpt: { title: "ChatGPT", guidance: [] },
  cursor: { title: "Cursor", guidance: [] },
  codex: { title: "Codex", guidance: [] },
  copilot: { title: "Copilot", guidance: [] },
  claude: { title: "Claude", guidance: [] }
};
