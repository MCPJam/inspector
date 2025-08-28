import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { TestsFileSchema } from "../../schemas/test-schema.js";
import { EnvironmentFileSchema } from "../../schemas/environment-schema.js";
import { runTests } from "../runner/test-runner.js";
import { resolveEnvironmentVariables } from "../utils/env-resolver.js";

export const evalsCommand = new Command("evals");

evalsCommand
  .description("Run MCP evaluations")
  .command("run")
  .description("Run tests against MCP servers")
  .requiredOption("-t, --tests <file>", "Path to tests JSON file")
  .requiredOption("-e, --environment <file>", "Path to environment JSON file")
  .action(async (options) => {
    try {
      console.log("MCPJAM Evals v1.0.0\n");

      // Read and parse test file
      const testsContent = await readFile(resolve(options.tests), "utf8");
      const testsData = TestsFileSchema.parse(JSON.parse(testsContent));

      // Read and parse environment file
      const envContent = await readFile(resolve(options.environment), "utf8");
      const envData = EnvironmentFileSchema.parse(JSON.parse(envContent));

      // Resolve environment variables
      const resolvedEnv = resolveEnvironmentVariables(envData);

      console.log(`Running ${testsData.tests.length} tests...\n`);

      // Run tests
      const results = await runTests(testsData.tests, resolvedEnv);

      // Display results
      console.log(
        `\nResults: ${results.passed} passed, ${results.failed} failed (${results.duration}s total)\n`,
      );

      // Exit with error code if any tests failed
      if (results.failed > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(
        "❌ Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });
