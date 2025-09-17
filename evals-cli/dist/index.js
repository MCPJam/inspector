// src/index.ts
import { config } from "dotenv";
import { Command as Command2 } from "commander";

// src/commands/evals.ts
import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";

// src/utils/logger.ts
import chalk from "chalk";
var Logger = class {
  static progressCounter = 0;
  static totalTests = 0;
  static header(version) {
    console.log(chalk.bold.blue(`MCPJAM CLI ${version}`));
    console.log();
  }
  static startTests(count) {
    this.progressCounter = 0;
    this.totalTests = count;
    console.log(chalk.gray(`Running ${count} tests...`));
    console.log();
  }
  static toolCall(toolName) {
    console.log(chalk.gray(`Tool called: ${toolName}`));
  }
  static error(message) {
    console.log();
    console.log(chalk.red(`\u2715 Error: ${message}`));
  }
  static progress(current, total, testName) {
    const progress = `[${current}/${total}]`;
    console.log(chalk.gray(`${progress} ${testName}...`));
  }
  static testStarting(testName) {
    console.log(chalk.gray(`  Running ${testName}...`));
  }
  static serverConnection(serverCount, toolCount) {
    console.log(
      chalk.gray(
        `  Connected to ${serverCount} servers (${toolCount} tools available)`
      )
    );
  }
  static testError(testName, error) {
    console.log(chalk.red(`  \u2715 ${testName} failed: ${error}`));
  }
  static connectionError(serverName, error) {
    console.log(chalk.red(`  \u2715 Failed to connect to ${serverName}: ${error}`));
  }
  static apiKeyError(provider, error) {
    console.log(chalk.red(`  \u2715 API key error for ${provider}: ${error}`));
  }
  static modelCreationError(provider, modelId, error) {
    console.log(
      chalk.red(
        `  \u2715 Failed to create ${provider} model "${modelId}": ${error}`
      )
    );
  }
};

// src/commands/evals.ts
var evalsCommand = new Command("evals");
evalsCommand.description("Run MCP evaluations").command("run").description("Run tests against MCP servers").requiredOption("-t, --tests <file>", "Path to tests JSON file").requiredOption("-e, --environment <file>", "Path to environment JSON file").requiredOption("-a, --api-key <key>", "Personal access key").action(async (options) => {
  try {
    Logger.header("v1.0.0");
    console.log(`Running tests from ${options.tests}`);
    const testsContent = await readFile(resolve(options.tests), "utf8");
    const testsData = JSON.parse(testsContent);
    const envContent = await readFile(resolve(options.environment), "utf8");
    const envData = JSON.parse(envContent);
    const apiKey = options.apiKey;
    console.log(envData);
    const url = `${process.env.CONVEX_URL}/evals` || "https://outstanding-fennec-304.convex.site/evals";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tests: testsData.tests,
        environment: envData,
        apiKey
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Backend error: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`
      );
    }
    const json = await response.json();
    console.log(json);
  } catch (error) {
    Logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});

// src/index.ts
config();
var program = new Command2();
program.name("mcpjam").description("MCPJam CLI for programmatic MCP testing").version("1.0.0");
program.addCommand(evalsCommand);
program.parse();
//# sourceMappingURL=index.js.map