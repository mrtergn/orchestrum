import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerServiceCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
