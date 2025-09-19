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
};

type ConversationOptions = {
  messages: ModelMessage[];
};

type ToolCallSummary = {
  toolName: string;
  args?: string;
};

type RunResultOptions = {
  passed: boolean;
  durationMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

type RunStartOptions = {
  runNumber: number;
  totalRuns: number;
  provider?: string;
  model?: string;
  temperature?: number;
};

const MAX_CONTENT_LENGTH = 160;

export class Logger {
  private static activeStream: {
    role: ModelMessage["role"];
  } | null = null;

  private static closeActiveStream(): void {
    if (this.activeStream) {
      process.stdout.write("\n");
      this.activeStream = null;
    }
  }

  private static startStream(role: ModelMessage["role"]): void {
    this.closeActiveStream();
    const prefix = this.colorRole(role) + ": ";
    process.stdout.write(prefix);
    this.activeStream = { role };
  }

  private static appendToStream(text: string): void {
    if (!this.activeStream) {
      this.startStream("assistant");
    }
    process.stdout.write(text);
  }

  private static logLine(text: string): void {
    this.closeActiveStream();
    console.log(text);
  }

  private static logMultiline(text: string): void {
    text.split("\n").forEach((line) => this.logLine(line));
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

  static initiateTestMessage(
    serverCount: number,
    toolCount: number,
    serverNames: string[],
    testCount: number,
  ): void {
    this.logLine("");
    this.logLine(chalk.bold.blue("Running tests"));

    const serverLabel = serverCount === 1 ? "server" : "servers";
    const serverList = serverNames.length > 0 ? serverNames.join(", ") : "none";
    this.logLine(
      `Connected to ${chalk.white.bold(serverCount)} ${serverLabel}: ${chalk.gray(serverList)}`,
    );

    const toolLabel = toolCount === 1 ? "tool" : "tools";
    this.logLine(`Found ${chalk.white.bold(toolCount)} total ${toolLabel}`);

    const testLabel = testCount === 1 ? "test" : "tests";
    this.logLine(`Running ${chalk.white.bold(testCount)} ${testLabel}`);

    this.logLine("");
  }

  static logTestGroupTitle(
    testNumber: number,
    testName: string,
    modelProvider: string,
    modelId: string,
  ): void {
    this.logLine(chalk.cyan.bold(`Test ${testNumber}: ${testName}`));
    this.logLine(chalk.gray(`Using ${modelProvider}:${modelId}`));
    this.logLine("");
  }

  static testRunStart(options: RunStartOptions): void {
    const { runNumber, totalRuns } = options;

    const parts = [`run ${runNumber}/${totalRuns}`];
    this.logLine(chalk.cyanBright(parts.join(" • ")));
  }

  static conversation(options: ConversationOptions): void {
    const { messages } = options;

    this.closeActiveStream();

    if (!messages.length) {
      this.logLine(chalk.dim("(no messages)"));
      return;
    }

    messages.forEach((message, index) => {
      if (index > 0) {
        this.logLine("");
      }

      const roleLabel = this.colorRole(message.role);

      if (message.role === "assistant") {
        const summary = this.summarizeContent(
          message.content as MessageContent,
        );

        this.logMessageLines(roleLabel, summary.textLines);
        summary.toolCalls.forEach((toolCall) => {
          this.logToolCall(toolCall);
        });
        return;
      }

      const formatted = this.formatMessageContent(
        message.content as MessageContent,
      );
      const lines = formatted ? formatted.split("\n") : [];
      this.logMessageLines(roleLabel, lines);
    });
  }

  static toolSummary(options: ToolSummaryOptions) {
    const { expected, actual } = options;

    this.logLine(`Expected: [${expected.join(", ") || "—"}]`);
    this.logLine(`Actual:   [${actual.join(", ") || "—"}]`);
  }

  static testRunResult(options: RunResultOptions): void {
    const { passed, durationMs, usage } = options;
    const status = passed ? chalk.green("PASS") : chalk.red("FAIL");
    this.logLine(`${status} (${this.formatDuration(durationMs)})`);
    if (usage) {
      const usageParts: string[] = [];

      if (typeof usage.inputTokens === "number") {
        usageParts.push(`input ${usage.inputTokens}`);
      }

      if (typeof usage.outputTokens === "number") {
        usageParts.push(`output ${usage.outputTokens}`);
      }

      if (typeof usage.totalTokens === "number") {
        usageParts.push(`total ${usage.totalTokens}`);
      }

      if (usageParts.length > 0) {
        this.logLine(chalk.gray(`Tokens • ${usageParts.join(" • ")}`));
      }
    }
    this.logLine("");
    this.logLine("");
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

  private static logMessageLines(roleLabel: string, lines: string[]): void {
    if (!lines.length) {
      this.logLine(`${roleLabel}:`);
      return;
    }

    this.logLine(`${roleLabel}: ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) {
      this.logLine(lines[i] ?? "");
    }
  }

  private static logToolCall(toolCall: ToolCallSummary): void {
    const header = chalk.whiteBright(`[tool-call] ${toolCall.toolName}`);
    this.logLine(header);
    const jsonArgs = toolCall.args ? JSON.parse(toolCall.args) : null;
    if (toolCall.args) {
      this.logLine(chalk.gray(this.truncate(toolCall.args)));
    }
  }

  static beginStreamingMessage(role: ModelMessage["role"]): void {
    this.startStream(role);
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

  static streamToolCall(toolName: string, args: unknown): void {
    const serializedArgs =
      args === undefined ? undefined : this.truncate(this.stringify(args));
    this.closeActiveStream();
    this.logToolCall({ toolName, args: serializedArgs });
  }

  static streamToolResult(toolName: string, output: unknown): void {
    this.closeActiveStream();
    const header = chalk.whiteBright(`[tool-result] ${toolName}`);
    this.logLine(header);
    if (output !== undefined) {
      this.logLine(chalk.gray(this.truncate(this.stringify(output))));
    }
  }

  static streamToolError(toolName: string, error: unknown): void {
    this.closeActiveStream();
    const header = chalk.whiteBright(`[tool-error] ${toolName}`);
    this.logLine(header);
    this.logLine(
      chalk.red(this.truncate(this.stringify(error ?? "Unknown error"))),
    );
  }

  private static renderBox(
    lines: string[],
    options: {
      borderColor: (text: string) => string;
      statusColor: (text: string) => string;
    },
  ): void {
    if (!lines.length) {
      return;
    }

    const { borderColor, statusColor } = options;
    const statusIndex = lines.findIndex((line) => line.startsWith("Status:"));
    const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const horizontal = borderColor(`+${"-".repeat(width + 2)}+`);
    this.logLine(horizontal);

    lines.forEach((line, index) => {
      const padded = line.padEnd(width, " ");
      const isStatusLine = index === statusIndex;
      const colouredContent = isStatusLine
        ? statusColor(padded)
        : chalk.white(padded);
      this.logLine(
        `${borderColor("| ")}${colouredContent}${borderColor(" |")}`,
      );
    });

    this.logLine(horizontal);
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
        return chalk.bold.whiteBright("user");
      case "assistant":
        return chalk.bold.whiteBright("assistant");
      case "tool":
        return chalk.bold.whiteBright("tool");
      case "system":
        return chalk.bold.whiteBright("system");
      default:
        return chalk.cyan(role);
    }
  }
}
