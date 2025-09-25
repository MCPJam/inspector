import { config } from "dotenv";
import { Command } from "commander";
import { createRequire } from "module";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
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

// Load environment file: prefer .env.development if it exists, else .env.production
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRootDir = path.resolve(__dirname, "..");
const devEnvPath = path.join(packageRootDir, ".env.development");
const prodEnvPath = path.join(packageRootDir, ".env.production");
const envFile = existsSync(devEnvPath) ? devEnvPath : prodEnvPath;
config({ path: envFile, quiet: true });

const program = new Command();

program
  .name("mcpjam")
  .description("MCPJam CLI for programmatic MCP testing")
  .version(version);

program.addCommand(evalsCommand);

program.parse();
