import {
  IDENTITY_ASSERTION_FORMATS,
  XAA_CONFIDENTIAL_CIMD_ORIGIN,
  buildConfidentialCimdUrl,
  getXaaClientJwks,
  initXaaClientKeyPair,
  isLoopbackHost,
  normalizeIdentityAssertionFormat,
  normalizeRegistrationStrategy,
  runXaaFlow,
  type IdentityAssertionFormat,
  type RegistrationStrategy,
  type XaaFlowConfig,
  type XaaFlowResult,
} from "@mcpjam/sdk";
import { Command } from "commander";
import { getGlobalOptions } from "../lib/server-config.js";
import { cliError, setProcessExitCode, usageError, writeResult } from "../lib/output.js";
import { redactSensitiveValue } from "../lib/redaction.js";

type XaaTokenEndpointAuthMethod =
  | "client_secret_post"
  | "client_secret_basic"
  | "none";
type XaaClientAuth = "none" | "private_key_jwt";
type XaaCliFlowConfig = XaaFlowConfig & {
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod;
  timeoutMs?: number;
  // CLI-only (ignored by runXaaFlow): resolved in the action into the confidential
  // CIMD metadata URL + the client signing key.
  clientAuth?: XaaClientAuth;
  cimdMetadataOrigin?: string;
};

export interface XaaCommandOptions {
  url: string;
  issuerBaseUrl: string;
  sub: string;
  clientId?: string;
  registration?: RegistrationStrategy;
  clientMetadataUrl?: string;
  clientAuth?: XaaClientAuth;
  cimdMetadataOrigin?: string;
  authzServerIssuer?: string;
  tokenEndpoint?: string;
  email?: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod;
  assertionFormat?: IdentityAssertionFormat;
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
    .option(
      "--client-id <id>",
      "OAuth client the ID-JAG is issued for; also presented at redemption. Required for --registration preregistered (the default); rejected for dcr/cimd (the identity is derived)",
    )
    .option(
      "--registration <method>",
      "Client-registration strategy: preregistered (default); dcr (RFC 7591 dynamic registration at the RAS — a diagnostic that simulates the IdP→RAS client_id mapping and may leave a registration behind each run); or cimd (Client ID Metadata Document — public client, interop-only, not a recommended production posture)",
      parseRegistration,
    )
    .option(
      "--client-metadata-url <url>",
      "CIMD only: the Client ID Metadata Document URL to present as the client_id (default: the hosted XAA debugger document)",
    )
    .option(
      "--client-auth <method>",
      "CIMD only: how the client authenticates. none (public, default) or private-key-jwt (confidential — generates a client key, publishes it via the hosted reflector, and signs a client_assertion)",
      parseClientAuth,
    )
    .option(
      "--cimd-metadata-origin <url>",
      "Confidential CIMD only: origin hosting the metadata-document reflector (default: the hosted app.mcpjam.com). An http loopback origin is a dev-only opt-in (requires no --https-only)",
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
    .option(
      "--token-endpoint-auth-method <method>",
      "Token endpoint client authentication: client_secret_basic, client_secret_post, or none (default: infer from metadata)",
      parseTokenEndpointAuthMethod,
    )
    .option(
      "--assertion-format <format>",
      "Identity assertion format the mock IdP mints: oidc (ID token, default) or saml (SAML 2.0 assertion)",
      parseAssertionFormat,
    )
    .option("--scopes <scopes>", "Space-separated scope string")
    .option(
      "--https-only",
      "Reject non-HTTPS / private targets (default: allow http/localhost for local dev)",
    )
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const format = globalOptions.format;
      const config = buildXaaConfig(
        options as XaaCommandOptions,
        globalOptions.timeout,
      );
      resolveConfidentialCimd(config, globalOptions.quiet);

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

      writeResult(redactXaaResult(result), format);
      printRegistrationNotes(result, globalOptions.quiet);
      if (!result.completed) {
        setProcessExitCode(1);
      }
    });
}

/**
 * Emit the security/semantics caveats the ID-JAG draft calls for to stderr (so
 * the stdout result stays clean): DCR is a RAS diagnostic that simulates the
 * IdP↔RAS client_id mapping and leaks a registration per run (no RFC 7592
 * cleanup); public-client CIMD is interop-only, not a recommended posture.
 */
export function printRegistrationNotes(
  result: XaaFlowResult,
  quiet?: boolean,
): void {
  if (quiet) return;
  const reg = result.registration;
  if (!reg) return;
  if (reg.strategy === "dcr" && reg.clientId) {
    // The client_id is RAS-provided; strip control chars so a hostile RAS can't
    // inject ANSI/newline sequences to spoof or rewrite the terminal note.
    const safeClientId = reg.clientId.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    process.stderr.write(
      `Note: DCR is a RAS diagnostic — the CLI supplies the IdP→RAS client_id ` +
        `mapping itself (simulated IdP), so a real enterprise IdP would still ` +
        `need to be told the RAS-minted client_id ("${safeClientId}"). Each run ` +
        `may leave another registration behind (no RFC 7592 cleanup).\n`,
    );
  }
  if (
    reg.strategy === "cimd" &&
    reg.warnings.some((w) => w.code === "public_client")
  ) {
    process.stderr.write(
      `Note: public-client CIMD — interoperability passed, but the security ` +
        `posture is not recommended (ID-JAG draft-04 §9.1 recommends ` +
        `confidential clients / private_key_jwt).\n`,
    );
  }
}

// Never emit raw bearer credentials. First mask the ID-JAG itself — the SDK's
// recursive redactor keys on token-ish field names and won't catch a bare
// `token` field — then run redactSensitiveValue over the whole result to scrub
// reflected or nested secrets (the AS's access_token/refresh_token/id_token,
// Bearer strings, etc.) anywhere in the output. The decoded `idJag.claims`, the
// verify verdict, and the per-step report keep the debug value.
export function redactXaaResult(result: XaaFlowResult): XaaFlowResult {
  const rawIdJag = result.idJag?.token;
  const masked: XaaFlowResult = result.idJag
    ? { ...result, idJag: { ...result.idJag, token: "[REDACTED]" } }
    : result;
  const scrubbed = redactSensitiveValue(masked) as XaaFlowResult;
  // A token endpoint may reflect the submitted `assertion` (the raw ID-JAG) in
  // an error body under a non-secret field name (e.g. `assertion`,
  // `error_description`), which the key-based redactor and the Bearer-string
  // pattern won't catch. Scrub any remaining occurrence of the raw ID-JAG.
  const afterRaw = rawIdJag
    ? (replaceRawValue(scrubbed, rawIdJag) as XaaFlowResult)
    : scrubbed;
  // The registration diagnostics are secret-free by construction (the DCR
  // client_secret never enters the result), but the recursive redactor would
  // otherwise mangle them: `code` is a redacted key (OAuth authz code) and
  // warning messages mention "Bearer grant". Restore them verbatim.
  return result.registration
    ? { ...afterRaw, registration: result.registration }
    : afterRaw;
}

function replaceRawValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") {
    return value.includes(secret)
      ? value.split(secret).join("[REDACTED]")
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceRawValue(entry, secret));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        replaceRawValue(entryValue, secret),
      ]),
    );
  }
  return value;
}

export function buildXaaConfig(
  options: XaaCommandOptions,
  timeoutMs?: number,
): XaaCliFlowConfig {
  const serverUrl = options.url.trim();
  assertValidUrl(serverUrl, "server URL");

  const issuerBaseUrl = options.issuerBaseUrl.trim();
  assertValidUrl(issuerBaseUrl, "issuer base URL");

  const subject = options.sub.trim();
  if (!subject) {
    throw usageError("--sub must not be empty.");
  }

  const strategy: RegistrationStrategy =
    options.registration ?? "preregistered";
  const isDynamic = strategy === "dcr" || strategy === "cimd";

  // Client identity. Pre-registered runs supply it; DCR mints it, CIMD derives
  // it from the metadata-document URL — so it is rejected for those.
  const clientId = options.clientId?.trim() || undefined;
  if (strategy === "preregistered" && !clientId) {
    throw usageError(
      "--client-id is required for the preregistered strategy (the default). Use --registration dcr or --registration cimd to obtain the client identity dynamically.",
    );
  }
  if (isDynamic && clientId) {
    throw usageError(
      `--client-id must not be set with --registration ${strategy}: the client identity is ${
        strategy === "dcr"
          ? "minted by dynamic registration"
          : "the client-metadata-document URL"
      }.`,
    );
  }
  if (isDynamic && options.clientSecret) {
    throw usageError(
      `--client-secret must not be set with --registration ${strategy}.`,
    );
  }
  if (isDynamic && options.tokenEndpointAuthMethod) {
    throw usageError(
      `--token-endpoint-auth-method must not be set with --registration ${strategy}: the auth method is derived from ${
        strategy === "dcr" ? "the registration response" : "the metadata document"
      }.`,
    );
  }

  const clientMetadataUrl = options.clientMetadataUrl?.trim() || undefined;
  if (clientMetadataUrl) {
    assertValidUrl(clientMetadataUrl, "client metadata URL");
    if (strategy !== "cimd") {
      throw usageError(
        "--client-metadata-url is only valid with --registration cimd.",
      );
    }
  }

  // Confidential CIMD (private_key_jwt): the CLI generates a client key and
  // publishes it via the hosted reflector, so it serves its own document.
  const clientAuth: XaaClientAuth = options.clientAuth ?? "none";
  const cimdMetadataOrigin = options.cimdMetadataOrigin?.trim() || undefined;
  if (clientAuth === "private_key_jwt" && strategy !== "cimd") {
    throw usageError(
      "--client-auth private-key-jwt is only valid with --registration cimd.",
    );
  }
  if (clientAuth === "private_key_jwt" && clientMetadataUrl) {
    throw usageError(
      "--client-metadata-url cannot be combined with --client-auth private-key-jwt: the confidential client publishes its own metadata document via the reflector.",
    );
  }
  if (cimdMetadataOrigin) {
    assertValidUrl(cimdMetadataOrigin, "CIMD metadata origin");
    if (clientAuth !== "private_key_jwt") {
      throw usageError(
        "--cimd-metadata-origin is only valid with --client-auth private-key-jwt.",
      );
    }
    // It must be a bare origin: buildConfidentialCimdUrl concatenates the raw
    // string with the reflector path, so a trailing path/query/fragment would
    // produce a client_id that never resolves to the reflector route.
    const parsed = new URL(cimdMetadataOrigin);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw usageError(
        "--cimd-metadata-origin must be a bare origin (scheme + host[:port]) with no path, query, or fragment.",
      );
    }
  }

  const authzServerIssuer = options.authzServerIssuer?.trim() || undefined;
  if (authzServerIssuer) {
    assertValidUrl(authzServerIssuer, "authorization server issuer");
  }

  const tokenEndpoint = options.tokenEndpoint?.trim() || undefined;
  if (tokenEndpoint) {
    assertValidUrl(tokenEndpoint, "token endpoint");
    // DCR/CIMD need authorization-server metadata discovery; --token-endpoint
    // skips it (--authz-server-issuer only skips protected-resource discovery,
    // which is fine — AS metadata is still fetched).
    if (isDynamic) {
      throw usageError(
        `--token-endpoint must not be set with --registration ${strategy}: it skips the authorization-server metadata discovery that ${
          strategy === "dcr"
            ? "DCR needs (registration_endpoint)"
            : "CIMD needs (client_id_metadata_document_supported)"
        }.`,
      );
    }
  }

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw usageError("--timeout must be a positive number.");
  }
  if (
    options.tokenEndpointAuthMethod !== "none" &&
    options.tokenEndpointAuthMethod !== undefined &&
    !options.clientSecret
  ) {
    throw usageError(
      `--token-endpoint-auth-method ${options.tokenEndpointAuthMethod} requires --client-secret.`,
    );
  }

  return {
    serverUrl,
    issuerBaseUrl,
    subject,
    ...(clientId ? { clientId } : {}),
    ...(strategy !== "preregistered" ? { registrationStrategy: strategy } : {}),
    ...(clientMetadataUrl ? { clientIdMetadataUrl: clientMetadataUrl } : {}),
    ...(clientAuth !== "none" ? { clientAuth } : {}),
    ...(cimdMetadataOrigin ? { cimdMetadataOrigin } : {}),
    ...(authzServerIssuer ? { authzServerIssuer } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(options.email?.trim() ? { email: options.email.trim() } : {}),
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    ...(options.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: options.tokenEndpointAuthMethod }
      : {}),
    // --assertion-format is a PRESET setting both identity axes together:
    // "saml" mints a SAML 2.0 assertion AND a saml-nameid `sub_id` in the
    // ID-JAG. "oidc" (the default) leaves both fields unset so the SDK's own
    // defaults ("oidc" / "oauth-sub") apply, matching how the other optionals
    // preserve undefined. Programmatic users can still mix the axes on
    // XaaFlowConfig directly.
    ...(options.assertionFormat === "saml"
      ? {
          identityAssertionFormat: "saml" as const,
          subjectIdentifierFormat: "saml-nameid" as const,
        }
      : {}),
    ...(options.scopes?.trim() ? { scope: options.scopes.trim() } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    httpsOnly: options.httpsOnly ?? false,
  };
}

export function parseRegistration(value: string): RegistrationStrategy {
  const strategy = normalizeRegistrationStrategy(value);
  if (!strategy) {
    throw usageError(
      "--registration must be preregistered, dcr, or cimd.",
    );
  }
  return strategy;
}

function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    // Reuse the SDK's RFC 6890 loopback check (covers all of 127.0.0.0/8) so the
    // CLI carve-out and the SDK fetch-time guard never disagree on what counts.
    return protocol === "http:" && isLoopbackHost(hostname);
  } catch {
    return false;
  }
}

/**
 * Confidential CIMD: load/generate the client key, compute the hosted reflector
 * URL that publishes its public key, and set it as the client_id metadata URL.
 * The default reflector origin is HTTPS (app.mcpjam.com); a loopback origin is a
 * gated, warned dev-only opt-in for a locally-run reflector.
 */
export function resolveConfidentialCimd(
  config: XaaCliFlowConfig,
  quiet?: boolean,
): void {
  if (config.clientAuth !== "private_key_jwt") return;
  const origin = config.cimdMetadataOrigin ?? XAA_CONFIDENTIAL_CIMD_ORIGIN;
  const loopback = isLoopbackHttpOrigin(origin);

  // Validate the origin/policy conflict BEFORE touching key material, so an
  // invocation destined to fail never generates or persists a client key.
  if (loopback && config.httpsOnly) {
    throw usageError(
      "--cimd-metadata-origin is an http loopback URL, but --https-only is set. Use an HTTPS origin, or drop --https-only for local dev.",
    );
  }

  initXaaClientKeyPair();
  config.clientIdMetadataUrl = buildConfidentialCimdUrl(
    getXaaClientJwks().keys[0],
    origin,
  );
  if (loopback) {
    config.allowLoopbackClientMetadata = true;
    if (!quiet) {
      process.stderr.write(
        `Note: using a loopback CIMD reflector (${origin}) — dev-only and non-standard (CIMD requires HTTPS); production uses ${XAA_CONFIDENTIAL_CIMD_ORIGIN}.\n`,
      );
    }
  }
}

export function parseClientAuth(value: string): XaaClientAuth {
  if (value === "none") return "none";
  if (value === "private-key-jwt" || value === "private_key_jwt")
    return "private_key_jwt";
  throw usageError("--client-auth must be none or private-key-jwt.");
}

function parseTokenEndpointAuthMethod(
  value: string,
): XaaTokenEndpointAuthMethod {
  if (
    value === "client_secret_basic" ||
    value === "client_secret_post" ||
    value === "none"
  ) {
    return value;
  }
  throw usageError(
    "--token-endpoint-auth-method must be client_secret_basic, client_secret_post, or none.",
  );
}

export function parseAssertionFormat(value: string): IdentityAssertionFormat {
  const normalized = normalizeIdentityAssertionFormat(value);
  if (normalized) {
    return normalized;
  }
  throw usageError(
    `--assertion-format must be ${IDENTITY_ASSERTION_FORMATS.join(" or ")}.`,
  );
}

function assertValidUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}
