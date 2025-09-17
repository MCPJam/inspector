import { config } from "dotenv";
import { Command } from "commander";
import { evalsCommand } from "./commands/evals.js";

// Load environment variables from .env file
config();

const program = new Command();

program
  .name("mcpjam")
  .description("MCPJam CLI for programmatic MCP testing")
  .version("1.0.0");

program.addCommand(evalsCommand);

program.parse();
