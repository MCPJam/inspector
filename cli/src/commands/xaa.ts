import { runXaaFlow, type XaaFlowConfig, type XaaFlowResult } from "@mcpjam/sdk";
import { Command } from "commander";
import { getGlobalOptions } from "../lib/server-config.js";
import { cliError, setProcessExitCode, usageError, writeResult } from "../lib/output.js";

export interface XaaCommandOptions {
  url: string;
  issuerBaseUrl: string;
  sub: string;
  clientId: string;
  authzServerIssuer?: string;
  tokenEndpoint?: string;
  email?: string;
  clientSecret?: string;
  scopes?: string;
  httpsOnly?: boolean;
}

export function registerXaaCommands(program: Command): void {
  const xaa = program
    .command("xaa")
    .description(
      "Run the Cross-App Access (ID-JAG) debugger against an MCP server",
    );

  xaa
    .command("run")
    .description(
      "Self-issue an ID-JAG, redeem it at the target authorization server (RFC 7523), and call the MCP server with the resulting access token",
    )
    .requiredOption("--url <url>", "Target MCP server URL (the protected resource)")
    .requiredOption(
      "--issuer-base-url <url>",
      "Origin the local mock IdP issues from (the AS must be able to fetch its JWKS from here to validate the ID-JAG)",
    )
    .requiredOption("--sub <subject>", "Simulated end-user subject identifier")
    .requiredOption(
      "--client-id <id>",
      "OAuth client the ID-JAG is issued for; also presented at redemption",
    )
    .option(
      "--authz-server-issuer <issuer>",
      "Target authorization-server issuer. When set, protected-resource metadata discovery is skipped",
    )
    .option(
      "--token-endpoint <url>",
      "Authorization-server token endpoint. When set, AS-metadata discovery is skipped",
    )
    .option("--email <email>", "Simulated end-user email claim")
    .option("--client-secret <secret>", "OAuth client secret presented at redemption")
    .option("--scopes <scopes>", "Space-separated scope string")
    .option(
      "--https-only",
      "Reject non-HTTPS / private targets (default: allow http/localhost for local dev)",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const format = globalOptions.format;
      const config = buildXaaConfig(options as XaaCommandOptions);

      const isTTY = process.stderr.isTTY && !globalOptions.quiet;
      if (isTTY) {
        config.onProgress = (message: string) => {
          process.stderr.write(`\r\x1b[K${message}`);
        };
      }

      let result: XaaFlowResult | undefined;
      try {
        result = await runXaaFlow(config);
      } finally {
        if (isTTY) {
          process.stderr.write("\r\x1b[K");
        }
      }

      if (!result) {
        throw cliError("INTERNAL_ERROR", "XAA flow did not return a result.");
      }

      writeResult(result, format);
      if (!result.completed) {
        setProcessExitCode(1);
      }
    });
}

export function buildXaaConfig(options: XaaCommandOptions): XaaFlowConfig {
  const serverUrl = options.url.trim();
  assertValidUrl(serverUrl, "server URL");

  const issuerBaseUrl = options.issuerBaseUrl.trim();
  assertValidUrl(issuerBaseUrl, "issuer base URL");

  const subject = options.sub.trim();
  if (!subject) {
    throw usageError("--sub must not be empty.");
  }

  const clientId = options.clientId.trim();
  if (!clientId) {
    throw usageError("--client-id must not be empty.");
  }

  const authzServerIssuer = options.authzServerIssuer?.trim() || undefined;
  if (authzServerIssuer) {
    assertValidUrl(authzServerIssuer, "authorization server issuer");
  }

  const tokenEndpoint = options.tokenEndpoint?.trim() || undefined;
  if (tokenEndpoint) {
    assertValidUrl(tokenEndpoint, "token endpoint");
  }

  return {
    serverUrl,
    issuerBaseUrl,
    subject,
    clientId,
    ...(authzServerIssuer ? { authzServerIssuer } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(options.email?.trim() ? { email: options.email.trim() } : {}),
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    ...(options.scopes?.trim() ? { scope: options.scopes.trim() } : {}),
    httpsOnly: options.httpsOnly ?? false,
  };
}

function assertValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}
