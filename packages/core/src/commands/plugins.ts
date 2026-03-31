import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerPluginsCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
