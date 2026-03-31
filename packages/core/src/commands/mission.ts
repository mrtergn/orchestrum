import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerMissionCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
