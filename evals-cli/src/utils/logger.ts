import chalk from "chalk";
import type { ModelMessage } from "ai";

type MessageContent = string | Record<string, unknown> | MessageContent[];

type ToolSummaryResult = {
  missing: string[];
  unexpected: string[];
  passed: boolean;
};

type ToolSummaryOptions = {
  expected: string[];
  actual: string[];
  passed: boolean;
  missing?: string[];
  unexpected?: string[];
  indentLevel?: number;
};

type ConversationOptions = {
  messages: ModelMessage[];
  indentLevel?: number;
};

type ToolCallSummary = {
  toolName: string;
  args?: string;
};

type RunResultOptions = {
  passed: boolean;
  durationMs: number;
  indentLevel?: number;
};

type RunStartOptions = {
  runNumber: number;
  totalRuns: number;
  provider?: string;
  model?: string;
  temperature?: number;
  indentLevel?: number;
};

const MAX_CONTENT_LENGTH = 160;

export class Logger {
  private static activeStream: {
    role: ModelMessage["role"];
    indentLevel: number;
  } | null = null;

  private static closeActiveStream(): void {
    if (this.activeStream) {
      process.stdout.write("\n");
      this.activeStream = null;
    }
  }

  private static startStream(
    role: ModelMessage["role"],
    indentLevel: number,
  ): void {
    this.closeActiveStream();
    const prefix = "  ".repeat(indentLevel) + this.colorRole(role) + ": ";
    process.stdout.write(prefix);
    this.activeStream = { role, indentLevel };
  }

  private static appendToStream(text: string): void {
    if (!this.activeStream) {
      this.startStream("assistant", 2);
    }
    process.stdout.write(text);
  }

  private static logLine(text: string, indentLevel = 0): void {
    this.closeActiveStream();
    const prefix = "  ".repeat(indentLevel);
    console.log(prefix + text);
  }

  private static logMultiline(text: string, indentLevel = 0): void {
    text.split("\n").forEach((line) => this.logLine(line, indentLevel));
  }

  static suiteIntro(options: { testCount: number; startedAt: Date }): void {
    const { testCount, startedAt } = options;
    this.logLine(
      chalk.bold.blue(
        `▸ Running ${testCount} test${testCount === 1 ? "" : "s"} (${startedAt.toISOString()})`,
      ),
    );
  }

  static suiteComplete(options: {
    durationMs: number;
    passed: number;
    failed: number;
  }): void {
    const { durationMs, passed, failed } = options;
    const total = passed + failed;
    const summary = `${passed}/${total} passed • ${this.formatDuration(durationMs)}`;
    const prefix = failed === 0 ? chalk.green("✔") : chalk.red("✖");
    this.logLine(`${prefix} ${summary}`);
  }

  static header(version: string): void {
    this.logLine(chalk.bold.blue(`MCPJAM CLI ${version}`));
    this.logLine("");
  }

  static serverConnection(serverCount: number, toolCount: number): void {
    this.logLine(
      chalk.gray(
        `Connecting to ${serverCount} server${serverCount === 1 ? "" : "s"} and ${toolCount} tool${toolCount === 1 ? "" : "s"}`,
      ),
    );
  }

  static startTests(count: number): void {
    this.logLine(
      chalk.gray(`Running ${count} test${count === 1 ? "" : "s"}...`),
    );
    this.logLine("");
  }

  static testTitle(testName: string): void {
    this.logLine(chalk.white.bold(`• ${testName}`));
  }

  static testRunStart(options: RunStartOptions): void {
    const {
      runNumber,
      totalRuns,
      provider,
      model,
      temperature,
      indentLevel = 1,
    } = options;
    const parts = [`run ${runNumber}/${totalRuns}`];
    if (provider && model) {
      parts.push(`${provider}:${model}`);
    }
    if (typeof temperature === "number") {
      parts.push(`temp=${temperature}`);
    }
    this.logLine(chalk.gray(parts.join(" • ")), indentLevel);
  }

  static conversation(options: ConversationOptions): void {
    const { messages, indentLevel = 2 } = options;

    this.closeActiveStream();

    if (!messages.length) {
      this.logLine(chalk.dim("(no messages)"), indentLevel);
      return;
    }

    messages.forEach((message, index) => {
      if (index > 0) {
        this.closeActiveStream();
        console.log("");
      }

      const role = this.colorRole(message.role);

      if (message.role === "assistant") {
        const summary = this.summarizeContent(
          message.content as MessageContent,
        );
        this.logMessageLines(role, summary.textLines, indentLevel);
        summary.toolCalls.forEach((toolCall) => {
          this.logToolCall(toolCall, indentLevel + 1);
        });
        return;
      }

      const content = this.formatMessageContent(
        message.content as MessageContent,
      );
      const lines = content.split("\n");
      this.logMessageLines(role, lines, indentLevel);
    });
  }

  static toolSummary(options: ToolSummaryOptions): ToolSummaryResult {
    const {
      expected,
      actual,
      passed,
      missing: providedMissing,
      unexpected: providedUnexpected,
      indentLevel = 2,
    } = options;

    const missing =
      providedMissing ?? expected.filter((tool) => !actual.includes(tool));
    const unexpected =
      providedUnexpected ?? actual.filter((tool) => !expected.includes(tool));

    const lines: string[] = [];
    lines.push(this.truncate(`Expected: [${expected.join(", ") || "—"}]`));
    lines.push(this.truncate(`Actual:   [${actual.join(", ") || "—"}]`));

    if (missing.length) {
      lines.push(this.truncate(`Missing: ${missing.join(", ")}`));
    }

    if (unexpected.length) {
      lines.push(this.truncate(`Unexpected: ${unexpected.join(", ")}`));
    }

    const statusText = passed ? "Status: PASS" : "Status: FAIL";
    lines.push(statusText);

    const borderColor = passed ? chalk.greenBright : chalk.redBright;
    const statusColor = passed ? chalk.green : chalk.red;
    this.renderBox(lines, {
      borderColor,
      statusColor,
      indentLevel,
    });

    return { missing, unexpected, passed };
  }

  static testRunResult(options: RunResultOptions): void {
    const { passed, durationMs, indentLevel = 2 } = options;
    const status = passed ? chalk.green("PASS") : chalk.red("FAIL");
    this.logLine(`${status} (${this.formatDuration(durationMs)})`, indentLevel);
  }

  static info(message: string): void {
    this.logLine(chalk.blue(`ℹ ${message}`));
  }

  static success(message: string): void {
    this.logLine(chalk.green(`✓ ${message}`));
  }

  static error(message: string): void {
    this.logLine("");
    this.logLine(chalk.red(`✕ Error: ${message}`));
  }

  static progress(current: number, total: number, testName: string): void {
    const progress = `[${current}/${total}]`;
    this.logLine(chalk.gray(`${progress} ${testName}...`));
  }

  static testStarting(testName: string): void {
    this.logLine(chalk.gray(`  Running ${testName}...`));
  }

  static testError(testName: string, error: string): void {
    this.logLine(chalk.red(`  ✕ ${testName} failed: ${error}`));
  }

  static connectionError(serverName: string, error: string): void {
    this.logLine(chalk.red(`  ✕ Failed to connect to ${serverName}: ${error}`));
  }

  static apiKeyError(provider: string, error: string): void {
    this.logLine(chalk.red(`  ✕ API key error for ${provider}: ${error}`));
  }

  static modelCreationError(
    provider: string,
    modelId: string,
    error: string,
  ): void {
    this.logLine(
      chalk.red(
        `  ✕ Failed to create ${provider} model "${modelId}": ${error}`,
      ),
    );
  }

  private static formatMessageContent(content: MessageContent): string {
    if (content === null || content === undefined) {
      return this.truncate("(empty)");
    }

    if (typeof content === "string") {
      return this.truncate(content);
    }

    if (Array.isArray(content)) {
      const pieces = content
        .map((part) => this.formatMessageContent(part as MessageContent))
        .filter(Boolean);
      return this.truncate(pieces.join("\n"));
    }

    if (typeof content === "object") {
      const typedContent = content as Record<string, unknown> & {
        type?: string;
      };

      if (typeof typedContent.type === "string") {
        const type = typedContent.type;

        if (type === "text" && typeof typedContent.text === "string") {
          return this.truncate(typedContent.text);
        }

        if (type === "tool-call") {
          const toolName = typedContent.toolName ?? typedContent.name ?? "tool";
          const args =
            typedContent.args ?? typedContent.input ?? typedContent.parameters;
          const details = args ? ` args=${this.stringify(args)}` : "";
          return this.truncate(`${toolName}${details}`);
        }

        if (type === "tool-result") {
          const result =
            typedContent.result ?? typedContent.output ?? typedContent.data;
          return this.truncate(this.stringify(result));
        }

        if (type === "reasoning" && typeof typedContent.text === "string") {
          return this.truncate(typedContent.text);
        }
      }

      if (typeof typedContent.text === "string") {
        return this.truncate(typedContent.text);
      }

      return this.truncate(this.stringify(typedContent));
    }

    return this.truncate(String(content));
  }

  private static summarizeContent(content: MessageContent): {
    textLines: string[];
    toolCalls: ToolCallSummary[];
  } {
    const textLines: string[] = [];
    const toolCalls: ToolCallSummary[] = [];

    const visit = (value: MessageContent): void => {
      if (value === null || value === undefined) {
        return;
      }

      if (typeof value === "string") {
        textLines.push(...this.splitAndTrim(this.truncate(value)));
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) => visit(item as MessageContent));
        return;
      }

      if (typeof value === "object") {
        const typedValue = value as Record<string, unknown> & {
          type?: string;
        };

        if (typedValue.type === "tool-call") {
          const toolName =
            (typedValue.toolName as string) ||
            (typedValue.name as string) ||
            "tool";
          const args =
            typedValue.args ?? typedValue.input ?? typedValue.parameters;
          toolCalls.push({
            toolName,
            args: args ? this.truncate(this.stringify(args)) : undefined,
          });
          return;
        }

        if (typedValue.type === "text" && typeof typedValue.text === "string") {
          textLines.push(...this.splitAndTrim(this.truncate(typedValue.text)));
          return;
        }

        if (
          typedValue.type === "reasoning" &&
          typeof typedValue.text === "string"
        ) {
          textLines.push(...this.splitAndTrim(this.truncate(typedValue.text)));
          return;
        }

        if (
          typedValue.type === "tool-result" ||
          typedValue.type === "tool-error"
        ) {
          const label =
            typedValue.type === "tool-error" ? "Tool error" : "Tool result";
          textLines.push(
            `${label}: ${this.truncate(this.stringify(typedValue))}`,
          );
          return;
        }

        if (typeof typedValue.text === "string") {
          textLines.push(...this.splitAndTrim(this.truncate(typedValue.text)));
          return;
        }

        textLines.push(this.truncate(this.stringify(typedValue)));
        return;
      }

      textLines.push(this.truncate(String(value)));
    };

    visit(content);

    const normalizedTextLines = textLines.length
      ? textLines
      : toolCalls.length
        ? []
        : [this.truncate("(no content)")];

    return {
      textLines: normalizedTextLines,
      toolCalls,
    };
  }

  private static splitAndTrim(text: string): string[] {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private static logMessageLines(
    roleLabel: string,
    lines: string[],
    indentLevel: number,
  ): void {
    if (!lines.length) {
      this.logLine(`${roleLabel}:`, indentLevel);
      return;
    }

    this.logLine(`${roleLabel}: ${lines[0]}`, indentLevel);
    for (let i = 1; i < lines.length; i++) {
      this.logLine(lines[i] ?? "", indentLevel + 1);
    }
  }

  private static logToolCall(
    toolCall: ToolCallSummary,
    indentLevel: number,
  ): void {
    const header = chalk.magentaBright(`[tool-call] ${toolCall.toolName}`);
    this.logLine(header, indentLevel);
    if (toolCall.args) {
      this.logLine(chalk.gray(this.truncate(toolCall.args)), indentLevel + 1);
    }
  }

  static beginStreamingMessage(
    role: ModelMessage["role"],
    indentLevel = 2,
  ): void {
    this.startStream(role, indentLevel);
  }

  static appendStreamingText(text: string): void {
    if (!text) {
      return;
    }
    this.appendToStream(text);
  }

  static finishStreamingMessage(): void {
    this.closeActiveStream();
  }

  static streamToolCall(
    toolName: string,
    args: unknown,
    indentLevel = 3,
  ): void {
    const serializedArgs =
      args === undefined ? undefined : this.truncate(this.stringify(args));
    this.closeActiveStream();
    this.logToolCall({ toolName, args: serializedArgs }, indentLevel);
  }

  static streamToolResult(
    toolName: string,
    output: unknown,
    indentLevel = 3,
  ): void {
    this.closeActiveStream();
    const header = chalk.magentaBright(`[tool-result] ${toolName}`);
    this.logLine(header, indentLevel);
    if (output !== undefined) {
      this.logLine(
        chalk.gray(this.truncate(this.stringify(output))),
        indentLevel + 1,
      );
    }
  }

  static streamToolError(
    toolName: string,
    error: unknown,
    indentLevel = 3,
  ): void {
    this.closeActiveStream();
    const header = chalk.redBright(`[tool-error] ${toolName}`);
    this.logLine(header, indentLevel);
    this.logLine(
      chalk.red(this.truncate(this.stringify(error ?? "Unknown error"))),
      indentLevel + 1,
    );
  }

  private static renderBox(
    lines: string[],
    options: {
      borderColor: (text: string) => string;
      statusColor: (text: string) => string;
      indentLevel: number;
    },
  ): void {
    if (!lines.length) {
      return;
    }

    const { borderColor, statusColor, indentLevel } = options;
    const statusIndex = lines.findIndex((line) => line.startsWith("Status:"));
    const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const horizontal = borderColor(`+${"-".repeat(width + 2)}+`);
    this.logLine(horizontal, indentLevel);

    lines.forEach((line, index) => {
      const padded = line.padEnd(width, " ");
      const isStatusLine = index === statusIndex;
      const colouredContent = isStatusLine
        ? statusColor(padded)
        : chalk.white(padded);
      this.logLine(
        `${borderColor("| ")}${colouredContent}${borderColor(" |")}`,
        indentLevel,
      );
    });

    this.logLine(horizontal, indentLevel);
  }

  private static stringify(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  private static truncate(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= MAX_CONTENT_LENGTH) {
      return trimmed;
    }
    return `${trimmed.slice(0, MAX_CONTENT_LENGTH - 3).trimEnd()}...`;
  }

  private static formatDuration(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return "?";
    }

    if (durationMs < 1000) {
      return `${durationMs.toFixed(0)}ms`;
    }

    const seconds = durationMs / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = (seconds % 60).toFixed(0).padStart(2, "0");
    return `${minutes}m${remainingSeconds}s`;
  }

  private static colorRole(role: ModelMessage["role"]): string {
    switch (role) {
      case "user":
        return chalk.cyan("user");
      case "assistant":
        return chalk.cyan("assistant");
      case "tool":
        return chalk.cyan("tool");
      case "system":
        return chalk.cyan("system");
      default:
        return chalk.cyan(role);
    }
  }
}
