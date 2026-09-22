/**
 * One typed builder for every OAuth initiation.
 *
 * Four production paths used to hand-roll their own options bag for
 * `initiateOAuth`, and they did not agree. The hosted gate omitted
 * `allowPathScopedIssuer`, `clientSecret`, `hasClientSecret`, `customHeaders`,
 * `resourceUrl`, and `registrationMode`; the initial-connect path omitted
 * `resourceUrl`. The result was "same server, different wire behavior depending
 * on which button you pressed" — the single most expensive property an OAuth
 * implementation can have, because the failure only reproduces on one entry
 * point and nobody knows which.
 *
 * Everything security-sensitive is assembled here, once. Callers supply where
 * their values came from; the builder decides what reaches the wire.
 *
 * `initiateOAuth` accepts only a `BuiltOAuthRequest`, which nothing but this
 * module can produce. A hand-rolled object literal no longer typechecks, so a
 * fifth divergent bag cannot be added by accident.
 */

import {
  canonicalizeResourceUrl,
  evaluateResourceIndicator,
} from "@mcpjam/sdk/browser";
import type {
  OAuthProtocolMode,
  OAuthProtocolVersion,
  OAuthRegistrationMode,
} from "@mcpjam/sdk/browser";

import type { MCPOAuthOptions } from "./mcp-oauth";
import type { OAuthTrace } from "./oauth-trace";

/**
 * Why this authorization is being started.
 *
 * The four connect-like intents must produce identical wire behavior for the
 * same stored server — that is the point of the type. `debug` and `emulation`
 * exist so a deliberately nonconforming request has to say so: the OAuth
 * debugger and client-emulation surfaces may exercise values a connect must
 * refuse, and those deviations are observations, not conformance.
 */
export type OAuthRequestIntent =
  | "connect"
  | "reconnect"
  | "hosted-connect"
  | "step-up"
  | "debug"
  | "emulation";

const CONNECT_LIKE_INTENTS: ReadonlySet<OAuthRequestIntent> = new Set([
  "connect",
  "reconnect",
  "hosted-connect",
  "step-up",
]);

export function isConnectLikeIntent(intent: OAuthRequestIntent): boolean {
  return CONNECT_LIKE_INTENTS.has(intent);
}

declare const oauthRequestBrand: unique symbol;

/**
 * An options bag that came from `buildOAuthRequest`.
 *
 * The brand is a phantom field — it costs nothing at runtime and cannot be
 * written by hand, which is exactly the property needed: it is not trying to
 * protect the VALUES (they are plain and readable), it is protecting the
 * invariant that they were assembled in one place.
 */
export type BuiltOAuthRequest = MCPOAuthOptions & {
  readonly [oauthRequestBrand]: OAuthRequestIntent;
  readonly intent: OAuthRequestIntent;
};

/**
 * The per-server facts a caller resolves from its own source — connect form,
 * stored server record, hosted project record — before the builder turns them
 * into a request.
 *
 * Every field is shared by all intents. Anything genuinely intent-specific
 * lives in {@link BuildOAuthRequestOptions} instead, so "which fields differ by
 * entry point" has exactly one answer and it is visible in the type.
 */
export interface OAuthRequestSource {
  serverName: string;
  serverUrl: string;
  scopes?: string[];
  /**
   * A user- or profile-configured RFC 8707 resource indicator. Validated
   * against `serverUrl` for connect-like intents before anything is sent.
   */
  resourceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  hasClientSecret?: boolean;
  customHeaders?: Record<string, string>;
  registryServerId?: string;
  useRegistryOAuthProxy?: boolean;
  /**
   * Per-server opt-in for a path-scoped authorization server (multi-tenant AS
   * deployments that scope endpoints under a path while issuing from the origin
   * root). Never a default: off keeps the strict RFC 8414 §3.3 issuer match,
   * and the toggle exists per server precisely so it cannot become global.
   */
  allowPathScopedIssuer?: boolean;
  protocolMode?: OAuthProtocolMode;
  protocolVersion?: OAuthProtocolVersion;
  protocolResolutionSource?: MCPOAuthOptions["protocolResolutionSource"];
  registrationMode?: OAuthRegistrationMode;
  registrationStrategy?: MCPOAuthOptions["registrationStrategy"];
  onTraceUpdate?: (trace: OAuthTrace) => void;
}

export interface BuildOAuthRequestOptions {
  intent: OAuthRequestIntent;
  /**
   * SEP-2350 step-up: the union of previously-requested and challenged scopes.
   * Wins over `source.scopes` — otherwise the fresh flow re-requests the scopes
   * the `403 insufficient_scope` challenge just rejected, and loops.
   */
  stepUpScopes?: string[];
  /**
   * SEP-2350 step-up: a `resource_metadata` URL from an `insufficient_scope`
   * challenge, ALREADY validated same-origin by the caller. Threaded so PRM
   * discovery honors a non-default metadata location on re-authorization.
   */
  resourceMetadataUrl?: string;
}

/**
 * Pick a stored resource indicator only if it still belongs to this server URL.
 *
 * A stored `resourceUrl` is a fact about the endpoint it was captured for. Edit
 * a server's URL and it becomes stale in two different ways, both bad:
 *
 *   - New origin: the stale value fails validation and blocks a connection the
 *     user just asked for, reporting a "misconfigured resource" they never
 *     configured.
 *   - Same origin, new path: the stale value passes validation and is then used
 *     as the audience, so the token is minted for the wrong endpoint. Quiet,
 *     and worse.
 *
 * A candidate is only honored when the record it came from names the URL being
 * connected. A user-configured value for the CURRENT url is still validated and
 * still rejected if it names a foreign resource — that is a real
 * misconfiguration, not staleness.
 */
export function selectStoredResourceUrl(
  serverUrl: string,
  candidates: Array<{ resourceUrl?: string; capturedForServerUrl?: string }>,
): string | undefined {
  for (const candidate of candidates) {
    const resourceUrl = nonEmpty(candidate.resourceUrl);
    if (!resourceUrl) continue;
    if (!sameServerUrl(candidate.capturedForServerUrl, serverUrl)) continue;
    return resourceUrl;
  }
  return undefined;
}

function sameServerUrl(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const a = nonEmpty(left);
  const b = nonEmpty(right);
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    // Tolerate the cosmetic differences a stored URL picks up (trailing slash,
    // default port, case in the host) without tolerating a different endpoint.
    return canonicalizeResourceUrl(a) === canonicalizeResourceUrl(b);
  } catch {
    return false;
  }
}

export class OAuthRequestRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthRequestRejectedError";
  }
}

function nonEmpty(value: string | undefined | null): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Reject a configured resource indicator that does not identify the configured
 * MCP server, BEFORE the browser is redirected.
 *
 * The flow validates this later too, but later is after the user has left the
 * page. More importantly, doing it here means every connect-like entry point
 * shares one answer: a foreign audience cannot be opted into by picking a
 * different button.
 */
function validateConfiguredResource(
  source: OAuthRequestSource,
  intent: OAuthRequestIntent,
): string | undefined {
  const configured = nonEmpty(source.resourceUrl);
  if (!configured || !isConnectLikeIntent(intent)) {
    return configured;
  }

  const decision = evaluateResourceIndicator({
    serverUrl: source.serverUrl,
    configuredResource: configured,
  });

  if (decision.status !== "valid") {
    throw new OAuthRequestRejectedError(
      `Rejected the configured OAuth resource indicator "${configured}" for ` +
        `${source.serverName}: ${
          decision.reason ?? "it does not identify the configured MCP server"
        }`,
    );
  }

  return configured;
}

/**
 * Assemble the one request every entry point sends.
 *
 * Throws {@link OAuthRequestRejectedError} when a connect-like intent carries a
 * resource indicator that is not the configured MCP server's.
 */
export function buildOAuthRequest(
  source: OAuthRequestSource,
  options: BuildOAuthRequestOptions,
): BuiltOAuthRequest {
  const { intent } = options;
  const resourceUrl = validateConfiguredResource(source, intent);

  const scopes =
    options.stepUpScopes && options.stepUpScopes.length > 0
      ? options.stepUpScopes
      : source.scopes;

  const registrationMode = source.registrationMode;
  const registrationStrategy =
    registrationMode && registrationMode !== "auto"
      ? registrationMode
      : source.registrationStrategy;

  // Every key is emitted, including the ones whose value is `undefined`.
  // Conditional spreads would make "this entry point omitted the field" and
  // "this entry point has no value for it" indistinguishable at the call site —
  // which is the exact confusion this builder exists to end.
  const request: MCPOAuthOptions & { intent: OAuthRequestIntent } = {
    intent,
    serverName: source.serverName,
    serverUrl: source.serverUrl,
    scopes: scopes && scopes.length > 0 ? scopes : undefined,
    resourceUrl,
    resourceMetadataUrl: nonEmpty(options.resourceMetadataUrl),
    clientId: nonEmpty(source.clientId),
    clientSecret: nonEmpty(source.clientSecret),
    hasClientSecret: Boolean(source.hasClientSecret),
    customHeaders: source.customHeaders,
    registryServerId: source.registryServerId,
    useRegistryOAuthProxy: source.useRegistryOAuthProxy,
    // Explicit `=== true`: an undefined toggle must read as off, never as
    // "inherit whatever the last caller did".
    allowPathScopedIssuer: source.allowPathScopedIssuer === true,
    protocolMode: source.protocolMode,
    protocolVersion: source.protocolVersion,
    protocolResolutionSource: source.protocolResolutionSource,
    registrationMode,
    registrationStrategy,
    onTraceUpdate: source.onTraceUpdate,
  };

  return request as BuiltOAuthRequest;
}

/**
 * The security-sensitive fields every connect-like intent must agree on for the
 * same stored server.
 *
 * Exported because the proof of this checkpoint is a test that builds the same
 * server through all four entry points and compares exactly these — keeping the
 * list next to the builder means adding a field to one also adds it to the
 * comparison.
 */
export const SHARED_OAUTH_REQUEST_FIELDS = [
  "serverName",
  "serverUrl",
  "resourceUrl",
  "clientId",
  "hasClientSecret",
  "customHeaders",
  "registryServerId",
  "useRegistryOAuthProxy",
  "allowPathScopedIssuer",
  "protocolMode",
  "protocolVersion",
  "registrationMode",
  "registrationStrategy",
] as const;

export function pickSharedOAuthRequestFields(
  request: BuiltOAuthRequest,
): Record<string, unknown> {
  return Object.fromEntries(
    SHARED_OAUTH_REQUEST_FIELDS.map((field) => [
      field,
      (request as unknown as Record<string, unknown>)[field],
    ]),
  );
}
