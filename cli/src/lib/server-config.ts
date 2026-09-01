import { type MCPServerConfig, type RetryPolicy } from "@mcpjam/sdk";
import { Command } from "commander";
import {
  resolveOutputFormat,
  type OutputFormat,
  usageError,
} from "./output.js";
import {
  assertNoCredentialsFileAuthConflicts,
  resolveCredentialsFileAuth,
} from "./credentials-file.js";
import { parseJsonInputRecord } from "./json-input.js";

export interface GlobalOptions {
  format: OutputFormat;
  timeout: number;
  rpc: boolean;
  quiet: boolean;
  telemetry: boolean;
}

type TransportType = "http" | "stdio";

export interface SharedServerTargetOptions {
  transport?: TransportType;
  url?: string;
  accessToken?: string;
  oauthAccessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  credentialsFile?: string;
  header?: string[];
  clientCapabilities?: string | Record<string, unknown>;
  command?: string;
  args?: string[];
  commandArgs?: string[];
  env?: string[];
  cwd?: string;
  timeout?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Connect as this host (added by `addHostOption`, resolved separately). */
  host?: string;
}

const DEFAULT_CLI_RETRY_POLICY: RetryPolicy = {
  retries: 0,
  retryDelayMs: 3_000,
};

function collectString(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function addSharedServerOptions(command: Command): Command {
  return command
    .option(
      "--transport <transport>",
      'Explicit transport type: "http" or "stdio"',
    )
    .option("--url <url>", "HTTP MCP server URL")
    .option("--access-token <token>", "Bearer access token for HTTP servers")
    .option(
      "--oauth-access-token <token>",
      "OAuth bearer access token for HTTP servers",
    )
    .option("--refresh-token <token>", "OAuth refresh token for HTTP servers")
    .option("--client-id <id>", "OAuth client ID used with --refresh-token")
    .option(
      "--client-secret <secret>",
      "OAuth client secret used with --refresh-token",
    )
    .option(
      "--credentials-file <path>",
      "Load OAuth credentials from a file created by oauth login or oauth conformance --credentials-out",
    )
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      collectString,
      [],
    )
    .option(
      "--client-capabilities <json>",
      "Client capabilities as JSON, @path, or - for stdin",
    )
    .option("--command <command>", "Command for a stdio MCP server")
    .option(
      "--args <arg...>",
      "Preferred stdio command arguments. Pass multiple values or repeat the flag.",
    )
    .option(
      "--command-args <arg>",
      "Legacy stdio command argument. Repeat to pass multiple arguments.",
      collectString,
    )
    .option(
      "-e, --env <env...>",
      'Stdio environment assignment in "KEY=VALUE" format. Pass multiple values or repeat the flag.',
    )
    .option("--cwd <path>", "Working directory for the stdio MCP server process");
}

/**
 * Add `--host <id>` — connect "as" a host: send its identity, advertised client
 * capabilities, and protocol version in `initialize`, and apply its tool
 * visibility. Kept separate from {@link addSharedServerOptions} so it can be
 * applied only to the commands where running as a host makes sense, and to
 * avoid colliding with `compat`'s own (report-filter) `--host`.
 */
export function addHostOption(command: Command): Command {
  return command.option(
    "--host <id>",
    "Connect as this host (e.g. claude, chatgpt, cursor) — sends its identity/capabilities/protocol and applies its tool visibility",
  );
}

/**
 * Add the client-conformance knobs — call a server as a client that differs
 * from a fully-conforming one, without having to author a host first. The
 * same behaviors `--host` carries via `mcpProfile.paginationTraversal` /
 * `mcpProfile.mrtrSupport`; these flags are the ad-hoc way to reproduce them.
 *
 * Unlike `--no-param-headers`, NEITHER is HTTP-only: pagination truncation is
 * enforced on JSON-RPC frames and the MRTR knob works through capability
 * advertisement, so both mean the same thing over stdio.
 */
export function addConformanceOptions(command: Command): Command {
  return command
    .option(
      "--first-page-only",
      "Read only the first page of paginated lists, like the real hosts that never follow nextCursor. On 2026-07-28 this also stops SEP-2243 Mcp-Param-* mirroring for tools past page one, because the mirroring source is the page-one-only list the client cached.",
    )
    .option(
      "--no-mrtr",
      "Do NOT drive MRTR (resultType: input_required) rounds — call as a client that never implemented the 2026 pattern. Stops advertising elicitation on a modern connection, so a server that would have elicited answers -32021 instead.",
    );
}

/**
 * Reduce the conformance flags to the wire fields `MCPServerConfig` takes.
 * Only the NON-default value is emitted, matching how the host-config
 * reduction behaves — an absent flag must not pin the conforming default onto
 * a config that never carried it.
 */
export function conformanceConfigFromOptions(options: {
  firstPageOnly?: boolean;
  mrtr?: boolean;
}): { firstPageOnly?: true; supportsMrtr?: false } {
  return {
    ...(options.firstPageOnly === true ? { firstPageOnly: true as const } : {}),
    // Commander defaults a `--no-x` flag to `true`, so only an explicit
    // `false` means the user asked to disable MRTR.
    ...(options.mrtr === false ? { supportsMrtr: false as const } : {}),
  };
}

/**
 * Did the CALLER choose `--timeout`, as opposed to commander defaulting it?
 *
 * `getOptionValueSourceWithGlobals` walks parent commands, which matters
 * because `--timeout` is declared once on the program and read from a leaf.
 */
function timeoutWasSupplied(command: Command): boolean {
  const source = command.getOptionValueSourceWithGlobals?.("timeout");
  return source !== undefined && source !== "default";
}

export function getGlobalOptions(
  command: Command,
  defaultTimeoutMs = 30_000,
): GlobalOptions {
  const options = command.optsWithGlobals() as Partial<GlobalOptions>;
  return {
    format: resolveOutputFormat(
      options.format as string | undefined,
      process.stdout.isTTY,
    ),
    // `defaultTimeoutMs` applies ONLY when the caller did not supply
    // `--timeout`, so an explicit flag always wins. Commands that drive a model
    // turn override it: 30s is right for an MCP probe and far too short for an
    // agent that installs packages, and the turn keeps running server-side
    // after the client gives up.
    //
    // Keyed off the option's SOURCE, not its value. The program registers
    // `--timeout` with a commander default of 30_000, so the value is never
    // `undefined` and an `options.timeout ?? …` fallback is dead code that
    // silently pins every command to 30s. `"default"` means commander filled
    // it in; anything else (`"cli"`, `"env"`, `"config"`) means the caller
    // chose it and must win.
    timeout: timeoutWasSupplied(command)
      ? (options.timeout ?? defaultTimeoutMs)
      : defaultTimeoutMs,
    rpc: options.rpc ?? false,
    quiet: options.quiet ?? false,
    telemetry: options.telemetry ?? true,
  };
}

export function parsePositiveInteger(value: string, label = "Value"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${label} must be a positive integer.`);
  }

  return parsed;
}

export function parseNonNegativeInteger(
  value: string,
  label = "Value",
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw usageError(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

export function addRetryOptions(command: Command): Command {
  return command
    .option(
      "--retries <count>",
      "Retry transient failures this many times",
      (value: string) => parseNonNegativeInteger(value, "Retries"),
    )
    .option(
      "--retry-delay-ms <ms>",
      "Fixed delay between retries in milliseconds",
      (value: string) => parseNonNegativeInteger(value, "Retry delay"),
    );
}

export function parseRetryPolicy(
  options: Pick<SharedServerTargetOptions, "retries" | "retryDelayMs"> = {},
): RetryPolicy | undefined {
  if (options.retries === undefined && options.retryDelayMs === undefined) {
    return undefined;
  }

  const retries = options.retries ?? DEFAULT_CLI_RETRY_POLICY.retries;
  if (options.retryDelayMs !== undefined && retries === 0) {
    throw usageError("--retry-delay-ms requires --retries to be greater than 0.");
  }

  return {
    retries,
    retryDelayMs:
      options.retryDelayMs ?? DEFAULT_CLI_RETRY_POLICY.retryDelayMs,
  };
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
  return parseJsonInputRecord(value, label);
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

export function resolveAliasedStringOption(
  options: Record<string, unknown>,
  aliases: ReadonlyArray<{ key: string; flag: string }>,
  label: string,
  config?: { required?: boolean },
): string | undefined {
  const provided = aliases
    .map((alias) => {
      const value = options[alias.key];
      if (typeof value !== "string") {
        return undefined;
      }

      const normalized = value.trim();
      if (!normalized) {
        return undefined;
      }

      return {
        flag: alias.flag,
        value: normalized,
      };
    })
    .filter(
      (entry): entry is { flag: string; value: string } => entry !== undefined,
    );

  const flagsText = aliases.map((alias) => alias.flag).join(" or ");

  if (provided.length === 0) {
    if (config?.required) {
      throw usageError(`${label} is required. Use ${flagsText}.`);
    }

    return undefined;
  }

  const values = new Set(provided.map((entry) => entry.value));
  if (values.size > 1) {
    throw usageError(`Specify only one of ${flagsText}.`);
  }

  return provided[0]?.value;
}

export function parseServerConfig(
  options: SharedServerTargetOptions,
): MCPServerConfig {
  const url = options.url?.trim();
  const command = options.command?.trim();
  const hasUrl = Boolean(url);
  const hasCommand = Boolean(command);
  const transport = resolveTargetTransport(options, hasUrl, hasCommand);
  const cwd = options.cwd?.trim();
  const clientCapabilities = resolveClientCapabilities(
    options.clientCapabilities,
  );

  if (transport === "http" && url) {
    if (
      (options.args?.length ?? 0) > 0 ||
      (options.commandArgs?.length ?? 0) > 0 ||
      (options.env?.length ?? 0) > 0 ||
      cwd
    ) {
      throw usageError(
        "--args, --command-args, --env, and --cwd can only be used together with --command.",
      );
    }

    try {
      new URL(url);
    } catch {
      throw usageError(`Invalid URL: ${url}`);
    }

    const headers = parseHeadersOption(options.header);
    assertNoCredentialsFileAuthConflicts(options);
    const fileCredentials = options.credentialsFile
      ? resolveCredentialsFileAuth(options.credentialsFile, url)
      : undefined;
    const accessToken =
      resolveHttpAccessToken(options) ?? fileCredentials?.accessToken;
    const refreshToken =
      normalizeOptionalAuthValue(options.refreshToken) ??
      fileCredentials?.refreshToken;
    const clientId =
      normalizeOptionalAuthValue(options.clientId) ?? fileCredentials?.clientId;
    const clientSecret =
      normalizeOptionalAuthValue(options.clientSecret) ??
      fileCredentials?.clientSecret;

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
    options.credentialsFile ||
    (options.header?.length ?? 0) > 0
  ) {
    throw usageError(
      "--access-token, --oauth-access-token, --refresh-token, --client-id, --client-secret, --credentials-file, and --header can only be used together with --url.",
    );
  }

  return {
    command,
    args: parseCommandArgs(options.args, options.commandArgs),
    env: parseEnvironmentOption(options.env),
    ...(cwd ? { cwd } : {}),
    ...(clientCapabilities ? { clientCapabilities } : {}),
    stderr: "pipe",
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
    .option("--quiet", "Suppress non-result progress output")
    .option("--no-telemetry", "Disable anonymous usage telemetry")
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

function parseCommandArgs(
  values: string[] | undefined,
  legacyValues: string[] | undefined,
): string[] | undefined {
  const combined = [...(values ?? []), ...(legacyValues ?? [])];

  if (combined.length === 0) {
    return undefined;
  }

  return combined;
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

function resolveTargetTransport(
  options: SharedServerTargetOptions,
  hasUrl: boolean,
  hasCommand: boolean,
): TransportType {
  const transport = resolveTransportOption(options.transport);

  if (!transport) {
    if (hasUrl === hasCommand) {
      throw usageError("Specify exactly one target: either --url or --command.");
    }

    return hasUrl ? "http" : "stdio";
  }

  if (transport === "http") {
    if (!hasUrl) {
      throw usageError("--transport http requires --url.");
    }
    if (hasCommand) {
      throw usageError("--command can only be used with --transport stdio.");
    }

    return transport;
  }

  if (!hasCommand) {
    throw usageError("--transport stdio requires --command.");
  }
  if (hasUrl) {
    throw usageError("--url can only be used with --transport http.");
  }

  return transport;
}

function resolveTransportOption(
  value: string | undefined,
): TransportType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "http" || value === "stdio") {
    return value;
  }

  throw usageError(
    `Invalid transport "${value}". Use "http" or "stdio".`,
  );
}

export function resolveHttpAccessToken(
  options: Pick<SharedServerTargetOptions, "accessToken" | "oauthAccessToken">,
): string | undefined {
  const accessToken = normalizeOptionalAuthValue(options.accessToken);
  const oauthAccessToken = normalizeOptionalAuthValue(options.oauthAccessToken);

  if (accessToken && oauthAccessToken && accessToken !== oauthAccessToken) {
    throw usageError(
      "--access-token and --oauth-access-token must match when both are provided.",
    );
  }

  return accessToken ?? oauthAccessToken;
}

function normalizeOptionalAuthValue(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
