import { config } from "dotenv";
import { Command } from "commander";
import { createRequire } from "module";
import { evalsCommand } from "./evals/index";
import updateNotifier from "update-notifier";
import packageJson from "../package.json" assert { type: "json" };
const require = createRequire(import.meta.url);

updateNotifier({ pkg: packageJson, updateCheckInterval: 0 }).notify();

const { name, version } = require("../package.json") as {
  name: string;
  version: string;
};

updateNotifier({ pkg: { name, version } }).notify();

config();

const program = new Command();

program
  .name("mcpjam")
  .description("MCPJam CLI for programmatic MCP testing")
  .version(version);

program.addCommand(evalsCommand);

program.parse();
