import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { TestsFileSchema } from "../../schemas/test-schema.js";
import { EnvironmentFileSchema } from "../../schemas/environment-schema.js";
import { runTests } from "../runner/test-runner.js";
import { resolveEnvironmentVariables } from "../utils/env-resolver.js";
import { Logger } from "../utils/logger.js";

export const evalsCommand = new Command("evals");

evalsCommand
  .description("Run MCP evaluations")
  .command("run")
  .description("Run tests against MCP servers")
  .requiredOption("-t, --tests <file>", "Path to tests JSON file")
  .requiredOption("-e, --environment <file>", "Path to environment JSON file")
  .action(async (options) => {
    try {
      Logger.header("v1.0.0");

      // Read and parse test file
      const testsContent = await readFile(resolve(options.tests), "utf8");
      const testsData = TestsFileSchema.parse(JSON.parse(testsContent));

      // Read and parse environment file
      const envContent = await readFile(resolve(options.environment), "utf8");
      const envData = EnvironmentFileSchema.parse(JSON.parse(envContent));

      // Resolve environment variables
      const resolvedEnv = resolveEnvironmentVariables(envData);

      Logger.startTests(testsData.tests.length);

      // Run tests
      const results = await runTests(testsData.tests, resolvedEnv);

      // Display clean results summary
      Logger.summary(results);

      // Exit with error code if any tests failed
      if (results.failed > 0) {
        process.exit(1);
      }
    } catch (error) {
      Logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
