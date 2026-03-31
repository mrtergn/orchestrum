import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerConfigCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
