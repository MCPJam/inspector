import type { OAuthConformanceConfig } from "@mcpjam/sdk";
import { OAuthConformanceTest } from "@mcpjam/sdk";
import { Command } from "commander";
import {
  getGlobalOptions,
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config";
import { setProcessExitCode, usageError, writeResult } from "../lib/output";

const DYNAMIC_CLIENT_ID_PLACEHOLDER = "__dynamic_registration_client__";
const DYNAMIC_CLIENT_SECRET_PLACEHOLDER = "__dynamic_registration_secret__";

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
    .action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const config = buildOAuthConformanceConfig(options as OAuthCommandOptions);
    const result = await new OAuthConformanceTest(config).run();

    writeResult(result, globalOptions.format);
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

  return {
    serverUrl,
    protocolVersion,
    registrationStrategy,
    auth: buildAuthConfig(authMode, registrationStrategy, clientId, clientSecret),
    client,
    scopes: options.scopes?.trim() || undefined,
    customHeaders,
    stepTimeout: options.stepTimeout ?? 30_000,
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
  if (
    value === "2025-03-26" ||
    value === "2025-06-18" ||
    value === "2025-11-25"
  ) {
    return value;
  }

  throw usageError(
    `Invalid protocol version "${value}". Use 2025-03-26, 2025-06-18, or 2025-11-25.`,
  );
}

function parseRegistrationStrategy(
  value: string,
): "cimd" | "dcr" | "preregistered" {
  if (value === "cimd" || value === "dcr" || value === "preregistered") {
    return value;
  }

  throw usageError(
    `Invalid registration strategy "${value}". Use cimd, dcr, or preregistered.`,
  );
}

function parseAuthMode(
  value: string,
): "headless" | "interactive" | "client_credentials" {
  if (
    value === "headless" ||
    value === "interactive" ||
    value === "client_credentials"
  ) {
    return value;
  }

  throw usageError(
    `Invalid auth mode "${value}". Use headless, interactive, or client_credentials.`,
  );
}
