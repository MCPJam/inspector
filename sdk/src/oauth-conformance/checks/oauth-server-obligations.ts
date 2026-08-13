import type { OAuthFlowState } from "../../oauth/state-machines/types.js";
import {
  buildInitializeRequestBody,
  resolveInitializeProtocolVersion,
} from "../../oauth/state-machines/shared/initialize.js";
import {
  mergeHeadersForAuthServer,
  mergeHeadersForResourceMetadataRequest,
} from "../../oauth/state-machines/shared/headers.js";
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

// ── Catalog-derived server obligations (HP-47 S13/S16) ─────────────────
//
// HP-47 enumerated 17 obligations (S1–S17) a server owes the *catalog* of real
// clients, derived by reading each client's source rather than its docs. The
// two implemented here are the two whose violation silently breaks whole
// families of clients while every check above still passes:
//
//   S13 — the AS metadata document must advertise a `registration_endpoint`
//     (RFC 7591 / RFC 8414). HP-47 found this to be the highest-frequency
//     real-world failure in the catalog: Cline (which has no hardcoded
//     client_id anywhere in its repo), n8n, and Codex are all DCR-first with
//     no pre-registered fallback, so a server whose AS omits this endpoint is
//     not merely degraded for them — it is unusable. Before this check the
//     omission produced a *skip* in `oauth_dcr_http_redirect_uri`, which reads
//     like coverage in a report; it is now a first-class failure.
//   S16 — the `/.well-known/*` discovery endpoints must tolerate an unexpected
//     `MCP-Protocol-Version` request header. `rmcp` (the Rust MCP SDK, the
//     OAuth implementation behind both Codex and Goose) hardcodes an old
//     revision on discovery requests while negotiating a modern one on MCP
//     traffic. A server that gates its discovery responses on that header
//     works perfectly against TypeScript-SDK clients and fails for every
//     rmcp-based one — a failure mode invisible from any vendor documentation.

type OAuthServerObligationStep = Extract<
  OAuthConformanceCheckId,
  | "oauth_unauthenticated_challenge"
  | "oauth_resource_metadata_challenge"
  | "oauth_stale_session_rejection"
  | "oauth_as_registration_endpoint"
  | "oauth_discovery_stale_protocol_header"
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

// The exact revision `rmcp` hardcodes on its OAuth discovery requests. This is
// NOT an arbitrary "old value" chosen to look stale: it is the literal string
// in the Rust SDK, so a server that rejects it rejects Codex and Goose today.
// Picking any other stale-looking revision would test a hypothetical, and
// picking a *newer-than-negotiated* one would test forward tolerance, which no
// shipping client actually exercises. Keep this pinned to what rmcp sends; if
// rmcp bumps it, this literal should follow, not lead.
const RMCP_DISCOVERY_PROTOCOL_VERSION = "2024-11-05";

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

/**
 * S13: the authorization server metadata document must advertise a
 * `registration_endpoint` (RFC 7591 §2 / RFC 8414 §2) so a client with no
 * pre-registered identity can obtain one.
 *
 * Unlike every other check in this file this one issues NO HTTP request — the
 * document is already in `state.authorizationServerMetadata`, fetched by the
 * discovery step. That makes it free to run, which is what lets it sit outside
 * the runner's green-flow gate (see runner.ts): it costs nothing on a run whose
 * flow already failed, and a missing registration_endpoint is frequently the
 * reason such a run failed in the first place.
 *
 * It is intentionally synchronous. An `async` signature here would imply I/O
 * that never happens and invite a future reader to add some.
 */
export function runAsRegistrationEndpointCheck(input: {
  config: NormalizedOAuthConformanceConfig;
  state: OAuthFlowState;
}): OAuthServerObligationOutcome {
  const metadata = input.state.authorizationServerMetadata;

  // No document means no claim to test. The discovery failure that produced
  // this state is already reported by the flow step that could not fetch it, so
  // asserting here would only restate it as a second, less precise failure.
  if (!metadata) {
    return {
      step: "oauth_as_registration_endpoint",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "Authorization server metadata was never discovered, so registration_endpoint could not be inspected",
      },
    };
  }

  const registrationEndpoint = metadata.registration_endpoint;

  // Absent vs. malformed are graded differently on purpose (below), so split
  // them here. Anything the server actually published — including an empty
  // string — counts as "advertised" and is held to RFC 8414's absolute-URI
  // requirement; only a truly missing key takes the absent path.
  if (registrationEndpoint === undefined || registrationEndpoint === null) {
    // The obligation is about whether the server is usable by the DCR-only
    // clients in the catalog, which is independent of how *this* flow
    // authenticated — so a CIMD or pre-registered run still reports it rather
    // than skipping. But it reports as a warning on a passing step, not a
    // failure: this run demonstrably completed without DCR, and failing it
    // would make every CIMD/pre-registered conformance run red against a server
    // that is fully conformant for the path under test. The conformance verdict
    // stays about the flow exercised; the catalog-level finding still lands on
    // the record at the same site instead of vanishing into a skip.
    if (input.config.registrationStrategy !== "dcr") {
      return {
        step: "oauth_as_registration_endpoint",
        status: "passed",
        durationMs: 0,
        warnings: [
          `Authorization server metadata does not advertise registration_endpoint. This flow used the "${input.config.registrationStrategy}" strategy and did not need it, but DCR-only clients (Cline, n8n, Codex) cannot obtain a client_id from this server at all.`,
        ],
      };
    }

    // DCR was the strategy under test, so the missing endpoint is load-bearing
    // and fails at error level. This can co-report with the flow's own DCR step
    // failure; that duplication is deliberate here — the runner's summary quotes
    // the FIRST failure, so the root cause stays the headline while this check
    // names the obligation the report is otherwise silent about.
    return {
      step: "oauth_as_registration_endpoint",
      status: "failed",
      durationMs: 0,
      error: {
        message:
          "Authorization server metadata omits registration_endpoint, so dynamic client registration is impossible (RFC 7591 / RFC 8414)",
        details: {
          issuer: metadata.issuer,
          registrationStrategy: input.config.registrationStrategy,
          advertisedMetadataKeys: Object.keys(metadata).sort(),
        },
      },
    };
  }

  // A relative or otherwise unparseable value is a defect in the published
  // document rather than an absent capability: the server claims to support DCR
  // and hands out an address no client can POST to. That is a violation
  // regardless of which strategy this run used, so it never softens to a
  // warning the way the absent case does.
  if (
    typeof registrationEndpoint !== "string" ||
    !isAbsoluteHttpUrl(registrationEndpoint)
  ) {
    return {
      step: "oauth_as_registration_endpoint",
      status: "failed",
      durationMs: 0,
      error: {
        message: `registration_endpoint must be an absolute http(s) URL (RFC 8414 §2); received ${JSON.stringify(
          registrationEndpoint,
        )}`,
        details: {
          issuer: metadata.issuer,
          registrationEndpoint,
        },
      },
    };
  }

  return {
    step: "oauth_as_registration_endpoint",
    status: "passed",
    durationMs: 0,
  };
}

/** The discovery document this check re-requests, plus the field that identifies
 * it. A stable identifier is compared instead of the whole body because servers
 * legitimately vary other fields between two fetches (cache headers, ordering,
 * newly advertised scopes); only the document's identity must hold. */
interface DiscoveryDocumentTarget {
  url: string;
  kind: "protected-resource metadata" | "authorization server metadata";
  field: "resource" | "issuer";
  recordedValue: string;
}

/** Locate the authorization-server metadata document's URL. Discovery walks a
 * ladder of RFC 8414/OIDC candidate URLs and only the *successful* one is
 * meaningful to re-request, but state records the discovery base URL rather
 * than the winning candidate — so recover it from the request history by
 * matching the response that actually carried this issuer. */
function findAsMetadataUrlInHistory(
  state: OAuthFlowState,
  issuer: string,
): string | undefined {
  const history = state.httpHistory ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const status = entry.response?.status;
    if (status === undefined || status < 200 || status >= 300) {
      continue;
    }
    if (entry.request.method.toUpperCase() !== "GET") {
      continue;
    }
    const body = entry.response?.body;
    if (!body || typeof body !== "object") {
      continue;
    }
    if ((body as Record<string, unknown>).issuer !== issuer) {
      continue;
    }
    return entry.request.url;
  }
  return undefined;
}

function resolveDiscoveryDocumentTarget(
  state: OAuthFlowState,
): DiscoveryDocumentTarget | undefined {
  // Prefer protected-resource metadata: it is the first document every modern
  // client fetches, so a gate on it breaks clients before they ever reach the
  // AS, and its exact successful URL is recorded in state by the discovery step.
  const prmResource = state.resourceMetadata?.resource;
  if (
    state.resourceMetadataUrl &&
    typeof prmResource === "string" &&
    prmResource.length > 0
  ) {
    return {
      url: state.resourceMetadataUrl,
      kind: "protected-resource metadata",
      field: "resource",
      recordedValue: prmResource,
    };
  }

  const issuer = state.authorizationServerMetadata?.issuer;
  if (typeof issuer === "string" && issuer.length > 0) {
    const url = findAsMetadataUrlInHistory(state, issuer);
    if (url) {
      return {
        url,
        kind: "authorization server metadata",
        field: "issuer",
        recordedValue: issuer,
      };
    }
  }

  return undefined;
}

/**
 * S16: a discovery endpoint that already answered during the flow must keep
 * answering when the request carries a stale/unexpected `MCP-Protocol-Version`.
 *
 * The probe re-requests a document known to work and changes exactly one thing —
 * the protocol header — so a difference in the response is attributable to the
 * header and nothing else.
 */
export async function runDiscoveryStaleProtocolHeaderCheck(
  input: OAuthServerObligationInput,
): Promise<OAuthServerObligationOutcome> {
  const target = resolveDiscoveryDocumentTarget(input.state);

  // With no document known to have succeeded there is no baseline, and a
  // failure could not be attributed to the header rather than to the endpoint
  // simply not existing.
  if (!target) {
    return {
      step: "oauth_discovery_stale_protocol_header",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "No discovery document was successfully fetched during the flow, so there is no baseline to re-request with a stale MCP-Protocol-Version",
      },
    };
  }

  const startedAt = Date.now();
  // Mirror the header set the flow's own discovery leg sent so the ONLY
  // difference from the request that succeeded is MCP-Protocol-Version. The two
  // legs differ: the PRM fetch keeps a user-supplied Authorization when the
  // document is same-origin with the MCP server, while the AS metadata fetch
  // strips it whatever the origin — sending it to the AS here would change two
  // things at once and could fail a server that rejects the extra credential.
  const probeHeaders = {
    Accept: "application/json",
    "MCP-Protocol-Version": RMCP_DISCOVERY_PROTOCOL_VERSION,
  };
  const request = {
    method: "GET",
    url: target.url,
    headers:
      target.kind === "protected-resource metadata"
        ? mergeHeadersForResourceMetadataRequest(
            input.config.serverUrl,
            target.url,
            input.config.customHeaders,
            probeHeaders,
          )
        : mergeHeadersForAuthServer(input.config.customHeaders, probeHeaders),
  };
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_discovery_stale_protocol_header",
      startedAt,
      request,
      error,
      "Discovery request with a stale MCP-Protocol-Version failed",
    );
  }

  const durationMs = Date.now() - startedAt;

  if (response.status < 200 || response.status >= 300) {
    return {
      step: "oauth_discovery_stale_protocol_header",
      status: "failed",
      durationMs,
      error: {
        message: `Discovery endpoint returned HTTP ${response.status} when the request carried MCP-Protocol-Version: ${RMCP_DISCOVERY_PROTOCOL_VERSION}, but succeeded without it — rmcp-based clients (Codex, Goose) send exactly this header on discovery and cannot authenticate against this server`,
        details: {
          discoveryUrl: target.url,
          document: target.kind,
          mcpProtocolVersion: RMCP_DISCOVERY_PROTOCOL_VERSION,
          status: response.status,
          statusText: response.statusText,
          response: response.body,
        },
      },
    };
  }

  const body = response.body;
  const observedValue =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)[target.field]
      : undefined;

  if (typeof observedValue !== "string" || observedValue.length === 0) {
    return {
      step: "oauth_discovery_stale_protocol_header",
      status: "failed",
      durationMs,
      error: {
        message: `Discovery endpoint answered HTTP ${response.status} with a body that no longer carries "${target.field}" when the request carried MCP-Protocol-Version: ${RMCP_DISCOVERY_PROTOCOL_VERSION}; rmcp-based clients would fail to parse ${target.kind}`,
        details: {
          discoveryUrl: target.url,
          document: target.kind,
          mcpProtocolVersion: RMCP_DISCOVERY_PROTOCOL_VERSION,
          expectedField: target.field,
          expectedValue: target.recordedValue,
          response: body,
        },
      },
    };
  }

  // The endpoint still serves a parseable document, which is the obligation. A
  // *different* identifier means the header steered the server to a different
  // document — surprising and worth recording, but the client can still read it,
  // so it is evidence rather than a failure (same posture as the stale-session
  // check's status-specificity warning).
  if (observedValue !== target.recordedValue) {
    return {
      step: "oauth_discovery_stale_protocol_header",
      status: "passed",
      durationMs,
      warnings: [
        `Discovery endpoint still responded, but "${target.field}" changed from "${target.recordedValue}" to "${observedValue}" when MCP-Protocol-Version: ${RMCP_DISCOVERY_PROTOCOL_VERSION} was sent`,
      ],
    };
  }

  return {
    step: "oauth_discovery_stale_protocol_header",
    status: "passed",
    durationMs,
  };
}
