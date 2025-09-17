import chalk from "chalk";
import Table from "cli-table3";

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
