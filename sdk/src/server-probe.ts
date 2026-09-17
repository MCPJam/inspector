import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { buildResourceMetadataUrl } from "./oauth/state-machines/shared/urls.js";
import {
  hasBearerChallenge,
  parseBearerAuthenticateParameters,
} from "./oauth/state-machines/shared/challenges.js";
import {
  assertOutboundOAuthUrlAllowed,
  isLoopbackOAuthUrl,
} from "./oauth/ssrf-guard.js";
import { resolveRegistrationStrategies } from "./oauth/authorization-plan.js";
import {
  type RetryPolicy,
  isRetryableTransientError,
  retryWithPolicy,
} from "./retry.js";
import type { OAuthProtocolVersion } from "./oauth/state-machines/types.js";

export interface ProbeMcpServerConfig {
  url: string;
  protocolVersion?: OAuthProtocolVersion;
  headers?: Record<string, string>;
  accessToken?: string;
  clientCapabilities?: Record<string, unknown>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
  retryPolicy?: RetryPolicy;
  /**
   * Permit private destinations (loopback, RFC 1918, CGNAT, unique-local) for
   * the metadata pointers this probe follows. The LOCAL inspector and CLI set
   * it; hosted callers leave it unset. Link-local and cloud-metadata
   * destinations stay refused either way.
   */
  allowPrivateNetwork?: boolean;
}

export interface ProbeHttpAttempt {
  name:
    | "streamable_initialize"
    | "sse_probe"
    | "resource_metadata"
    | "authorization_server_metadata";
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: unknown;
    contentType?: string;
  };
  error?: string;
  durationMs: number;
}

export interface ProbeOAuthDetails {
  required: boolean;
  optional: boolean;
  wwwAuthenticate?: string;
  resourceMetadataUrl?: string;
  resourceMetadata?: Record<string, unknown>;
  authorizationServerMetadataUrl?: string;
  authorizationServerMetadata?: Record<string, unknown>;
  registrationStrategies: Array<"preregistered" | "dcr" | "cimd">;
  discoveryError?: string;
  /**
   * The status the challenge arrived on, when MCP does not allow it there.
   * Absent for a compliant 401 — set means the probe accepted a challenge the
   * spec says should not have been delivered this way, so callers reporting
   * conformance can say so rather than presenting the server as clean.
   */
  nonCompliantChallengeStatus?: number;
}

export interface ProbeInitializeInfo {
  protocolVersion?: string;
  serverInfo?: unknown;
  capabilities?: unknown;
  contentType?: string;
}

export interface ProbeTransportResult {
  selected?: "streamable-http" | "sse";
  attempts: ProbeHttpAttempt[];
}

export interface ProbeMcpServerResult {
  url: string;
  protocolVersion: OAuthProtocolVersion;
  status: "ready" | "oauth_required" | "reachable" | "error";
  transport: ProbeTransportResult;
  initialize?: ProbeInitializeInfo;
  oauth: ProbeOAuthDetails;
  error?: string;
}

type ParsedHttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: unknown;
  contentType?: string;
};

function normalizeProtocolVersion(
  value: OAuthProtocolVersion | undefined
): OAuthProtocolVersion {
  return value ?? "2025-11-25";
}

function normalizeHeaders(
  headers: Headers | HeadersInit | undefined
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function lowerCaseHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function removeAuthorizationHeader(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => key.toLowerCase() !== "authorization"
    )
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    // An unparseable URL is not demonstrably the configured origin, and this
    // gate only ever widens what is sent — so failing closed is the only safe
    // reading of "cannot tell".
    return false;
  }
}

/**
 * The stored headers a metadata request to `metadataUrl` may carry.
 *
 * OAuth discovery dials hosts the TARGET names, in its own `WWW-Authenticate`
 * challenge and in the metadata documents that follow — not hosts the user
 * configured. The stored headers were configured against the user's own server:
 * an `X-Api-Key` holding their vendor key, a session header, whatever they
 * saved. Replaying those at an address the target chose hands them to it. A
 * server can therefore harvest its caller's credentials by answering 401 with
 * `resource_metadata="https://collect.attacker.test/prm"` (#5000). The egress
 * guard permits that host because it is publicly routable, which is a different
 * question from whether it should be trusted with a secret.
 *
 * So: same origin as the configured server, and the headers are being sent
 * where the user pointed them — today's behaviour, unchanged. Any other origin
 * and NOTHING stored goes along. Not a denylist of credential-shaped names: the
 * user never expressed any intent about this host, so there is no header whose
 * presence it has earned, and a list is one more thing to keep current. The
 * metadata endpoints are unauthenticated by spec (RFC 9728 / RFC 8414), so
 * nothing legitimate needs them.
 *
 * This is the same duty `hosted-egress-guard` takes on when it follows a
 * redirect by hand and strips credentials across origins. The gap was that the
 * FIRST dial to a challenge-named host never went through any such check.
 */
function storedHeadersForMetadataHost(
  storedHeaders: Record<string, string>,
  metadataUrl: string,
  configuredUrl: string
): Record<string, string> {
  return sameOrigin(metadataUrl, configuredUrl) ? storedHeaders : {};
}

function initializeProtocolVersion(
  protocolVersion: OAuthProtocolVersion
): string {
  switch (protocolVersion) {
    case "2025-03-26":
    case "2025-06-18":
      return "2024-11-05";
    case "2025-11-25":
      return "2025-11-25";
    case "2026-07-28":
      return "2026-07-28";
    default: {
      const exhaustive: never = protocolVersion;
      return exhaustive;
    }
  }
}

function buildAuthServerMetadataUrls(
  protocolVersion: OAuthProtocolVersion,
  authServerUrl: string
): string[] {
  const url = new URL(authServerUrl);
  const urls: string[] = [];

  // 2025-11-25 and 2026-07-28 share the same AS-metadata discovery: OAuth
  // path-insertion, then OIDC path-insertion / path-appending, with NO root
  // fallback for path-containing issuers (the older branch below keeps it).
  if (protocolVersion === "2025-11-25" || protocolVersion === "2026-07-28") {
    if (url.pathname === "/" || url.pathname === "") {
      urls.push(
        new URL(
          "/.well-known/oauth-authorization-server",
          url.origin
        ).toString()
      );
      urls.push(
        new URL("/.well-known/openid-configuration", url.origin).toString()
      );
      return urls;
    }

    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    urls.push(
      new URL(
        `/.well-known/oauth-authorization-server${pathname}`,
        url.origin
      ).toString()
    );
    urls.push(
      new URL(
        `/.well-known/openid-configuration${pathname}`,
        url.origin
      ).toString()
    );
    urls.push(
      new URL(
        `${pathname}/.well-known/openid-configuration`,
        url.origin
      ).toString()
    );
    return urls;
  }

  if (url.pathname === "/" || url.pathname === "") {
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString()
    );
    return urls;
  }

  const pathname = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  urls.push(
    new URL(
      `/.well-known/oauth-authorization-server${pathname}`,
      url.origin
    ).toString()
  );
  urls.push(
    new URL("/.well-known/oauth-authorization-server", url.origin).toString()
  );
  return urls;
}

/**
 * Refuse a metadata destination the probed server chose for us. Both the RFC
 * 9728 `resource_metadata` pointer and the authorization server it advertises
 * come from upstream, so without this a hostile challenge steers the probe —
 * which runs in MCPJam's hosted backend, reachable on a guest-allowed doctor
 * route — at cloud metadata or a service on the private network.
 *
 * Same origin as the configured server URL is always allowed: that is the
 * origin the caller already asked the probe to contact, so a loopback or LAN
 * MCP server keeps discovering its own metadata. Everything else goes through
 * the shared guard, with the loopback opt-in derived from the server URL so
 * local dev can host its authorization server on another loopback port while a
 * public server can never reach the user's.
 */
function assertMetadataDestinationAllowed(
  candidate: string,
  serverUrl: string,
  allowPrivateNetwork = false
): void {
  try {
    const target = new URL(candidate);
    const server = new URL(serverUrl);
    // Compare scheme and host rather than `origin`. Every non-special scheme
    // reports the origin `"null"`, and `blob:https://host/…` reports the origin
    // of the URL it wraps with no host of its own — so an `origin` comparison
    // lets a `blob:` pointer at the configured server's origin skip the guard
    // entirely. Restricting the shortcut to the schemes the probe can actually
    // dial keeps it to what it is for: the origin the caller already named.
    if (
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.protocol === server.protocol &&
      target.host === server.host
    ) {
      return;
    }
  } catch {
    // Unparseable: leave the rejection to the guard, which reports it uniformly.
  }

  assertOutboundOAuthUrlAllowed(candidate, {
    allowLoopback: isLoopbackOAuthUrl(serverUrl),
    allowPrivateNetwork,
  });
}

function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

async function readResponseBody(
  response: Response
): Promise<{ body?: unknown; contentType?: string }> {
  const contentType = response.headers.get("content-type") ?? undefined;
  if (contentType?.includes("text/event-stream")) {
    return { contentType };
  }

  const text = await response.text();
  if (!text) {
    return { body: undefined, contentType };
  }

  if (
    contentType?.includes("application/json") ||
    contentType?.includes("+json")
  ) {
    return {
      body: parseJsonBody(text),
      contentType,
    };
  }

  return {
    body: parseJsonBody(text),
    contentType,
  };
}

function withTimeoutSignal(timeoutMs: number | undefined): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  if (!timeoutMs) {
    return {
      signal: undefined,
      cleanup: () => undefined,
      didTimeout: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const handle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(handle),
    didTimeout: () => timedOut,
  };
}

function createTimeoutError(
  timeoutMs: number | undefined
): Error & { code: string } {
  const error = new Error(
    timeoutMs ? `Request timed out after ${timeoutMs}ms` : "Request timed out"
  ) as Error & { code: string };
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

/**
 * MCP requires 401 + `WWW-Authenticate` to signal that OAuth is needed, but a
 * server fronted by a CDN or WAF — and one treating anonymous access as a scope
 * failure (RFC 6750 §3.1 pairs 403 with `insufficient_scope`) — answers 403
 * instead. A 403 that still carries a Bearer challenge names everything
 * discovery needs, so the probe reads it as "OAuth required" rather than
 * reporting the server as broken. A bare 403 carries nothing to discover from
 * and stays an error.
 */
function isOAuthChallenge(response: ParsedHttpResponse): boolean {
  return (
    response.status === 401 ||
    (response.status === 403 &&
      hasBearerChallenge(response.headers["www-authenticate"]))
  );
}

/** Record a challenge status MCP does not allow, so acceptance is never silent. */
function withChallengeStatus(
  oauth: ProbeOAuthDetails,
  status: number
): ProbeOAuthDetails {
  return status === 401
    ? oauth
    : { ...oauth, nonCompliantChallengeStatus: status };
}

function isRetryableProbeStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status !== 501)
  );
}

/**
 * The most hops a metadata request is followed by hand. Discovery documents
 * are one redirect deep in practice (`/prm` to `/prm/`); this is a loop bound,
 * not a policy.
 */
const MAX_METADATA_REDIRECTS = 5;

/**
 * Re-decide the stored headers for each destination a redirect names.
 *
 * `fetch` with `redirect: "follow"` strips `Authorization`, `Cookie` and
 * `Proxy-Authorization` across origins — and nothing else. Measured against
 * two local origins on Node 24: `x-api-key` and `x-session-id` arrive at the
 * redirect target intact. So a metadata URL on the server's own origin, which
 * legitimately carries the user's stored headers, can hand them to any host it
 * redirects to — and the destination guard only sees `response.url`, after the
 * request has already been made (CodeRabbit on #5000).
 *
 * Supplying this makes `performRequest` follow redirects itself: validate each
 * destination first, then ask for that destination's headers. A hop that
 * leaves the configured origin gets none of them, by the same rule the initial
 * request uses.
 */
type MetadataRedirectPolicy = (url: string) => Record<string, string>;

// The statuses `fetch` itself follows. 3xx is wider than that: a `304 Not
// Modified` carrying a stale `Location` is not a redirect, and following it
// would put a request on the wire that the automatic path never makes
// (CodeRabbit).
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function redirectTargetOf(
  response: Response,
  currentUrl: string
): string | null {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

async function performRequest(
  fetchFn: typeof fetch,
  attempt: ProbeHttpAttempt,
  timeoutMs: number | undefined,
  validateLandingUrl?: (url: string) => void,
  headersForRedirect?: MetadataRedirectPolicy
): Promise<ParsedHttpResponse> {
  const startedAt = Date.now();
  const { signal, cleanup, didTimeout } = withTimeoutSignal(timeoutMs);

  try {
    let response = await fetchFn(attempt.request.url, {
      method: attempt.request.method,
      headers: attempt.request.headers,
      body:
        attempt.request.body === undefined
          ? undefined
          : JSON.stringify(attempt.request.body),
      redirect: headersForRedirect ? "manual" : "follow",
      signal,
    });

    if (headersForRedirect) {
      let currentUrl = attempt.request.url;
      for (let hop = 0; hop < MAX_METADATA_REDIRECTS; hop++) {
        const nextUrl = redirectTargetOf(response, currentUrl);
        if (nextUrl === null) break;
        // Same order as the initial request: the destination is refused before
        // it is dialled, and only then does it get told which headers it has
        // earned.
        if (validateLandingUrl) validateLandingUrl(nextUrl);
        response = await fetchFn(nextUrl, {
          method: "GET",
          headers: headersForRedirect(nextUrl),
          redirect: "manual",
          signal,
        });
        currentUrl = nextUrl;
      }
    }

    // Where the response landed, checked before anything is read from it.
    // Refusing to *use* a body fetched from a blocked host is not enough: this
    // attempt is already in the array returned as `transport.attempts`, so
    // recording the response would hand the caller the internal document the
    // guard just rejected. Best-effort — a `fetchFn` that reports no URL leaves
    // nothing to check, which is why the hosted path guards the dial itself.
    if (validateLandingUrl && response.url) {
      validateLandingUrl(response.url);
    }

    const parsedBody = await readResponseBody(response);
    const normalizedHeaders = normalizeHeaders(response.headers);
    attempt.durationMs = Date.now() - startedAt;
    attempt.response = {
      status: response.status,
      statusText: response.statusText,
      headers: normalizedHeaders,
      body: parsedBody.body,
      contentType: parsedBody.contentType,
    };

    return {
      status: response.status,
      statusText: response.statusText,
      headers: lowerCaseHeaders(normalizedHeaders),
      body: parsedBody.body,
      contentType: parsedBody.contentType,
    };
  } catch (error) {
    const requestError = didTimeout() ? createTimeoutError(timeoutMs) : error;
    attempt.durationMs = Date.now() - startedAt;
    attempt.error =
      requestError instanceof Error
        ? requestError.message
        : String(requestError);
    throw requestError;
  } finally {
    cleanup();
  }
}

function extractInitializeInfo(
  body: unknown,
  contentType: string | undefined
): ProbeInitializeInfo | undefined {
  if (
    body &&
    typeof body === "object" &&
    "result" in body &&
    (body as { result?: { protocolVersion?: unknown } }).result?.protocolVersion
  ) {
    const result = (
      body as {
        result: {
          protocolVersion?: string;
          serverInfo?: unknown;
          capabilities?: unknown;
        };
      }
    ).result;

    return {
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
      contentType,
    };
  }

  if (contentType?.includes("text/event-stream")) {
    return {
      contentType,
    };
  }

  return undefined;
}

function buildInitializeRequest(
  config: ProbeMcpServerConfig
): ProbeHttpAttempt {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const accessToken = config.accessToken?.trim();
  const headers: Record<string, string> = {
    ...normalizeHeaders(config.headers),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return {
    name: "streamable_initialize",
    request: {
      method: "POST",
      url: config.url,
      headers,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: initializeProtocolVersion(protocolVersion),
          capabilities: config.clientCapabilities ?? {},
          clientInfo: {
            name: config.clientName ?? "mcpjam-probe",
            version: config.clientVersion ?? "1.0.0",
          },
        },
      },
    },
    durationMs: 0,
  };
}

function buildSseProbeRequest(config: ProbeMcpServerConfig): ProbeHttpAttempt {
  const accessToken = config.accessToken?.trim();
  const headers: Record<string, string> = {
    ...normalizeHeaders(config.headers),
    Accept: "text/event-stream",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return {
    name: "sse_probe",
    request: {
      method: "GET",
      url: config.url,
      headers,
    },
    durationMs: 0,
  };
}

async function discoverOAuthDetails(
  config: ProbeMcpServerConfig,
  attempts: ProbeHttpAttempt[],
  optional: boolean,
  wwwAuthenticateHeader: string | undefined
): Promise<ProbeOAuthDetails> {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const metadataHeaders = removeAuthorizationHeader(
    normalizeHeaders(config.headers)
  );
  // Read the pointer off the Bearer challenge rather than the raw header. A
  // bare `resource_metadata="…"` match takes the value wherever it sits —
  // including inside another scheme's challenge, or inside a quoted realm that
  // only looks like one — which points discovery at a PRM URL the server never
  // advertised for Bearer.
  const resourceMetadataUrlFromHeader =
    parseBearerAuthenticateParameters(wwwAuthenticateHeader)
      .resource_metadata || undefined;
  const resourceMetadataUrl =
    resourceMetadataUrlFromHeader ?? buildResourceMetadataUrl(config.url);

  const resourceMetadataAttempt: ProbeHttpAttempt = {
    name: "resource_metadata",
    request: {
      method: "GET",
      url: resourceMetadataUrl,
      headers: storedHeadersForMetadataHost(
        metadataHeaders,
        resourceMetadataUrl,
        config.url
      ),
    },
    durationMs: 0,
  };

  try {
    // Guard before recording the attempt: a refused pointer produces no request,
    // so an attempt entry with no response would misreport what happened.
    if (resourceMetadataUrlFromHeader) {
      assertMetadataDestinationAllowed(
        resourceMetadataUrlFromHeader,
        config.url,
        config.allowPrivateNetwork
      );
    }
    attempts.push(resourceMetadataAttempt);

    const loggingFetch: typeof fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      // Per destination, not once for the discovery: `discoverOAuth…Metadata`
      // follows the documents it reads, so one call can dial several hosts and
      // only some of them may be the server's own.
      const mergedHeaders = {
        ...storedHeadersForMetadataHost(metadataHeaders, url, config.url),
        ...normalizeHeaders(init.headers),
      };
      const attempt =
        resourceMetadataAttempt.request.url === url
          ? resourceMetadataAttempt
          : {
              name: "resource_metadata" as const,
              request: {
                method: init.method ?? "GET",
                url,
                headers: mergedHeaders,
              },
              durationMs: 0,
            };
      if (attempt !== resourceMetadataAttempt) {
        attempts.push(attempt);
      } else {
        resourceMetadataAttempt.request.headers = mergedHeaders;
        resourceMetadataAttempt.request.method = init.method ?? "GET";
      }

      const response = await performRequest(
        config.fetchFn ?? fetch,
        attempt,
        config.timeoutMs,
        (landingUrl) =>
          assertMetadataDestinationAllowed(
            landingUrl,
            config.url,
            config.allowPrivateNetwork
          ),
        // Redirects are followed by hand so each destination is asked the same
        // question the initial URL was: does the user's stored header belong
        // there? `fetch`'s own following strips only Authorization/Cookie
        // across origins, so an `X-Api-Key` would ride along otherwise.
        (redirectUrl) => ({
          ...storedHeadersForMetadataHost(
            metadataHeaders,
            redirectUrl,
            config.url
          ),
          ...normalizeHeaders(init.headers),
        })
      );

      return new Response(
        response.body === undefined ? null : JSON.stringify(response.body),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }
      );
    };

    const metadata = await discoverOAuthProtectedResourceMetadata(
      config.url,
      resourceMetadataUrlFromHeader
        ? { resourceMetadataUrl: resourceMetadataUrlFromHeader }
        : undefined,
      loggingFetch
    );

    const advertisedAuthServer = metadata.authorization_servers?.[0];
    const authorizationServerUrl = advertisedAuthServer ?? config.url;
    let authorizationServerMetadata: Record<string, unknown> | undefined;
    let authorizationServerMetadataUrl: string | undefined;
    let lastAuthError: string | undefined;
    let authMetadataUrls: string[] = [];

    try {
      // Second hop, same problem: the PRM document that named this origin came
      // from a pointer the server chose. Guard the origin once rather than each
      // candidate — they share it by construction — and only when the document
      // advertised one, so the `?? config.url` fallback never blocks a LAN or
      // loopback server discovering its own metadata. This also keeps a
      // malformed entry from aborting discovery inside `new URL()` below.
      if (advertisedAuthServer) {
        assertMetadataDestinationAllowed(
          advertisedAuthServer,
          config.url,
          config.allowPrivateNetwork
        );
      }
      authMetadataUrls = buildAuthServerMetadataUrls(
        protocolVersion,
        authorizationServerUrl
      );
    } catch (error) {
      lastAuthError = error instanceof Error ? error.message : String(error);
    }

    for (const authMetadataUrl of authMetadataUrls) {
      const authAttempt: ProbeHttpAttempt = {
        name: "authorization_server_metadata",
        request: {
          method: "GET",
          url: authMetadataUrl,
          headers: storedHeadersForMetadataHost(
            metadataHeaders,
            authMetadataUrl,
            config.url
          ),
        },
        durationMs: 0,
      };
      attempts.push(authAttempt);

      try {
        const response = await performRequest(
          config.fetchFn ?? fetch,
          authAttempt,
          config.timeoutMs,
          (landingUrl) =>
            assertMetadataDestinationAllowed(
              landingUrl,
              config.url,
              config.allowPrivateNetwork
            ),
          (redirectUrl) =>
            storedHeadersForMetadataHost(
              metadataHeaders,
              redirectUrl,
              config.url
            )
        );

        if (
          response.status >= 200 &&
          response.status < 300 &&
          response.body &&
          typeof response.body === "object"
        ) {
          authorizationServerMetadata = response.body as Record<
            string,
            unknown
          >;
          authorizationServerMetadataUrl = authMetadataUrl;
          lastAuthError = undefined;
          break;
        }

        lastAuthError = `HTTP ${response.status} ${response.statusText}`;
      } catch (error) {
        lastAuthError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      required: !optional,
      optional,
      wwwAuthenticate: wwwAuthenticateHeader,
      resourceMetadataUrl,
      resourceMetadata: metadata as Record<string, unknown>,
      authorizationServerMetadataUrl,
      authorizationServerMetadata,
      registrationStrategies: resolveRegistrationStrategies(
        protocolVersion,
        authorizationServerMetadata
      ),
      ...(lastAuthError ? { discoveryError: lastAuthError } : {}),
    };
  } catch (error) {
    if (optional) {
      return {
        required: false,
        optional: false,
        resourceMetadataUrl,
        registrationStrategies: [],
      };
    }

    return {
      required: true,
      optional: false,
      wwwAuthenticate: wwwAuthenticateHeader,
      resourceMetadataUrl,
      registrationStrategies: ["preregistered"],
      discoveryError: error instanceof Error ? error.message : String(error),
    };
  }
}

function baseOAuthResult(): ProbeOAuthDetails {
  return {
    required: false,
    optional: false,
    registrationStrategies: [],
  };
}

type ProbeMcpServerAttemptResult = {
  result: ProbeMcpServerResult;
  retryable: boolean;
};

function createProbeErrorResult(
  config: ProbeMcpServerConfig,
  protocolVersion: OAuthProtocolVersion,
  attempts: ProbeHttpAttempt[],
  error: string,
  retryable: boolean
): ProbeMcpServerAttemptResult {
  return {
    result: {
      url: config.url,
      protocolVersion,
      status: "error",
      transport: {
        attempts,
      },
      oauth: baseOAuthResult(),
      error,
    },
    retryable,
  };
}

async function probeMcpServerOnce(
  config: ProbeMcpServerConfig,
  attempts: ProbeHttpAttempt[]
): Promise<ProbeMcpServerAttemptResult> {
  const protocolVersion = normalizeProtocolVersion(config.protocolVersion);
  const initializeAttempt = buildInitializeRequest(config);
  attempts.push(initializeAttempt);

  try {
    const initializeResponse = await performRequest(
      config.fetchFn ?? fetch,
      initializeAttempt,
      config.timeoutMs
    );
    const initializeInfo = extractInitializeInfo(
      initializeResponse.body,
      initializeResponse.contentType
    );
    const wwwAuthenticate = initializeResponse.headers["www-authenticate"];

    if (isOAuthChallenge(initializeResponse)) {
      return {
        result: {
          url: config.url,
          protocolVersion,
          status: "oauth_required",
          transport: {
            attempts,
          },
          oauth: withChallengeStatus(
            await discoverOAuthDetails(
              config,
              attempts,
              false,
              wwwAuthenticate
            ),
            initializeResponse.status
          ),
        },
        retryable: false,
      };
    }

    if (initializeResponse.status >= 200 && initializeResponse.status < 300) {
      const oauth = config.accessToken
        ? baseOAuthResult()
        : await discoverOAuthDetails(config, attempts, true, undefined).catch(
            () => baseOAuthResult()
          );
      if (initializeInfo) {
        return {
          result: {
            url: config.url,
            protocolVersion,
            status: "ready",
            transport: {
              selected: "streamable-http",
              attempts,
            },
            initialize: initializeInfo,
            oauth,
          },
          retryable: false,
        };
      }

      return {
        result: {
          url: config.url,
          protocolVersion,
          status: "reachable",
          transport: {
            attempts,
          },
          oauth,
          error:
            "Server responded to initialize but did not return a recognizable MCP initialize result.",
        },
        retryable: false,
      };
    }

    const shouldTrySse =
      initializeResponse.status === 404 ||
      initializeResponse.status === 405 ||
      initializeResponse.status === 406 ||
      initializeResponse.status === 415 ||
      initializeResponse.status === 501;

    if (!shouldTrySse && isRetryableProbeStatus(initializeResponse.status)) {
      return createProbeErrorResult(
        config,
        protocolVersion,
        attempts,
        `Server responded with HTTP ${initializeResponse.status} ${initializeResponse.statusText} to the initialize probe.`,
        true
      );
    }

    if (shouldTrySse) {
      const sseAttempt = buildSseProbeRequest(config);
      attempts.push(sseAttempt);
      const sseResponse = await performRequest(
        config.fetchFn ?? fetch,
        sseAttempt,
        config.timeoutMs
      );
      const wwwAuthenticateSse = sseResponse.headers["www-authenticate"];

      if (isOAuthChallenge(sseResponse)) {
        return {
          result: {
            url: config.url,
            protocolVersion,
            status: "oauth_required",
            transport: {
              attempts,
            },
            oauth: withChallengeStatus(
              await discoverOAuthDetails(
                config,
                attempts,
                false,
                wwwAuthenticateSse
              ),
              sseResponse.status
            ),
          },
          retryable: false,
        };
      }

      if (
        sseResponse.status >= 200 &&
        sseResponse.status < 300 &&
        sseResponse.contentType?.includes("text/event-stream")
      ) {
        const oauth = config.accessToken
          ? baseOAuthResult()
          : await discoverOAuthDetails(config, attempts, true, undefined).catch(
              () => baseOAuthResult()
            );
        return {
          result: {
            url: config.url,
            protocolVersion,
            status: "ready",
            transport: {
              selected: "sse",
              attempts,
            },
            initialize: {
              contentType: sseResponse.contentType,
            },
            oauth,
          },
          retryable: false,
        };
      }

      if (isRetryableProbeStatus(sseResponse.status)) {
        return createProbeErrorResult(
          config,
          protocolVersion,
          attempts,
          `Server responded with HTTP ${sseResponse.status} ${sseResponse.statusText} to the SSE probe.`,
          true
        );
      }
    }

    return {
      result: {
        url: config.url,
        protocolVersion,
        status: "reachable",
        transport: {
          attempts,
        },
        oauth: baseOAuthResult(),
        error: `Server responded with HTTP ${initializeResponse.status} ${initializeResponse.statusText} to the initialize probe.`,
      },
      retryable: false,
    };
  } catch (error) {
    return createProbeErrorResult(
      config,
      protocolVersion,
      attempts,
      error instanceof Error ? error.message : String(error),
      isRetryableTransientError(error)
    );
  }
}

export async function probeMcpServer(
  config: ProbeMcpServerConfig
): Promise<ProbeMcpServerResult> {
  const attempts: ProbeHttpAttempt[] = [];
  const outcome = await retryWithPolicy({
    policy: config.retryPolicy,
    operation: () => probeMcpServerOnce(config, attempts),
    shouldRetryResult: (result) => result.retryable,
  });
  return outcome.result;
}
