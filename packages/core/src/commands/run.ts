import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerRunCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
