import type { Command } from "commander";
import { registerWorkspaceCommands } from "./workspace.js";
import { registerRunCommands } from "./run.js";
import { registerDeliveryCommands } from "./delivery.js";
import { registerAgentsCommands } from "./agents.js";
import { registerPluginsCommands } from "./plugins.js";
import { registerMissionCommands } from "./mission.js";
import { registerEvolutionCommands } from "./evolution.js";
import { registerConfigCommands } from "./config.js";
import { registerDoctorCommands } from "./doctor.js";
import { registerServiceCommands } from "./service.js";
import { registerShareCommands } from "./share.js";

export function registerCommands(program: Command): void {
  registerWorkspaceCommands(program);
  registerRunCommands(program);
  registerDeliveryCommands(program);
  registerAgentsCommands(program);
  registerPluginsCommands(program);
  registerMissionCommands(program);
  registerEvolutionCommands(program);
  registerConfigCommands(program);
  registerDoctorCommands(program);
  registerServiceCommands(program);
  registerShareCommands(program);
}
