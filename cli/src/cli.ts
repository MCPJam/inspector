import { program } from "commander";
import { registerToolsCommand } from "./commands/tools.js";

program
  .name("mcpjam")
  .description("CLI for interacting with MCP servers")
  .version("0.1.0");

// Global options available to all commands
program.option("--json", "Output as JSON").option("-q, --quiet", "Minimal output");

// Register commands
registerToolsCommand(program);

export { program };
