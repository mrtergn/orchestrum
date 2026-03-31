import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerAgentsCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
