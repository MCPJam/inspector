import type { MCPServerConfig } from "@mcpjam/sdk";
import { Command } from "commander";
import {
  parseOutputFormat,
  type OutputFormat,
  usageError,
} from "./output";

export interface GlobalOptions {
  format: OutputFormat;
  timeout: number;
}

export interface SharedServerTargetOptions {
  url?: string;
  accessToken?: string;
  header?: string[];
  command?: string;
  commandArgs?: string;
  env?: string;
  timeout?: number;
}

function collectString(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function addSharedServerOptions(command: Command): Command {
  return command
    .option("--url <url>", "HTTP MCP server URL")
    .option("--access-token <token>", "Bearer access token for HTTP servers")
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      collectString,
      [],
    )
    .option("--command <command>", "Command for a stdio MCP server")
    .option(
      "--command-args <args>",
      "Comma-separated stdio command arguments",
    )
    .option("--env <env>", "Comma-separated KEY=VALUE pairs for stdio env");
}

export function getGlobalOptions(command: Command): GlobalOptions {
  const options = command.optsWithGlobals() as Partial<GlobalOptions>;
  return {
    format: options.format ?? "json",
    timeout: options.timeout ?? 30_000,
  };
}

export function parsePositiveInteger(value: string, label = "Value"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${label} must be a positive integer.`);
  }

  return parsed;
}

export function parseHeadersOption(
  headers: string[] | undefined,
): Record<string, string> | undefined {
  if (!headers || headers.length === 0) {
    return undefined;
  }

  return Object.fromEntries(headers.map(parseHeader));
}

export function parseJsonRecord(
  value: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw usageError(`${label} must be valid JSON.`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`${label} must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

export function parsePromptArguments(
  value: string | undefined,
): Record<string, string> | undefined {
  const raw = parseJsonRecord(value, "Prompt arguments");
  if (!raw) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(raw).map(([key, entryValue]) => [key, String(entryValue)]),
  );
}

export function parseServerConfig(
  options: SharedServerTargetOptions,
): MCPServerConfig {
  const url = options.url?.trim();
  const command = options.command?.trim();
  const hasUrl = Boolean(url);
  const hasCommand = Boolean(command);

  if (hasUrl === hasCommand) {
    throw usageError("Specify exactly one target: either --url or --command.");
  }

  if (hasUrl && url) {
    if (options.commandArgs || options.env) {
      throw usageError(
        "--command-args and --env can only be used together with --command.",
      );
    }

    try {
      new URL(url);
    } catch {
      throw usageError(`Invalid URL: ${url}`);
    }

    const headers = parseHeadersOption(options.header);
    return {
      url,
      accessToken: options.accessToken,
      requestInit: headers ? { headers } : undefined,
      timeout: options.timeout,
    };
  }

  if (!command) {
    throw usageError("Missing stdio command.");
  }

  if (options.accessToken || (options.header?.length ?? 0) > 0) {
    throw usageError(
      "--access-token and --header can only be used together with --url.",
    );
  }

  return {
    command,
    args: parseCommaSeparatedList(options.commandArgs),
    env: parseEnvironmentOption(options.env),
    stderr: "ignore",
    timeout: options.timeout,
  };
}

export function addGlobalOptions(program: Command): Command {
  return program
    .option(
      "--timeout <ms>",
      "Request timeout in milliseconds",
      (value: string) => parsePositiveInteger(value, "Timeout"),
      30_000,
    )
    .option(
      "--format <format>",
      "Output format: json or human",
      parseOutputFormat,
      "json",
    );
}

function parseHeader(entry: string): [string, string] {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex <= 0) {
    throw usageError(
      `Invalid header "${entry}". Expected the format "Key: Value".`,
    );
  }

  const key = entry.slice(0, separatorIndex).trim();
  const value = entry.slice(separatorIndex + 1).trim();

  if (!key) {
    throw usageError(`Invalid header "${entry}". Header name is required.`);
  }

  return [key, value];
}

function parseCommaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : undefined;
}

function parseEnvironmentOption(
  value: string | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    entries.map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        throw usageError(
          `Invalid env assignment "${entry}". Expected KEY=VALUE.`,
        );
      }

      const key = entry.slice(0, separatorIndex).trim();
      const envValue = entry.slice(separatorIndex + 1);

      if (!key) {
        throw usageError(
          `Invalid env assignment "${entry}". Environment key is required.`,
        );
      }

      return [key, envValue];
    }),
  );
}
