import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { Logger } from "../utils/logger.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../_generated/api.js";
import { getUserIdOrNull } from "../db/user.js";
import { runEvals } from "./runner.js";

// node dist/index.js evals run -t examples/test-servers.json -e examples/mcp-environment.json

export const evalsCommand = new Command("evals");

evalsCommand
  .description("Run MCP evaluations")
  .command("run")
  .description("Run tests against MCP servers")
  .requiredOption("-t, --tests <file>", "Path to tests JSON file")
  .requiredOption("-e, --environment <file>", "Path to environment JSON file")
  .requiredOption("-a, --api-key <key>", "Personal access key")
  .action(async (options) => {
    try {
      Logger.header("v1.0.0");
      console.log(`Running tests from ${options.tests}`);

      // Read and parse test file
      const testsContent = await readFile(resolve(options.tests), "utf8");
      const testsData = JSON.parse(testsContent);

      // Read and parse environment file
      const envContent = await readFile(resolve(options.environment), "utf8");
      const envData = JSON.parse(envContent);

      // Read API token
      const apiKey = options.apiKey;
      runEvals(testsData, envData, apiKey);
    } catch (error) {
      Logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
