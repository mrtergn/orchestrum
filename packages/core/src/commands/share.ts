import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerShareCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
