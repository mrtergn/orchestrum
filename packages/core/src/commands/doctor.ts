import type { Command } from "commander";
import { registerCommandRegistryOnce } from "./registry.js";

export function registerDoctorCommands(program: Command): void {
  registerCommandRegistryOnce(program);
}
