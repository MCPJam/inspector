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
  rpc: boolean;
}

export interface SharedServerTargetOptions {
  url?: string;
  accessToken?: string;
  oauthAccessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  header?: string[];
  clientCapabilities?: string | Record<string, unknown>;
  command?: string;
  commandArgs?: string[];
  env?: string[];
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
      "--oauth-access-token <token>",
      "OAuth bearer access token for HTTP servers",
    )
    .option(
      "--refresh-token <token>",
      "OAuth refresh token for HTTP servers",
    )
    .option(
      "--client-id <id>",
      "OAuth client ID used with --refresh-token",
    )
    .option(
      "--client-secret <secret>",
      "OAuth client secret used with --refresh-token",
    )
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      collectString,
      [],
    )
    .option(
      "--client-capabilities <json>",
      "Client capabilities advertised to the server as a JSON object",
    )
    .option("--command <command>", "Command for a stdio MCP server")
    .option(
      "--command-args <arg>",
      "Stdio command argument. Repeat to pass multiple arguments.",
      collectString,
    )
    .option(
      "--env <env>",
      'Stdio environment assignment in "KEY=VALUE" format. Repeat to pass multiple assignments.',
      collectString,
    );
}

export function getGlobalOptions(command: Command): GlobalOptions {
  const options = command.optsWithGlobals() as Partial<GlobalOptions>;
  return {
    format: parseOutputFormat(options.format as string ?? "json"),
    timeout: options.timeout ?? 30_000,
    rpc: options.rpc ?? false,
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

export function parseUnknownRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`${label} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
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
  const clientCapabilities = resolveClientCapabilities(
    options.clientCapabilities,
  );

  if (hasUrl === hasCommand) {
    throw usageError("Specify exactly one target: either --url or --command.");
  }

  if (hasUrl && url) {
    if (
      (options.commandArgs?.length ?? 0) > 0 ||
      (options.env?.length ?? 0) > 0
    ) {
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
    const accessToken = resolveHttpAccessToken(options);
    const refreshToken = options.refreshToken?.trim();
    const clientId = options.clientId?.trim();
    const clientSecret = options.clientSecret?.trim();

    if (refreshToken && accessToken) {
      throw usageError(
        "--refresh-token cannot be used together with --access-token or --oauth-access-token.",
      );
    }

    if (refreshToken && !clientId) {
      throw usageError("--client-id is required when --refresh-token is used.");
    }

    if (!refreshToken && (clientId || clientSecret)) {
      throw usageError(
        "--client-id and --client-secret can only be used together with --refresh-token.",
      );
    }

    return {
      url,
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(clientCapabilities ? { clientCapabilities } : {}),
      requestInit: headers ? { headers } : undefined,
      timeout: options.timeout,
    };
  }

  if (!command) {
    throw usageError("Missing stdio command.");
  }

  if (
    options.accessToken ||
    options.oauthAccessToken ||
    options.refreshToken ||
    options.clientId ||
    options.clientSecret ||
    (options.header?.length ?? 0) > 0
  ) {
    throw usageError(
      "--access-token, --oauth-access-token, --refresh-token, --client-id, --client-secret, and --header can only be used together with --url.",
    );
  }

  return {
    command,
    args: parseCommandArgs(options.commandArgs),
    env: parseEnvironmentOption(options.env),
    ...(clientCapabilities ? { clientCapabilities } : {}),
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
    .option("--rpc", "Include RPC logs in JSON output")
    .option("--format <format>", "Output format");
}

export function describeTarget(
  options: Pick<SharedServerTargetOptions, "url" | "command">,
): string {
  return options.url?.trim() || options.command?.trim() || "__cli__";
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

function parseCommandArgs(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  return values;
}

function parseEnvironmentOption(
  values: string[] | undefined,
): Record<string, string> | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    values.map((entry) => {
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

function resolveClientCapabilities(
  value: string | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return parseJsonRecord(value, "Client capabilities");
  }

  return parseUnknownRecord(value, "Client capabilities");
}

export function resolveHttpAccessToken(
  options: Pick<SharedServerTargetOptions, "accessToken" | "oauthAccessToken">,
): string | undefined {
  const accessToken = options.accessToken?.trim();
  const oauthAccessToken = options.oauthAccessToken?.trim();

  if (
    accessToken &&
    oauthAccessToken &&
    accessToken !== oauthAccessToken
  ) {
    throw usageError(
      "--access-token and --oauth-access-token must match when both are provided.",
    );
  }

  return accessToken ?? oauthAccessToken;
}
