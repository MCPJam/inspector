import {
  type OAuthConformanceConfig,
  type OAuthConformanceSuiteResult,
  type OAuthLoginConfig,
  type OAuthVerificationConfig,
  OAuthConformanceTest,
  OAuthConformanceSuite,
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
  runOAuthLogin,
} from "@mcpjam/sdk";
import { Command } from "commander";
import {
  getGlobalOptions,
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config.js";
import {
  VALID_PROTOCOL_VERSIONS,
  VALID_REGISTRATION_STRATEGIES,
  VALID_AUTH_MODES,
} from "../lib/oauth-enums.js";
import {
  cliError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output.js";
import { loadOAuthSuiteConfig } from "../lib/config-file.js";
import {
  renderOAuthConformanceResult,
  renderOAuthConformanceSuiteResult,
  resolveOAuthOutputFormat,
  type OAuthOutputFormat,
} from "../lib/oauth-output.js";
import {
  renderConformanceReporterResult,
  resolveConformanceOutputFormatForCli,
} from "../lib/conformance-output.js";
import { readInputSource } from "../lib/json-input.js";
import { parseReporterFormat, type ReporterFormat } from "../lib/reporting.js";
import {
  buildCommandArtifactError,
  type DebugArtifactOutcome,
  writeCommandDebugArtifact,
} from "../lib/debug-artifact.js";
import {
  hasCredentialsToSave,
  redactCredentialsFromResult,
  writeCredentialsFile,
} from "../lib/credentials-file.js";
import {
  createCliRpcLogCollector,
} from "../lib/rpc-logs.js";
import { summarizeServerDoctorTarget } from "../lib/server-doctor.js";
import type { MCPServerConfig, OAuthLoginResult } from "@mcpjam/sdk";

const DYNAMIC_CLIENT_ID_PLACEHOLDER = "__dynamic_registration_client__";
const DYNAMIC_CLIENT_SECRET_PLACEHOLDER = "__dynamic_registration_secret__";

function getOAuthFormat(
  command: Command,
): OAuthOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  return resolveOAuthOutputFormat(opts.format, process.stdout.isTTY);
}

function getOAuthConformanceFormat(
  command: Command,
  reporter: ReporterFormat | undefined,
): OAuthOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  return resolveConformanceOutputFormatForCli(
    opts.format,
    process.stdout.isTTY,
    reporter,
  );
}

function writeOAuthOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function buildOAuthLoginDebugOutcome(options: {
  commandError?: unknown;
  result?: OAuthLoginResult;
  credentialsFileError?: unknown;
}): DebugArtifactOutcome {
  if (options.commandError !== undefined) {
    return {
      status: "error",
      error: options.commandError,
    };
  }

  if (options.credentialsFileError !== undefined) {
    return {
      status: "error",
      result: options.result,
      error: options.credentialsFileError,
    };
  }

  if (options.result?.completed) {
    return {
      status: "success",
      result: options.result,
    };
  }

  return {
    status: "error",
    result: options.result,
    error: buildCommandArtifactError(
      "OAUTH_LOGIN_INCOMPLETE",
      options.result?.error?.message ?? "OAuth login did not complete.",
    ),
  };
}

export interface OAuthCommandOptions {
  url: string;
  protocolVersion?: "2025-03-26" | "2025-06-18" | "2025-11-25";
  registration?: "cimd" | "dcr" | "preregistered";
  authMode?: "headless" | "interactive" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  clientMetadataUrl?: string;
  redirectUrl?: string;
  scopes?: string;
  stepTimeout?: number;
  header?: string[];
  verifyTools?: boolean;
  verifyCallTool?: string;
  conformanceChecks?: boolean;
  printUrl?: boolean;
  credentialsOut?: string;
}

interface OAuthProxyCommandOptions {
  url: string;
  method?: string;
  header?: string[];
  body?: string;
}

export function registerOAuthCommands(program: Command): void {
  const oauth = program
    .command("oauth")
    .description("Run MCP OAuth login, proxy, and conformance flows");

  oauth
    .command("login")
    .description("Run an OAuth login flow against an HTTP MCP server")
    .requiredOption("--url <url>", "MCP server URL")
    .option(
      "--protocol-version <version>",
      "OAuth protocol override: 2025-03-26, 2025-06-18, or 2025-11-25",
    )
    .option(
      "--registration <strategy>",
      "Registration override: dcr, preregistered, or cimd",
    )
    .option(
      "--auth-mode <mode>",
      "Authorization mode: headless, interactive, or client_credentials",
      "interactive",
    )
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option("--client-id <id>", "OAuth client ID")
    .option("--client-secret <secret>", "OAuth client secret")
    .option(
      "--client-metadata-url <url>",
      "Client metadata URL used for CIMD registration",
    )
    .option("--redirect-url <url>", "OAuth redirect URL to use for the flow")
    .option("--scopes <scopes>", "Space-separated scope string")
    .option(
      "--step-timeout <ms>",
      "Per-step timeout in milliseconds",
      (value: string) => parsePositiveInteger(value, "Step timeout"),
      30_000,
    )
    .option(
      "--verify-tools",
      "After OAuth succeeds, verify the token by listing MCP tools",
    )
    .option(
      "--verify-call-tool <name>",
      "After listing tools, also call the named tool",
    )
    .option(
      "--debug-out <path>",
      "Write a structured debug artifact to a file",
    )
    .option(
      "--credentials-out <path>",
      "Write OAuth credentials to <path> (mode 0600); stdout output has secret fields redacted to [SAVED_TO_FILE]",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const format = getOAuthFormat(command);
      const config = buildOAuthLoginConfig(
        options as OAuthCommandOptions,
        {
          defaultAuthMode: "interactive",
        },
      );
      const snapshotCollector = options.debugOut
        ? createCliRpcLogCollector({ __cli__: config.serverUrl })
        : undefined;
      const isTTY = process.stderr.isTTY && !globalOptions.quiet;
      if (isTTY) {
        config.onProgress = (message: string) => {
          process.stderr.write(`\r\x1b[K${message}`);
        };
      }

      let result: OAuthLoginResult | undefined;
      let commandError: unknown;

      try {
        result = await runOAuthLogin(config);
      } catch (error) {
        commandError = error;
      } finally {
        if (isTTY) {
          process.stderr.write("\r\x1b[K");
        }
      }

      const snapshotConfig = buildOAuthLoginSnapshotConfig(config, result);
      const target = summarizeServerDoctorTarget(
        config.serverUrl,
        snapshotConfig,
      );

      let credentialsFilePath: string | undefined;
      let credentialsFileError: unknown;
      if (
        commandError === undefined &&
        result &&
        options.credentialsOut &&
        hasCredentialsToSave(result)
      ) {
        try {
          credentialsFilePath = await writeCredentialsFile(
            options.credentialsOut as string,
            result,
          );
        } catch (error) {
          credentialsFileError = error;
        }
      }

      await writeCommandDebugArtifact({
        outputPath: options.debugOut as string | undefined,
        format,
        quiet: globalOptions.quiet,
        commandName: "oauth login",
        commandInput: summarizeOAuthLoginCommandInput(
          options as OAuthCommandOptions,
        ),
        target,
        outcome: buildOAuthLoginDebugOutcome({
          commandError,
          result,
          credentialsFileError,
        }),
        snapshot: options.debugOut
          ? {
              input: {
                config: snapshotConfig,
                target,
                timeout: config.stepTimeout ?? 30_000,
              },
              collector: snapshotCollector,
            }
          : undefined,
      });

      if (commandError) {
        throw commandError;
      }
      if (!result) {
        throw cliError("INTERNAL_ERROR", "OAuth login did not return a result.");
      }

      if (options.credentialsOut) {
        writeResult(
          redactCredentialsFromResult(result, credentialsFilePath),
          format,
        );
        if (credentialsFileError) {
          throw credentialsFileError;
        }
      } else {
        writeResult(result, format);
      }
      if (!result.completed) {
        setProcessExitCode(1);
      }
    });

  oauth
    .command("conformance")
    .description("Run OAuth conformance against an HTTP MCP server")
    .requiredOption("--url <url>", "MCP server URL")
    .requiredOption(
      "--protocol-version <version>",
      "OAuth protocol version: 2025-03-26, 2025-06-18, or 2025-11-25",
    )
    .requiredOption(
      "--registration <strategy>",
      "Registration strategy: dcr, preregistered, or cimd",
    )
    .option(
      "--auth-mode <mode>",
      "Authorization mode: headless, interactive, or client_credentials",
      "interactive",
    )
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option("--client-id <id>", "OAuth client ID")
    .option("--client-secret <secret>", "OAuth client secret")
    .option(
      "--client-metadata-url <url>",
      "Client metadata URL used for CIMD registration",
    )
    .option("--redirect-url <url>", "OAuth redirect URL to use for the flow")
    .option("--scopes <scopes>", "Space-separated scope string")
    .option(
      "--step-timeout <ms>",
      "Per-step timeout in milliseconds",
      (value: string) => parsePositiveInteger(value, "Step timeout"),
      30_000,
    )
    .option(
      "--verify-tools",
      "After OAuth succeeds, verify the token by listing MCP tools",
    )
    .option(
      "--verify-call-tool <name>",
      "After listing tools, also call the named tool",
    )
    .option(
      "--conformance-checks",
      "Run additional OAuth negative checks (invalid client, invalid redirect, token format) after the main flow",
    )
    .option(
      "--credentials-out <path>",
      "Write OAuth credentials to <path> (mode 0600); stdout output has secret fields redacted to [SAVED_TO_FILE]",
    )
    .option(
      "--print-url",
      "In interactive mode, print the consent URL to stderr instead of launching a browser",
    )
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(async (options, command) => {
      const reporter = parseReporterFormat(options.reporter as string | undefined);
      const format = getOAuthConformanceFormat(command, reporter);
      const config = buildOAuthConformanceConfig(options as OAuthCommandOptions);
      const result = await new OAuthConformanceTest(config).run();
      let credentialsFilePath: string | undefined;
      let credentialsFileError: unknown;

      if (options.credentialsOut && hasCredentialsToSave(result)) {
        try {
          credentialsFilePath = await writeCredentialsFile(
            options.credentialsOut as string,
            result,
          );
        } catch (error) {
          credentialsFileError = error;
        }
      }

      writeOAuthOutput(
        reporter
          ? renderConformanceReporterResult(result, reporter)
          : renderOAuthConformanceResult(result, format, {
              credentialsFilePath,
            }),
      );
      if (credentialsFileError) {
        throw credentialsFileError;
      }
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });

  oauth
    .command("conformance-suite")
    .description(
      "Run a matrix of OAuth conformance flows from a JSON config file",
    )
    .requiredOption("--config <path>", "Path to JSON config file")
    .option(
      "--verify-tools",
      "Enable post-auth tool listing verification on all flows",
    )
    .option(
      "--verify-call-tool <name>",
      "Also call the named tool after listing",
    )
    .option(
      "--credentials-out <path>",
      "Write OAuth credentials from the first flow that returns credentials to <path> (mode 0600)",
    )
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(async (options, command) => {
      const reporter = parseReporterFormat(options.reporter as string | undefined);
      const format = getOAuthConformanceFormat(command, reporter);
      const config = loadOAuthSuiteConfig(options.config as string);

      if (options.verifyTools || options.verifyCallTool) {
        const cliVerification: OAuthVerificationConfig = {
          listTools: true,
          ...(options.verifyCallTool
            ? { callTool: { name: options.verifyCallTool as string } }
            : {}),
        };
        // Apply to every flow so per-flow overrides can't bypass the CLI flag
        for (const flow of config.flows) {
          flow.verification = { ...flow.verification, ...cliVerification };
        }
        config.defaults = {
          ...config.defaults,
          verification: { ...config.defaults?.verification, ...cliVerification },
        };
      }

      const suite = new OAuthConformanceSuite(config);
      const result = await suite.run();
      const credentialsResultIndex = findCredentialsResultIndex(result);
      let credentialsFilePath: string | undefined;
      let credentialsFileError: unknown;

      if (
        options.credentialsOut &&
        credentialsResultIndex !== undefined
      ) {
        try {
          credentialsFilePath = await writeCredentialsFile(
            options.credentialsOut as string,
            result.results[credentialsResultIndex],
          );
        } catch (error) {
          credentialsFileError = error;
        }
      }

      writeOAuthOutput(
        reporter
          ? renderConformanceReporterResult(result, reporter)
          : renderOAuthConformanceSuiteResult(result, format, {
              credentialsFilePath,
              credentialsResultIndex,
            }),
      );
      if (credentialsFileError) {
        throw credentialsFileError;
      }
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });

  oauth
    .command("metadata")
    .description("Fetch OAuth metadata from a URL")
    .requiredOption("--url <url>", "OAuth metadata URL")
    .action(async (options, command) => {
      const format = getOAuthFormat(command);
      const result = await runOAuthMetadata(options.url as string);
      writeResult(result, format);
    });

  oauth
    .command("proxy")
    .description("Proxy an OAuth request with hosted-mode safety checks")
    .requiredOption("--url <url>", "OAuth request URL")
    .option("--method <method>", "HTTP method", "GET")
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--body <value>",
      "Request body as JSON, raw string, @path, or - for stdin",
    )
    .action(async (options, command) => {
      const format = getOAuthFormat(command);
      const result = await runOAuthProxy(options as OAuthProxyCommandOptions);
      writeResult(result, format);
    });

  oauth
    .command("debug-proxy")
    .description("Proxy an OAuth debug request with hosted-mode safety checks")
    .requiredOption("--url <url>", "OAuth request URL")
    .option("--method <method>", "HTTP method", "GET")
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--body <value>",
      "Request body as JSON, raw string, @path, or - for stdin",
    )
    .action(async (options, command) => {
      const format = getOAuthFormat(command);
      const result = await runOAuthDebugProxy(
        options as OAuthProxyCommandOptions,
      );
      writeResult(result, format);
    });
}

export function buildOAuthConformanceConfig(
  options: OAuthCommandOptions,
  defaults?: {
    defaultAuthMode?: "headless" | "interactive" | "client_credentials";
  },
): OAuthConformanceConfig {
  const serverUrl = options.url.trim();
  assertValidUrl(serverUrl, "server URL");

  const protocolVersion = parseRequiredProtocolVersion(options.protocolVersion);
  const registrationStrategy = parseRequiredRegistrationStrategy(
    options.registration,
  );
  const authMode = parseAuthMode(
    options.authMode ?? defaults?.defaultAuthMode ?? "interactive",
  );

  if (options.printUrl && authMode !== "interactive") {
    throw usageError(
      "--print-url only applies to --auth-mode interactive. Headless and client_credentials modes do not open a browser.",
    );
  }

  if (
    protocolVersion !== "2025-11-25" &&
    registrationStrategy === "cimd"
  ) {
    throw usageError(
      `CIMD registration is not supported for protocol version ${protocolVersion}.`,
    );
  }

  if (authMode === "client_credentials" && registrationStrategy === "cimd") {
    throw usageError(
      "--auth-mode client_credentials cannot be used with --registration cimd. CIMD is a browser-based registration flow and only works with --auth-mode headless or --auth-mode interactive. For client_credentials, use --registration dcr or --registration preregistered instead.",
    );
  }

  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret;
  const clientMetadataUrl = options.clientMetadataUrl?.trim();
  const redirectUrl = options.redirectUrl?.trim();

  if (registrationStrategy === "preregistered" && !clientId) {
    throw usageError(
      "--client-id is required when --registration preregistered is used.",
    );
  }

  if (
    registrationStrategy === "preregistered" &&
    authMode === "client_credentials" &&
    !clientSecret
  ) {
    throw usageError(
      "--client-secret is required for preregistered client_credentials runs.",
    );
  }

  if (clientMetadataUrl) {
    assertValidUrl(clientMetadataUrl, "client metadata URL");
  }

  if (redirectUrl) {
    assertValidUrl(redirectUrl, "redirect URL");
  }

  const customHeaders = parseHeadersOption(options.header);
  const client: NonNullable<OAuthConformanceConfig["client"]> = {};

  if (registrationStrategy === "preregistered" && clientId) {
    client.preregistered = {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  if (clientMetadataUrl) {
    client.clientIdMetadataUrl = clientMetadataUrl;
  }

  const verification: OAuthVerificationConfig | undefined =
    options.verifyTools || options.verifyCallTool
      ? {
          listTools: options.verifyTools ?? !!options.verifyCallTool,
          ...(options.verifyCallTool
            ? { callTool: { name: options.verifyCallTool } }
            : {}),
        }
      : undefined;

  const auth = buildAuthConfig(authMode, registrationStrategy, clientId, clientSecret);

  if (options.printUrl && auth.mode === "interactive") {
    (auth as { openUrl?: (url: string) => Promise<void> }).openUrl =
      async (url: string) => {
        process.stderr.write(`OAUTH_CONSENT_URL: ${url}\n`);
      };
  }

  return {
    serverUrl,
    protocolVersion,
    registrationStrategy,
    auth,
    client,
    scopes: options.scopes?.trim() || undefined,
    customHeaders,
    redirectUrl,
    stepTimeout: options.stepTimeout ?? 30_000,
    verification,
    oauthConformanceChecks: options.conformanceChecks ?? false,
  };
}

function findCredentialsResultIndex(
  result: OAuthConformanceSuiteResult,
): number | undefined {
  const index = result.results.findIndex(hasCredentialsToSave);
  return index >= 0 ? index : undefined;
}

export function buildOAuthLoginConfig(
  options: OAuthCommandOptions,
  defaults?: {
    defaultAuthMode?: "headless" | "interactive" | "client_credentials";
  },
): OAuthLoginConfig {
  const serverUrl = options.url.trim();
  assertValidUrl(serverUrl, "server URL");

  const protocolVersion = options.protocolVersion
    ? parseProtocolVersion(options.protocolVersion)
    : undefined;
  const registrationStrategy = options.registration
    ? parseRegistrationStrategy(options.registration)
    : undefined;
  const authMode = parseAuthMode(
    options.authMode ?? defaults?.defaultAuthMode ?? "interactive",
  );

  if (options.printUrl && authMode !== "interactive") {
    throw usageError(
      "--print-url only applies to --auth-mode interactive. Headless and client_credentials modes do not open a browser.",
    );
  }

  if (
    protocolVersion !== undefined &&
    registrationStrategy === "cimd" &&
    protocolVersion !== "2025-11-25"
  ) {
    throw usageError(
      `CIMD registration is not supported for protocol version ${protocolVersion}.`,
    );
  }

  if (authMode === "client_credentials" && registrationStrategy === "cimd") {
    throw usageError(
      "--auth-mode client_credentials cannot be used with --registration cimd. CIMD is a browser-based registration flow and only works with --auth-mode headless or --auth-mode interactive. For client_credentials, use --registration dcr or --registration preregistered instead.",
    );
  }

  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret;
  const clientMetadataUrl = options.clientMetadataUrl?.trim();
  const redirectUrl = options.redirectUrl?.trim();

  if (registrationStrategy === "preregistered" && !clientId) {
    throw usageError(
      "--client-id is required when --registration preregistered is used.",
    );
  }

  if (
    registrationStrategy === "preregistered" &&
    authMode === "client_credentials" &&
    !clientSecret
  ) {
    throw usageError(
      "--client-secret is required for preregistered client_credentials runs.",
    );
  }

  if (clientMetadataUrl) {
    assertValidUrl(clientMetadataUrl, "client metadata URL");
  }

  if (redirectUrl) {
    assertValidUrl(redirectUrl, "redirect URL");
  }

  const customHeaders = parseHeadersOption(options.header);
  const client: NonNullable<OAuthLoginConfig["client"]> = {};

  if (clientId) {
    client.preregistered = {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  if (clientMetadataUrl) {
    client.clientIdMetadataUrl = clientMetadataUrl;
  }

  const verification: OAuthVerificationConfig | undefined =
    options.verifyTools || options.verifyCallTool
      ? {
          listTools: options.verifyTools ?? !!options.verifyCallTool,
          ...(options.verifyCallTool
            ? { callTool: { name: options.verifyCallTool } }
            : {}),
        }
      : undefined;

  const auth = buildAuthConfig(
    authMode,
    registrationStrategy ?? "dcr",
    clientId,
    clientSecret,
  );

  if (options.printUrl && auth.mode === "interactive") {
    (auth as { openUrl?: (url: string) => Promise<void> }).openUrl =
      async (url: string) => {
        process.stderr.write(`OAUTH_CONSENT_URL: ${url}\n`);
      };
  }

  return {
    serverUrl,
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(registrationStrategy ? { registrationStrategy } : {}),
    protocolMode: protocolVersion ?? "auto",
    registrationMode: registrationStrategy ?? "auto",
    auth,
    client,
    scopes: options.scopes?.trim() || undefined,
    customHeaders,
    redirectUrl,
    stepTimeout: options.stepTimeout ?? 30_000,
    verification,
    oauthConformanceChecks: false,
  };
}

export function summarizeOAuthLoginCommandInput(
  options: OAuthCommandOptions,
): Record<string, unknown> {
  return {
    serverUrl: options.url.trim(),
    protocolMode: options.protocolVersion ?? "auto",
    registrationMode: options.registration ?? "auto",
    protocolVersion: options.protocolVersion,
    registration: options.registration,
    authMode: options.authMode ?? "interactive",
    redirectUrl: options.redirectUrl?.trim() || undefined,
    scopes: options.scopes?.trim() || undefined,
    clientMetadataUrl: options.clientMetadataUrl?.trim() || undefined,
    headerNames: Object.keys(parseHeadersOption(options.header) ?? {}),
    hasClientId: Boolean(options.clientId?.trim()),
    hasClientSecret: Boolean(options.clientSecret),
    verifyTools: options.verifyTools ?? false,
    verifyCallTool: options.verifyCallTool ?? undefined,
    stepTimeout: options.stepTimeout ?? 30_000,
  };
}

export function buildOAuthLoginSnapshotConfig(
  config: Pick<
    OAuthLoginConfig,
    "serverUrl" | "customHeaders" | "stepTimeout" | "client" | "auth"
  >,
  result?: OAuthLoginResult,
): MCPServerConfig {
  const baseConfig: MCPServerConfig = {
    url: config.serverUrl,
    ...(config.customHeaders
      ? { requestInit: { headers: config.customHeaders } }
      : {}),
    timeout: config.stepTimeout ?? 30_000,
  };
  if (!result) {
    return baseConfig;
  }

  const clientId =
    result.credentials.clientId ??
    config.client?.preregistered?.clientId ??
    (config.auth?.mode === "client_credentials" ? config.auth.clientId : undefined);
  const clientSecret =
    result.credentials.clientSecret ??
    config.client?.preregistered?.clientSecret ??
    (config.auth?.mode === "client_credentials"
      ? config.auth.clientSecret
      : undefined);

  if (result.credentials.accessToken) {
    return {
      ...baseConfig,
      accessToken: result.credentials.accessToken,
    };
  }

  if (result.credentials.refreshToken && clientId) {
    return {
      ...baseConfig,
      refreshToken: result.credentials.refreshToken,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }

  return baseConfig;
}

function buildAuthConfig(
  authMode: "headless" | "interactive" | "client_credentials",
  registrationStrategy: OAuthCommandOptions["registration"],
  clientId: string | undefined,
  clientSecret: string | undefined,
): NonNullable<OAuthConformanceConfig["auth"]> {
  switch (authMode) {
    case "headless":
      return { mode: "headless" };
    case "interactive":
      return { mode: "interactive" };
    case "client_credentials":
      return {
        mode: "client_credentials",
        clientId:
          clientId ??
          (registrationStrategy === "dcr"
            ? DYNAMIC_CLIENT_ID_PLACEHOLDER
            : ""),
        clientSecret:
          clientSecret ??
          (registrationStrategy === "dcr"
            ? DYNAMIC_CLIENT_SECRET_PLACEHOLDER
            : ""),
      };
    default:
      throw usageError(`Unsupported auth mode "${authMode}".`);
  }
}

function assertValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}

function parseProtocolVersion(
  value: string,
): "2025-03-26" | "2025-06-18" | "2025-11-25" {
  if (VALID_PROTOCOL_VERSIONS.has(value)) {
    return value as "2025-03-26" | "2025-06-18" | "2025-11-25";
  }

  throw usageError(
    `Invalid protocol version "${value}". Use ${[...VALID_PROTOCOL_VERSIONS].join(", ")}.`,
  );
}

function parseRequiredProtocolVersion(
  value: string | undefined,
): "2025-03-26" | "2025-06-18" | "2025-11-25" {
  if (!value) {
    throw usageError(
      "--protocol-version is required for oauth conformance flows.",
    );
  }

  return parseProtocolVersion(value);
}

function parseRegistrationStrategy(
  value: string,
): "cimd" | "dcr" | "preregistered" {
  if (VALID_REGISTRATION_STRATEGIES.has(value)) {
    return value as "cimd" | "dcr" | "preregistered";
  }

  throw usageError(
    `Invalid registration strategy "${value}". Use ${[...VALID_REGISTRATION_STRATEGIES].join(", ")}.`,
  );
}

function parseRequiredRegistrationStrategy(
  value: string | undefined,
): "cimd" | "dcr" | "preregistered" {
  if (!value) {
    throw usageError(
      "--registration is required for oauth conformance flows.",
    );
  }

  return parseRegistrationStrategy(value);
}

function parseAuthMode(
  value: string,
): "headless" | "interactive" | "client_credentials" {
  if (VALID_AUTH_MODES.has(value)) {
    return value as "headless" | "interactive" | "client_credentials";
  }

  throw usageError(
    `Invalid auth mode "${value}". Use ${[...VALID_AUTH_MODES].join(", ")}.`,
  );
}

export async function runOAuthMetadata(url: string) {
  try {
    const result = await fetchOAuthMetadata(url, true);
    if ("status" in result && result.status !== undefined) {
      throw cliError(
        statusToErrorCode(result.status),
        `Failed to fetch OAuth metadata: ${result.status} ${result.statusText}`,
      );
    }

    return result.metadata;
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}

export async function runOAuthProxy(options: OAuthProxyCommandOptions) {
  try {
    return await executeOAuthProxy({
      url: options.url,
      method: options.method,
      headers: parseHeadersOption(options.header),
      body: parseProxyBody(options.body),
      httpsOnly: true,
    });
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}

export async function runOAuthDebugProxy(options: OAuthProxyCommandOptions) {
  try {
    return await executeDebugOAuthProxy({
      url: options.url,
      method: options.method,
      headers: parseHeadersOption(options.header),
      body: parseProxyBody(options.body),
      httpsOnly: true,
    });
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}

export function parseProxyBody(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }

  const source = readInputSource(value, "Request body");

  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}

export function mapOAuthProxyError(error: unknown) {
  if (error instanceof OAuthProxyError) {
    return cliError(statusToErrorCode(error.status), error.message);
  }
  return error;
}

function statusToErrorCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502) return "SERVER_UNREACHABLE";
  if (status === 504) return "TIMEOUT";
  return "INTERNAL_ERROR";
}
