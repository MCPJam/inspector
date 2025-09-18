import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { Logger } from "../utils/logger.js";
import { runEvals } from "./runner.js";

// node dist/index.js evals run -t examples/test-servers.json -e examples/mcp-environment.json

export const evalsCommand = new Command("evals");

evalsCommand
  .description("Run MCP evaluations")
  .command("run")
  .description("Run tests against MCP servers")
  .requiredOption("-t, --tests <file>", "Path to tests JSON file")
  .requiredOption("-e, --environment <file>", "Path to environment JSON file")
  .requiredOption("-l, --llms <file>", "Path to LLMs JSON file")
  .option("-a, --api-key <key>", "Personal access key")
  .action(async (options) => {
    try {
      // Read and parse test file
      const testsContent = await readFile(resolve(options.tests), "utf8");
      const testsData = JSON.parse(testsContent);

      // Read and parse environment file
      const envContent = await readFile(resolve(options.environment), "utf8");
      const envData = JSON.parse(envContent);

      // Read and parse LLMs file
      const llmsContent = await readFile(resolve(options.llms), "utf8");
      const llmsData = JSON.parse(llmsContent);

      // Read API token (optional)
      const apiKey = options.apiKey;
      runEvals(testsData, envData, llmsData, apiKey);
    } catch (error) {
      Logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
