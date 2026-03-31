import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerDeliveryCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
