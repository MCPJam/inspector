import chalk from "chalk";
import Table from "cli-table3";
import type { TestResult, TestRunResults } from "../runner/test-runner.js";

export class Logger {
  private static progressCounter = 0;
  private static totalTests = 0;

  static header(version: string): void {
    console.log(chalk.bold.blue(`MCPJAM CLI ${version}`));
    console.log();
  }

  static startTests(count: number): void {
    this.progressCounter = 0;
    this.totalTests = count;
    console.log(chalk.gray(`Running ${count} tests...`));
    console.log();
  }

  static toolCall(toolName: string): void {
    console.log(chalk.gray(`Tool called: ${toolName}`));
  }

  static testResult(result: TestResult): void {
    this.progressCounter++;
    const status = result.passed ? chalk.green("PASS") : chalk.red("FAIL");
    const symbol = "●";

    // Format test name with consistent width
    const testName = result.title.padEnd(40);

    if (result.passed) {
      const tools =
        result.calledTools.length > 0
          ? chalk.gray(`(tools: ${result.calledTools.join(", ")})`)
          : chalk.gray("(no tools)");
      console.log(`  ${symbol}  ${testName} ${status}    ${tools}`);
    } else {
      console.log(`  ${symbol}  ${testName} ${status}`);

      if (result.error) {
        console.log(chalk.red(`     Error: ${result.error}`));
      } else {
        if (result.calledTools.length > 0) {
          console.log(
            chalk.gray(`     Called: ${result.calledTools.join(", ")}`),
          );
        }
        if (result.missingTools.length > 0) {
          console.log(
            chalk.red(`     Missing: ${result.missingTools.join(", ")}`),
          );
        }
        if (result.unexpectedTools.length > 0) {
          console.log(
            chalk.yellow(
              `     Unexpected: ${result.unexpectedTools.join(", ")}`,
            ),
          );
        }
      }
    }
  }

  static summary(results: TestRunResults): void {
    console.log();

    // Create a clean summary box
    const table = new Table({
      chars: {
        top: "─",
        "top-mid": "┬",
        "top-left": "┌",
        "top-right": "┐",
        bottom: "─",
        "bottom-mid": "┴",
        "bottom-left": "└",
        "bottom-right": "┘",
        left: "│",
        "left-mid": "├",
        mid: "─",
        "mid-mid": "┼",
        right: "│",
        "right-mid": "┤",
        middle: "│",
      },
      style: {
        "padding-left": 1,
        "padding-right": 1,
        border: ["gray"],
      },
      colWidths: [65],
    });

    const passedText =
      results.passed > 0 ? chalk.green(`${results.passed} passed`) : "0 passed";
    const failedText =
      results.failed > 0 ? chalk.red(`${results.failed} failed`) : "0 failed";
    const summaryText = `Results: ${passedText}, ${failedText} (${results.duration}s total)`;

    table.push([summaryText]);

    console.log(table.toString());
  }

  static error(message: string): void {
    console.log();
    console.log(chalk.red(`✕ Error: ${message}`));
  }

  static progress(current: number, total: number, testName: string): void {
    const progress = `[${current}/${total}]`;
    console.log(chalk.gray(`${progress} ${testName}...`));
  }

  static testStarting(testName: string): void {
    console.log(chalk.gray(`  Running ${testName}...`));
  }

  static serverConnection(serverCount: number, toolCount: number): void {
    console.log(
      chalk.gray(
        `  Connected to ${serverCount} servers (${toolCount} tools available)`,
      ),
    );
  }

  static testError(testName: string, error: string): void {
    console.log(chalk.red(`  ✕ ${testName} failed: ${error}`));
  }

  static connectionError(serverName: string, error: string): void {
    console.log(chalk.red(`  ✕ Failed to connect to ${serverName}: ${error}`));
  }

  static apiKeyError(provider: string, error: string): void {
    console.log(chalk.red(`  ✕ API key error for ${provider}: ${error}`));
  }

  static modelCreationError(
    provider: string,
    modelId: string,
    error: string,
  ): void {
    console.log(
      chalk.red(
        `  ✕ Failed to create ${provider} model "${modelId}": ${error}`,
      ),
    );
  }
}
