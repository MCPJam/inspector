import { program } from "commander";
import { registerToolsCommand } from "./commands/tools.js";
import { registerResourcesCommand } from "./commands/resources.js";
import { registerPromptsCommand } from "./commands/prompts.js";
import { registerServerCommand } from "./commands/server.js";

program
  .name("mcpjam")
  .description("CLI for interacting with MCP servers")
  .version("0.1.0");

// Global options available to all commands
program.option("--json", "Output as JSON").option("-q, --quiet", "Minimal output");

// Register commands
registerToolsCommand(program);
registerResourcesCommand(program);
registerPromptsCommand(program);
registerServerCommand(program);

export { program };
