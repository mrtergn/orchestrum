import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerWorkspaceCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
