import type { OAuthConformanceConfig, OAuthVerificationConfig } from "@mcpjam/sdk";
import { OAuthConformanceTest, OAuthConformanceSuite } from "@mcpjam/sdk";
import { Command } from "commander";
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
  setProcessExitCode,
  usageError,
  writeResult,
  type OutputFormat,
} from "../lib/output";
import { loadSuiteConfig } from "../lib/config-file";
import { singleResultToJUnitXml, suiteResultToJUnitXml } from "../lib/junit-xml";

const DYNAMIC_CLIENT_ID_PLACEHOLDER = "__dynamic_registration_client__";
const DYNAMIC_CLIENT_SECRET_PLACEHOLDER = "__dynamic_registration_secret__";

type OAuthOutputFormat = OutputFormat | "junit-xml";

function parseOAuthOutputFormat(value: string): OAuthOutputFormat {
  if (value === "json" || value === "human" || value === "junit-xml") {
    return value;
  }
  throw usageError(
    `Invalid output format "${value}". Use "json", "human", or "junit-xml".`,
  );
}

function getOAuthFormat(command: Command): OAuthOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  return parseOAuthOutputFormat(opts.format ?? "json");
}

export interface OAuthCommandOptions {
  url: string;
  protocolVersion: "2025-03-26" | "2025-06-18" | "2025-11-25";
  registration: "cimd" | "dcr" | "preregistered";
  authMode?: "headless" | "interactive" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  clientMetadataUrl?: string;
  scopes?: string;
  stepTimeout?: number;
  header?: string[];
  verifyTools?: boolean;
  verifyCallTool?: string;
}

export function registerOAuthCommands(program: Command): void {
  const oauth = program
    .command("oauth")
    .description("Run MCP OAuth conformance flows");

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

      if (format === "junit-xml") {
        process.stdout.write(singleResultToJUnitXml(result));
      } else {
        writeResult(result, format);
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

      if (format === "junit-xml") {
        process.stdout.write(suiteResultToJUnitXml(result));
      } else {
        writeResult(result, format);
      }
      if (!result.passed) {
        setProcessExitCode(1);
      }
    });
}

export function buildOAuthConformanceConfig(
  options: OAuthCommandOptions,
): OAuthConformanceConfig {
  const serverUrl = options.url.trim();
  assertValidUrl(serverUrl, "server URL");

  const protocolVersion = parseProtocolVersion(options.protocolVersion);
  const registrationStrategy = parseRegistrationStrategy(options.registration);
  const authMode = parseAuthMode(options.authMode ?? "headless");

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
      "client_credentials is not supported with --registration cimd.",
    );
  }

  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret;
  const clientMetadataUrl = options.clientMetadataUrl?.trim();

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
