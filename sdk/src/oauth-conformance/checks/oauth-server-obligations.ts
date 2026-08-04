import type { OAuthFlowState } from "../../oauth/state-machines/types.js";
import {
  buildInitializeRequestBody,
  resolveInitializeProtocolVersion,
} from "../../oauth/state-machines/shared/initialize.js";
import type {
  NormalizedOAuthConformanceConfig,
  OAuthConformanceCheckId,
  StepResult,
  TrackedRequestFn,
} from "../types.js";

// ── Server-side spec obligations (HP-17 findings 3/4/5) ────────────────
//
// These three checks encode server conformance requirements that Composio's
// cross-client feedback surfaced (validated in HP-17, 2026-07-21). Unlike the
// host-capability matrix — which records how real *clients* behave — these are
// obligations the MCP *server* owes every client, so they belong here in the
// conformance suite where a violation is a hard FAIL against normative spec
// text, not a readiness warning.
//
//   Finding 3 — resource-metadata discovery must work. RFC 9728 entered the
//     MCP spec at 2025-06-18 (this check skips on a 2025-03-26 target), where
//     the WWW-Authenticate `resource_metadata` parameter is a flat MUST. From
//     2025-11-25 the spec names TWO sanctioned mechanisms — the header, or
//     protected-resource metadata at a well-known URI — so on those revisions
//     a missing header only fails after both well-known URIs come up empty.
//     A PRESENT-but-relative resource_metadata stays a violation everywhere
//     the mechanism exists (RFC 9728 §5.1 requires an absolute URL).
//   Finding 4 — an unauthenticated request must be answered with 401 + a Bearer
//     challenge, never a 500 (RFC 6750 §3 / MCP authorization). A 2xx is not a
//     violation — the spec permits anonymous `initialize` with authorization
//     enforced on later requests — so it skips as unverifiable.
//   Finding 5 — a stale `Mcp-Session-Id` must be rejected with a 4xx, never a
//     500 (MCP Streamable HTTP transport). Per HP-17 the spec prefers 404 and
//     does NOT mandate a parseable body, so only the 5xx crash is a failure;
//     the status specificity and body shape are reported as evidence only.

type OAuthServerObligationStep = Extract<
  OAuthConformanceCheckId,
  | "oauth_unauthenticated_challenge"
  | "oauth_resource_metadata_challenge"
  | "oauth_stale_session_rejection"
>;

export interface OAuthServerObligationOutcome {
  step: OAuthServerObligationStep;
  status: StepResult["status"];
  durationMs: number;
  error?: StepResult["error"];
  warnings?: StepResult["warnings"];
}

interface OAuthServerObligationInput {
  config: NormalizedOAuthConformanceConfig;
  state: OAuthFlowState;
  trackedRequest: TrackedRequestFn;
}

// A syntactically valid (visible-ASCII) session id that the server never
// issued — the "stale session" the transport spec says must be rejected.
const STALE_SESSION_ID = "00000000-0000-0000-0000-000000000000";

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

/** Strip credential-bearing headers before a request is embedded in error
 * details. Raw StepResults reach consumers (the inspector panel, persisted
 * runs) that never pass through the report-level redaction in
 * conformance-reporting.ts, and no consumer needs the token. */
function redactRequestForDetails(request: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key] = key.toLowerCase() === "authorization" ? "[REDACTED]" : value;
  }
  return { ...request, headers };
}

function buildTransportFailure(
  step: OAuthServerObligationStep,
  startedAt: number,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: Record<string, unknown>;
  },
  error: unknown,
  messagePrefix: string,
): OAuthServerObligationOutcome {
  return {
    step,
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: {
      message: `${messagePrefix}: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        request: redactRequestForDetails(request),
        error: errorDetails(error),
      },
    },
  };
}

/** Headers are lowercased by the runner, but read case-insensitively anyway so
 * these checks stay correct against a custom fetch that does not normalize. */
function getHeaderValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lower = name.toLowerCase();
  const direct = headers[lower];
  if (typeof direct === "string") {
    return direct;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

function challengeOffersBearer(wwwAuthenticate: string): boolean {
  return /\bBearer\b/i.test(wwwAuthenticate);
}

/** Extract the `resource_metadata` auth-param value from a WWW-Authenticate
 * challenge. RFC 7235 allows the value quoted or as a bare token; accept both.
 * The left boundary keeps a hypothetical `x_resource_metadata` param from
 * matching. */
function extractResourceMetadata(wwwAuthenticate: string): string | undefined {
  const match = wwwAuthenticate.match(
    /(?:^|[\s,])resource_metadata\s*=\s*(?:"([^"]*)"|([^",\s]+))/i,
  );
  if (!match) {
    return undefined;
  }
  return match[1] ?? match[2];
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function bodyIsParseable(body: unknown): boolean {
  if (body === undefined || body === null) {
    return false;
  }
  if (typeof body === "string") {
    return body.trim().length > 0;
  }
  // Any object (including {}) got here by parsing successfully.
  return true;
}

// Exported for the runner's pre-flight authorization-requirement probe, which
// needs exactly this request: version-aware (no `MCP-Protocol-Version` on
// 2025-03-26) and deliberately tokenless.
export function buildUnauthenticatedMcpRequest(
  config: NormalizedOAuthConformanceConfig,
): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  // Deliberately no Authorization header — this is the unauthenticated probe.
  // Mirrors buildInvalidTokenMcpRequest (oauth-negative.ts) minus the bearer.
  const headers: Record<string, string> = {
    ...(config.customHeaders ?? {}),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  // customHeaders may carry credentials (e.g. a gateway bypass token). If any
  // Authorization variant survives the spread, the probe is silently
  // authenticated and the check false-fails on the resulting 2xx.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") {
      delete headers[key];
    }
  }

  if (config.protocolVersion !== "2025-03-26") {
    headers["MCP-Protocol-Version"] = config.protocolVersion;
  }

  return {
    method: "POST",
    url: config.serverUrl,
    headers,
    body: buildInitializeRequestBody({
      protocolVersion: resolveInitializeProtocolVersion(config.protocolVersion),
      authMode: config.auth.mode,
      clientName: "MCPJam SDK OAuth Conformance",
      clientVersion: "1.0.0",
      id: 1001,
    }),
  };
}

/**
 * Finding 4: an unauthenticated request to a protected MCP server must be
 * answered with `401` and a `Bearer` challenge — never a `500`, and never
 * silently accepted.
 */
export async function runUnauthenticatedChallengeCheck(
  input: OAuthServerObligationInput,
): Promise<OAuthServerObligationOutcome> {
  const startedAt = Date.now();
  const request = buildUnauthenticatedMcpRequest(input.config);
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_unauthenticated_challenge",
      startedAt,
      request,
      error,
      "Unauthenticated MCP request failed",
    );
  }

  const durationMs = Date.now() - startedAt;
  const wwwAuthenticate = getHeaderValue(response.headers, "www-authenticate");

  if (response.status >= 500) {
    return {
      step: "oauth_unauthenticated_challenge",
      status: "failed",
      durationMs,
      error: {
        message: `MCP server returned HTTP ${response.status} for an unauthenticated request instead of 401`,
        details: {
          status: response.status,
          statusText: response.statusText,
          response: response.body,
        },
      },
    };
  }

  // 2xx: the server served an anonymous `initialize`. The spec does not
  // require every request to be authenticated — authorization may only be
  // enforced on later requests (e.g. tools/call) — so, as with the
  // stale-session 2xx path, this is unverifiable rather than a violation.
  if (response.status >= 200 && response.status < 300) {
    return {
      step: "oauth_unauthenticated_challenge",
      status: "skipped",
      durationMs,
      error: {
        message:
          "MCP server accepted an unauthenticated initialize; authorization may only be enforced on later requests, so the 401 challenge could not be observed",
        details: {
          status: response.status,
          statusText: response.statusText,
        },
      },
    };
  }

  if (response.status !== 401) {
    return {
      step: "oauth_unauthenticated_challenge",
      status: "failed",
      durationMs,
      error: {
        message: `MCP server did not challenge an unauthenticated request (expected HTTP 401, received ${response.status})`,
        details: {
          status: response.status,
          statusText: response.statusText,
          response: response.body,
        },
      },
    };
  }

  if (!wwwAuthenticate || !challengeOffersBearer(wwwAuthenticate)) {
    return {
      step: "oauth_unauthenticated_challenge",
      status: "failed",
      durationMs,
      error: {
        message: wwwAuthenticate
          ? "MCP server returned 401 with a WWW-Authenticate header that does not offer a Bearer challenge"
          : "MCP server returned 401 without a WWW-Authenticate Bearer challenge (RFC 6750 §3)",
        details: {
          status: response.status,
          wwwAuthenticate,
        },
      },
    };
  }

  return {
    step: "oauth_unauthenticated_challenge",
    status: "passed",
    durationMs,
  };
}

/**
 * Finding 3: the Bearer challenge on an unauthenticated request must include an
 * absolute `resource_metadata` URL (RFC 9728 §5.1) so the client can discover
 * the protected-resource metadata document.
 */
export async function runResourceMetadataChallengeCheck(
  input: OAuthServerObligationInput,
): Promise<OAuthServerObligationOutcome> {
  // RFC 9728 protected-resource metadata entered the MCP authorization spec at
  // 2025-06-18; a 2025-03-26 server owes no resource_metadata parameter, so
  // there is nothing to probe.
  if (input.config.protocolVersion === "2025-03-26") {
    return {
      step: "oauth_resource_metadata_challenge",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "The 2025-03-26 authorization spec predates RFC 9728 protected-resource metadata; resource_metadata is not required on this protocol version",
      },
    };
  }

  const startedAt = Date.now();
  const request = buildUnauthenticatedMcpRequest(input.config);
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_resource_metadata_challenge",
      startedAt,
      request,
      error,
      "Unauthenticated MCP request failed",
    );
  }

  const durationMs = Date.now() - startedAt;
  const wwwAuthenticate = getHeaderValue(response.headers, "www-authenticate");

  // No challenge to inspect — the missing/!401 challenge is a distinct
  // obligation owned by oauth_unauthenticated_challenge; don't double-report it.
  if (!wwwAuthenticate) {
    return {
      step: "oauth_resource_metadata_challenge",
      status: "skipped",
      durationMs,
      error: {
        message:
          "No WWW-Authenticate challenge was returned, so resource_metadata could not be isolated",
        details: {
          status: response.status,
          statusText: response.statusText,
        },
      },
    };
  }

  // A non-Bearer challenge (e.g. Basic) already fails
  // oauth_unauthenticated_challenge; failing here too would report the same
  // root cause twice. RFC 9728 only obligates resource_metadata on Bearer.
  if (!challengeOffersBearer(wwwAuthenticate)) {
    return {
      step: "oauth_resource_metadata_challenge",
      status: "skipped",
      durationMs,
      error: {
        message:
          "The WWW-Authenticate challenge does not offer a Bearer scheme, so resource_metadata does not apply; the missing Bearer challenge is reported by the unauthenticated-challenge check",
        details: { wwwAuthenticate },
      },
    };
  }

  const resourceMetadata = extractResourceMetadata(wwwAuthenticate);

  // Strictly ABSENT, not falsy: `resource_metadata=""` is a present-but-empty
  // parameter, and the absolute-URL branch below owns rejecting every present
  // invalid value. Folding empty into "omitted" would let a valid well-known
  // document launder a malformed challenge into a pass on 2025-11-25+.
  if (resourceMetadata === undefined) {
    // Version-sensitive: 2025-06-18 states a flat MUST — "MCP servers MUST
    // use the HTTP header WWW-Authenticate … to indicate the location of the
    // resource server metadata URL" — so the omission is a violation there.
    // 2025-11-25 (and 2026-07-28, verbatim) replaced it with "MCP servers
    // MUST implement ONE of the following discovery mechanisms": the header,
    // OR protected-resource metadata at a well-known URI (path-scoped first,
    // then root). On those revisions the omission is only a violation when
    // neither well-known URI serves the metadata either.
    if (input.config.protocolVersion === "2025-06-18") {
      return {
        step: "oauth_resource_metadata_challenge",
        status: "failed",
        durationMs,
        error: {
          message:
            "WWW-Authenticate Bearer challenge omitted the resource_metadata parameter; 2025-06-18 requires the header to indicate the resource metadata location (RFC 9728 §5.1)",
          details: { wwwAuthenticate },
        },
      };
    }

    const wellKnown = await probeWellKnownResourceMetadata(input);
    if (wellKnown.served) {
      return {
        step: "oauth_resource_metadata_challenge",
        status: "passed",
        durationMs: Date.now() - startedAt,
        warnings: [
          `The Bearer challenge omitted resource_metadata; discovery relies on the well-known URI (${wellKnown.url}), the second mechanism ${input.config.protocolVersion} sanctions`,
        ],
      };
    }

    return {
      step: "oauth_resource_metadata_challenge",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: {
        message: `${input.config.protocolVersion} requires one of two discovery mechanisms, and the server provides neither: the WWW-Authenticate Bearer challenge omitted resource_metadata, and no well-known URI served protected-resource metadata`,
        details: {
          wwwAuthenticate,
          wellKnownAttempts: wellKnown.attempts,
        },
      },
    };
  }

  if (!isAbsoluteHttpUrl(resourceMetadata)) {
    return {
      step: "oauth_resource_metadata_challenge",
      status: "failed",
      durationMs,
      error: {
        message: `resource_metadata must be an absolute http(s) URL (RFC 9728 §5.1); received "${resourceMetadata}"`,
        details: { wwwAuthenticate, resourceMetadata },
      },
    };
  }

  return {
    step: "oauth_resource_metadata_challenge",
    status: "passed",
    durationMs,
  };
}

/**
 * RFC 9728 well-known probing, in the order 2025-11-25 lists: the path-scoped
 * URI first (the well-known segment inserted before the endpoint's path AND
 * query, per RFC 9728 §3), then the root. "Served" is held to what RFC 9728
 * requires of a successful metadata response, or lookalikes would satisfy the
 * one-of-two MUST:
 *
 *   - a 200 with an `application/json` media type (§3.2) — an SPA answering
 *     unknown paths with its index page is not metadata;
 *   - a JSON object whose REQUIRED `resource` member (§3.3) identifies the
 *     resource actually under test — metadata published for a DIFFERENT
 *     resource proves nothing about this one. Compared on normalized URLs so
 *     cosmetic differences (default ports, trailing slash) don't false-fail.
 *
 * The probe carries the run's custom headers (a gateway bypass, a routing
 * header) exactly like every other conformance request, minus any
 * Authorization variant — discovery is defined unauthenticated.
 */
async function probeWellKnownResourceMetadata(
  input: OAuthServerObligationInput,
): Promise<{
  served: boolean;
  url?: string;
  attempts: Array<{ url: string; status?: number; reason: string }>;
}> {
  const endpoint = new URL(input.config.serverUrl);
  const origin = `${endpoint.protocol}//${endpoint.host}`;
  const pathAndQuery = `${endpoint.pathname.replace(/\/$/, "")}${endpoint.search}`;
  const candidates = [
    ...(pathAndQuery
      ? [`${origin}/.well-known/oauth-protected-resource${pathAndQuery}`]
      : []),
    `${origin}/.well-known/oauth-protected-resource`,
  ];

  const headers: Record<string, string> = {
    ...(input.config.customHeaders ?? {}),
    Accept: "application/json",
  };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") {
      delete headers[key];
    }
  }

  const attempts: Array<{ url: string; status?: number; reason: string }> = [];
  for (const url of candidates) {
    try {
      const response = await input.trackedRequest({
        method: "GET",
        url,
        headers,
      });
      if (response.status !== 200) {
        attempts.push({ url, status: response.status, reason: "non-200" });
        continue;
      }
      const contentType = getHeaderValue(response.headers, "content-type");
      const mediaType = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        attempts.push({
          url,
          status: response.status,
          reason: `200 but Content-Type "${contentType ?? "(none)"}" is not application/json (RFC 9728 §3.2)`,
        });
        continue;
      }
      const body =
        typeof response.body === "string"
          ? safeJsonParse(response.body)
          : response.body;
      const resource =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).resource
          : undefined;
      if (typeof resource !== "string") {
        attempts.push({
          url,
          status: response.status,
          reason:
            "200 but not RFC 9728 protected-resource metadata (no `resource` member)",
        });
        continue;
      }
      if (!urlsIdentify(resource, input.config.serverUrl)) {
        attempts.push({
          url,
          status: response.status,
          reason: `metadata identifies a different resource ("${resource}", not the server under test) — RFC 9728 §3.3 binds a document to its resource`,
        });
        continue;
      }
      return { served: true, url, attempts };
    } catch (error) {
      attempts.push({
        url,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { served: false, attempts };
}

/** URL identity on normalized form, so `https://a.example:443/mcp/` and
 * `https://a.example/mcp` identify the same resource. */
function urlsIdentify(left: string, right: string): boolean {
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      url.pathname = url.pathname.replace(/\/$/, "");
      return url.href;
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Unlike every other check, this request carries the REAL access token.
// buildTransportFailure redacts the Authorization header before embedding the
// request in error details, so the token never enters a StepResult regardless
// of whether the consumer applies the report-level redaction.
function buildStaleSessionMcpRequest(
  config: NormalizedOAuthConformanceConfig,
  accessToken: string,
): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const headers: Record<string, string> = {
    ...(config.customHeaders ?? {}),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Session-Id": STALE_SESSION_ID,
  };

  if (config.protocolVersion !== "2025-03-26") {
    headers["MCP-Protocol-Version"] = config.protocolVersion;
  }

  // A non-initialize method: `initialize` creates sessions, so a stale session
  // id is only meaningful on a subsequent request. `tools/list` needs a live
  // session, so an unknown session id is exactly the stale-session scenario.
  return {
    method: "POST",
    url: config.serverUrl,
    headers,
    body: {
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 1002,
    },
  };
}

/**
 * Finding 5: a request carrying a stale/unknown `Mcp-Session-Id` must be
 * rejected with a 4xx (the transport spec prefers 404) — never a 500. Per
 * HP-17 the spec does NOT mandate a parseable body, so a non-parseable body is
 * reported as evidence but does not fail the check; only a 5xx crash does.
 */
export async function runStaleSessionRejectionCheck(
  input: OAuthServerObligationInput,
): Promise<OAuthServerObligationOutcome> {
  const startedAt = Date.now();

  // The 2026-07-28 wire is stateless — there is no Mcp-Session-Id to go stale.
  if (input.config.protocolVersion === "2026-07-28") {
    return {
      step: "oauth_stale_session_rejection",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "The 2026-07-28 transport is stateless; there is no session id to invalidate",
      },
    };
  }

  const accessToken = input.state.accessToken;
  if (!accessToken) {
    return {
      step: "oauth_stale_session_rejection",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "No access token is available to isolate stale-session handling from authentication",
      },
    };
  }

  const request = buildStaleSessionMcpRequest(input.config, accessToken);
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_stale_session_rejection",
      startedAt,
      request,
      error,
      "Stale-session MCP request failed",
    );
  }

  const durationMs = Date.now() - startedAt;

  if (response.status >= 500) {
    return {
      step: "oauth_stale_session_rejection",
      status: "failed",
      durationMs,
      error: {
        message: `MCP server returned HTTP ${response.status} for a stale Mcp-Session-Id instead of a 4xx rejection`,
        details: {
          status: response.status,
          statusText: response.statusText,
          response: response.body,
        },
      },
    };
  }

  if (response.status >= 400) {
    // Evidence only — 404 is spec-preferred and a parseable body is nice to
    // have, but neither is mandated, so they never downgrade a passing 4xx.
    // Recorded as warnings, not error: the UI renders error as a failure
    // banner regardless of status.
    const warnings: string[] = [];
    if (response.status !== 404) {
      warnings.push(
        `Rejected with HTTP ${response.status} (the transport spec prefers 404)`,
      );
    }
    if (!bodyIsParseable(response.body)) {
      warnings.push(
        `Rejected with ${response.status} but the response body was empty or unparseable`,
      );
    }
    return {
      step: "oauth_stale_session_rejection",
      status: "passed",
      durationMs,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  // 2xx: the server ignored an unknown session id. A stateless/non-session
  // server legitimately does this, so it is not a violation — just unverifiable.
  return {
    step: "oauth_stale_session_rejection",
    status: "skipped",
    durationMs,
    error: {
      message:
        "MCP server accepted a request with an unknown Mcp-Session-Id; it does not appear to enforce session state",
      details: {
        status: response.status,
        statusText: response.statusText,
      },
    },
  };
}
