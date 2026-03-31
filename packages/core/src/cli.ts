import { Command } from "commander";
import { registerCommands } from "./commands/index.js";

const program = new Command();
program
  .name("orchestrum")
  .description("Orchestrum mission runtime")
  .version("0.4.0");

registerCommands(program);

await program.parseAsync(process.argv);
