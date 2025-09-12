import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { Logger } from "../utils/logger.js";

// node dist/index.js evals run -t examples/test-servers.json -e examples/mcp-environment.json

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
      console.log(`Running tests from ${options.tests}`);
      // Read and parse test file
      const testsContent = await readFile(resolve(options.tests), "utf8");
      const testsData = JSON.parse(testsContent);

      // Read and parse environment file
      const envContent = await readFile(resolve(options.environment), "utf8");
      const envData = JSON.parse(envContent);

      // Determine Convex base URL
      const url: string =
        `${process.env.CONVEX_URL}/evals` ||
        "https://outstanding-fennec-304.convex.site/evals";

      console.log(`Posting evals to ${url}`);
      console.log(`Tests: ${testsData.tests}`);
      console.log(`Environment: ${envData}`);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tests: testsData.tests,
          environment: envData,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Backend error: ${response.status} ${response.statusText}${
            text ? ` - ${text}` : ""
          }`,
        );
      }

      const json = (await response.json()) as any;
      console.log(json);
    } catch (error) {
      Logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
