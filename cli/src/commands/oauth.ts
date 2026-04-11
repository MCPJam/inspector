import type { OAuthConformanceConfig, OAuthVerificationConfig } from "@mcpjam/sdk";
import {
  OAuthConformanceTest,
  OAuthConformanceSuite,
  runOAuthLogin,
} from "@mcpjam/sdk";
import { Command } from "commander";
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../../mcpjam-inspector/server/utils/oauth-proxy";
import {
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config";
import {
  VALID_PROTOCOL_VERSIONS,
  VALID_REGISTRATION_STRATEGIES,
  VALID_AUTH_MODES,
} from "../lib/oauth-enums";
import {
  cliError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output";
import { loadSuiteConfig } from "../lib/config-file";
import {
  renderOAuthConformanceResult,
  renderOAuthConformanceSuiteResult,
  resolveOAuthOutputFormat,
  type OAuthOutputFormat,
} from "../lib/oauth-output";

const DYNAMIC_CLIENT_ID_PLACEHOLDER = "__dynamic_registration_client__";
const DYNAMIC_CLIENT_SECRET_PLACEHOLDER = "__dynamic_registration_secret__";

function getOAuthFormat(command: Command): OAuthOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  return resolveOAuthOutputFormat(opts.format, process.stdout.isTTY);
}

function getStructuredOAuthFormat(command: Command): "json" | "human" {
  const format = getOAuthFormat(command);
  if (format === "junit-xml") {
    throw usageError(
      'The oauth metadata/proxy commands only support --format "json" or "human".',
    );
  }
  return format;
}

function writeOAuthOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export interface OAuthCommandOptions {
  url: string;
  protocolVersion: "2025-03-26" | "2025-06-18" | "2025-11-25";
  registration: "cimd" | "dcr" | "preregistered";
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
    .action(async (options, command) => {
      const format = getStructuredOAuthFormat(command);
      const config = buildOAuthConformanceConfig(
        options as OAuthCommandOptions,
        {
          defaultAuthMode: "interactive",
        },
      );
      const result = await runOAuthLogin(config);

      writeResult(result, format);
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
      "headless",
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
    .action(async (options, command) => {
      const format = getOAuthFormat(command);
      const config = buildOAuthConformanceConfig(options as OAuthCommandOptions);
      const result = await new OAuthConformanceTest(config).run();

      writeOAuthOutput(renderOAuthConformanceResult(result, format));
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
    .action(async (options, command) => {
      const format = getOAuthFormat(command);
      const config = loadSuiteConfig(options.config as string);

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

      writeOAuthOutput(renderOAuthConformanceSuiteResult(result, format));
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });

  oauth
    .command("metadata")
    .description("Fetch OAuth metadata from a URL")
    .requiredOption("--url <url>", "OAuth metadata URL")
    .action(async (options, command) => {
      const result = await runOAuthMetadata(options.url as string);
      writeResult(result, getStructuredOAuthFormat(command));
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
    .option("--body <value>", "Request body as JSON or raw string")
    .action(async (options, command) => {
      const result = await runOAuthProxy(options as OAuthProxyCommandOptions);
      writeResult(result, getStructuredOAuthFormat(command));
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
    .option("--body <value>", "Request body as JSON or raw string")
    .action(async (options, command) => {
      const result = await runOAuthDebugProxy(
        options as OAuthProxyCommandOptions,
      );
      writeResult(result, getStructuredOAuthFormat(command));
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

  const protocolVersion = parseProtocolVersion(options.protocolVersion);
  const registrationStrategy = parseRegistrationStrategy(options.registration);
  const authMode = parseAuthMode(
    options.authMode ?? defaults?.defaultAuthMode ?? "headless",
  );

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

  return {
    serverUrl,
    protocolVersion,
    registrationStrategy,
    auth: buildAuthConfig(authMode, registrationStrategy, clientId, clientSecret),
    client,
    scopes: options.scopes?.trim() || undefined,
    customHeaders,
    redirectUrl,
    stepTimeout: options.stepTimeout ?? 30_000,
    verification,
  };
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

  try {
    return JSON.parse(value);
  } catch {
    return value;
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
