/**
 * The readiness / interoperability channel — Phase 7 §15.4.
 *
 * Everything reported here is NON-MUST advice: SHOULD, RECOMMENDED, or MAY
 * strength. A readiness warning is attached to
 * `MCPConformanceResult.readiness` and is NEVER converted into a check result,
 * so it cannot change `passed`, any check status, or the category summary.
 * That separation is the point: a server that is fully conformant but awkward
 * to interoperate with should read as "conformant, with advice", never as a
 * failure — and a conformance verdict must stay a statement about MUSTs.
 *
 * Each warning carries the spec strength of the requirement it reflects, so a
 * reader can tell "the spec says you SHOULD" from "the spec says you MAY".
 */

import type { Tool } from "@modelcontextprotocol/client";
import { scanXMcpHeaderDeclarations } from "../mcp-client-manager/mcp-header-mirror.js";
import { listTools } from "../operations.js";
import type {
  MCPClientCheckContext,
  MCPReadinessSpecStrength,
  MCPReadinessWarning,
  MCPServerSurfaceSnapshot,
  RawHttpCheckContext,
} from "./types.js";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  jsonRpcError,
  jsonRpcResult,
  legacyHeaders,
  legacyInitialize,
  rawHeadersProbe,
  modernHeaders,
  modernRequestBody,
  rawRequest,
  walkToolsList,
} from "./raw-http.js";

/** Capabilities whose 2025-era mechanics were replaced in the 2026 revision. */
const DEPRECATED_MODERN_CAPABILITIES: Array<{
  key: string;
  advice: string;
}> = [
  {
    key: "logging",
    advice:
      "the logging capability advertises the removed logging/setLevel handshake; modern clients carry the log level per request",
  },
];

function warning(
  id: MCPReadinessWarning["id"],
  title: string,
  specStrength: MCPReadinessSpecStrength,
  message: string,
  details?: Record<string, unknown>
): MCPReadinessWarning {
  return { id, title, severity: "warning", specStrength, message, details };
}

/**
 * Advice that is REPORTED but costs no points — see
 * {@link MCPReadinessWarning.informational}. Use this, not {@link warning},
 * whenever the behavior described is one the specification explicitly allows or
 * merely illustrates.
 */
function informational(
  id: MCPReadinessWarning["id"],
  title: string,
  specStrength: MCPReadinessSpecStrength,
  message: string,
  details?: Record<string, unknown>
): MCPReadinessWarning {
  return { ...warning(id, title, specStrength, message, details), informational: true };
}

function toolOrderWarning(
  first: string[],
  second: string[]
): MCPReadinessWarning | undefined {
  if (first.length === 0 || first.join("\u0000") === second.join("\u0000")) {
    return undefined;
  }

  return warning(
    "readiness-tool-order-deterministic",
    "Deterministic Tool Order",
    "SHOULD",
    "tools/list returned the tools in a different order on a repeated call; a stable order keeps client-side caches, diffs, and model prompts stable across calls",
    { firstListing: first, secondListing: second }
  );
}

function metadataQualityWarning(
  tools: Tool[],
  serverName: string | undefined
): MCPReadinessWarning | undefined {
  const missingDescription = tools
    .filter((tool) => !tool.description?.trim())
    .map((tool) => tool.name);
  const missingTitle = tools
    .filter((tool) => !tool.title?.trim() && !tool.annotations?.title?.trim())
    .map((tool) => tool.name);
  const problems: string[] = [];

  if (missingDescription.length > 0) {
    problems.push(`${missingDescription.length} tool(s) have no description`);
  }
  if (missingTitle.length > 0) {
    problems.push(
      `${missingTitle.length} tool(s) have no human-readable title`
    );
  }
  if (!serverName?.trim()) {
    problems.push("the server does not report an identity name");
  }

  if (problems.length === 0) {
    return undefined;
  }

  return warning(
    "readiness-metadata-quality",
    "Metadata Quality",
    "SHOULD",
    `Primitive metadata is incomplete: ${problems.join(
      "; "
    )}. Models and human operators both select primitives from this metadata`,
    { missingDescription, missingTitle }
  );
}

function deprecatedFeatureWarning(
  ctx: MCPClientCheckContext,
  capabilities: Record<string, unknown>
): MCPReadinessWarning | undefined {
  const findings: string[] = [];

  if (ctx.config.era === "modern") {
    for (const { key, advice } of DEPRECATED_MODERN_CAPABILITIES) {
      if (capabilities[key] !== undefined) {
        findings.push(advice);
      }
    }
    const resources = capabilities.resources;
    if (
      resources !== null &&
      typeof resources === "object" &&
      (resources as Record<string, unknown>).subscribe === true
    ) {
      findings.push(
        "resources.subscribe advertises the removed resources/subscribe flow; modern clients subscribe through subscriptions/listen"
      );
    }
  } else if (
    ctx.initializationInfo?.protocolVersion !== undefined &&
    ctx.initializationInfo.protocolVersion < "2025-11-25"
  ) {
    findings.push(
      `the negotiated revision ${ctx.initializationInfo.protocolVersion} is superseded; newer clients negotiate a later revision`
    );
  }

  if (findings.length === 0) {
    return undefined;
  }

  return warning(
    "readiness-deprecated-feature-use",
    "Deprecated Feature Use",
    "SHOULD",
    `Server advertises superseded functionality: ${findings.join("; ")}`,
    { findings }
  );
}

/**
 * Readiness advice observable from the client session, collected while the
 * connection is still open. Any failure here is swallowed: readiness is
 * advisory, so a probe that cannot run must never disturb the run.
 */
export async function collectClientReadiness(
  ctx: MCPClientCheckContext,
  surface: MCPServerSurfaceSnapshot
): Promise<MCPReadinessWarning[]> {
  const warnings: MCPReadinessWarning[] = [];

  try {
    const secondListing = await listTools(ctx.manager, {
      serverId: ctx.serverId,
    });
    const orderWarning = toolOrderWarning(
      surface.toolNames,
      secondListing.tools.map((tool) => tool.name)
    );
    if (orderWarning) {
      warnings.push(orderWarning);
    }
  } catch {
    // A server without tools (or one that failed the repeat listing) simply
    // yields no ordering advice.
  }

  const metadataWarning = metadataQualityWarning(
    surface.tools,
    ctx.initializationInfo?.serverVersion?.name
  );
  if (metadataWarning) {
    warnings.push(metadataWarning);
  }

  const deprecated = deprecatedFeatureWarning(
    ctx,
    surface.serverCapabilities ?? {}
  );
  if (deprecated) {
    warnings.push(deprecated);
  }

  return warnings;
}

async function cacheTtlWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era !== "modern") {
    return undefined;
  }

  const version = ctx.config.protocolVersion ?? "2026-07-28";
  const result = await rawRequest(ctx, {
    headers: modernHeaders({ protocolVersion: version, method: "tools/list" }),
    body: modernRequestBody({
      id: 8100,
      method: "tools/list",
      protocolVersion: version,
    }),
  });

  const ttlMs = jsonRpcResult(result)?.ttlMs;
  if (typeof ttlMs !== "number" || ttlMs > 0) {
    return undefined;
  }

  return warning(
    "readiness-cache-ttl-useful",
    "Useful Cache TTLs",
    "SHOULD",
    "Cacheable results advertise ttlMs: 0, so no client can reuse them; a non-zero TTL on stable listings removes a round trip per call",
    { method: "tools/list", ttlMs }
  );
}

/**
 * SEP-2243 `x-mcp-header` declarations, on the ADVICE channel.
 *
 * The MUST is `tools-x-mcp-header-declarations-valid`; this is the
 * interoperability half of the same observation, said in the words an operator
 * needs. The spec's consequence for a bad declaration is not "the header is
 * skipped" — a conforming client treats the whole TOOL DEFINITION as invalid
 * and drops it from `tools/list`, so the tool silently disappears from that
 * client. A pass/fail verdict does not convey that; this does.
 *
 * Raw, for the same unavoidable reason as the check: the official client
 * applies the exclusion itself, so `surface.tools` never contains an offender
 * and a client-side scan would always come back clean.
 */
async function xMcpHeaderDeclarationsWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era !== "modern") {
    // Before 2026-07-28 the annotation carries no meaning; advising on it
    // would invent a requirement the revision never stated.
    return undefined;
  }

  const version = ctx.config.protocolVersion ?? "2026-07-28";

  // The SAME bounded, cycle-safe walk the declaration check runs. A
  // first-page-only scan would let a paginated server keep hiding tools from
  // conforming clients without ever earning the advice, and a second copy of
  // the walk would be a second place for a cursor bug to live. What a
  // truncated walk MEANS still differs by caller: the check cannot pass over
  // tools it never read, while advice simply reports on what it saw.
  const walk = await walkToolsList({
    startId: 8110,
    request: ({ id, cursor }) =>
      rawRequest(ctx, {
        headers: modernHeaders({
          protocolVersion: version,
          method: "tools/list",
        }),
        body: modernRequestBody({
          id,
          method: "tools/list",
          protocolVersion: version,
          ...(cursor !== undefined ? { params: { cursor } } : {}),
        }),
      }),
  });

  const invalid: Array<{ tool: string; reason: string }> = [];
  for (const entry of walk.tools) {
    if (entry.inputSchema === undefined) continue;
    const scan = scanXMcpHeaderDeclarations(entry.inputSchema);
    if (!scan.valid) {
      invalid.push({
        tool: typeof entry.name === "string" ? entry.name : "<unnamed>",
        reason: scan.reason,
      });
    }
  }

  if (invalid.length === 0) return undefined;

  return warning(
    "readiness-x-mcp-header-declarations",
    "x-mcp-header Declarations",
    "SHOULD",
    `${invalid.length} tool(s) declare x-mcp-header in a way SEP-2243 does not permit: ${invalid
      .map((entry) => `${entry.tool} (${entry.reason})`)
      .join(
        "; "
      )}. Clients that implement the mirroring exclude these tools from tools/list entirely, so they become invisible rather than merely losing a header`,
    { invalid }
  );
}

/**
 * No revision of the transports spec maps an unparseable POST body to ANY
 * HTTP status or JSON-RPC error — the docs are silent in every version — so
 * this can never be a check. JSON-RPC 2.0 itself names `-32700 Parse error`
 * for exactly this, and a server that answers garbage with a SUCCESS status
 * confuses every client on the far side of a proxy bug or truncated body.
 * Advice therefore fires only when the server ACCEPTS the unparseable body
 * without an in-band parse error.
 */
async function parseErrorHandlingWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  const result = await rawRequest(ctx, {
    rawBody: '{"jsonrpc": "2.0",',
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    // A server that hangs on garbage instead of answering is not worth the
    // full check timeout — this is advice, not a verdict.
    timeoutMs: Math.min(ctx.config.checkTimeout, 3_000),
  });
  if (result.status >= 300) {
    // Any rejection is unobjectionable: the spec never says which one.
    return undefined;
  }
  if (jsonRpcError(result)?.code === -32700) {
    return undefined;
  }

  return warning(
    "readiness-parse-error-handling",
    "Parse Error Handling",
    "MAY",
    `The server answered an unparseable JSON body with HTTP ${result.status} and no JSON-RPC -32700 Parse error. No MCP revision mandates a particular response here, but accepting garbage as success hides transport corruption from clients`,
    { status: result.status }
  );
}

/**
 * Explicit session termination is advice on both sides of the era line: the
 * 2025 revisions say clients SHOULD send a DELETE when abandoning a session
 * and servers MAY answer 405, so no server response can violate a MUST; the
 * 2026 revision says stray GET/DELETE traffic from older clients SHOULD get
 * 405 Method Not Allowed.
 */
async function sessionTerminationWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era === "modern") {
    // The obligation is about "traffic from an older client", so the probes
    // have to LOOK like one: a 2025 protocol pin and a session id, which the
    // same clause tells a modern server to ignore. A bare request would be
    // neither era's traffic, and a header-validating server could answer 400
    // for the missing version — which the advice would then misattribute to
    // the 405 obligation.
    const staleClientHeaders = legacyHeaders({
      protocolVersion: DEFAULT_LEGACY_PROTOCOL_VERSION,
      sessionId: "mcpjam-conformance-legacy-probe",
    });
    const timeoutMs = Math.min(ctx.config.checkTimeout, 3_000);
    // The clause names GET *and* DELETE, so both are probed: a server that
    // still opens a stream on GET is exactly the backward-compat trap this
    // advice exists to name, and DELETE alone would never see it. The GET
    // reads headers only — a stream it wrongly opens would never end.
    // Settled per probe, not `Promise.all`: the two are independent
    // observations, and one that times out must not discard what the other
    // saw. A GET that hangs would otherwise bury a real DELETE violation.
    const [getProbe, deleteProbe] = await Promise.allSettled([
      rawHeadersProbe(ctx, {
        method: "GET",
        headers: { ...staleClientHeaders, Accept: "text/event-stream" },
        timeoutMs,
      }),
      rawRequest(ctx, {
        method: "DELETE",
        headers: staleClientHeaders,
        timeoutMs,
      }),
    ]);
    const get = getProbe.status === "fulfilled" ? getProbe.value : undefined;
    const del =
      deleteProbe.status === "fulfilled" ? deleteProbe.value : undefined;
    const offenders = [
      ...(get && get.status !== 405 ? [`GET got HTTP ${get.status}`] : []),
      ...(del && del.status !== 405 ? [`DELETE got HTTP ${del.status}`] : []),
    ];
    if (offenders.length === 0) {
      return undefined;
    }
    return warning(
      "readiness-session-termination",
      "Explicit Session Termination",
      "SHOULD",
      `A 2026-07-28 server SHOULD answer stray GET/DELETE traffic from older clients with HTTP 405 Method Not Allowed; ${offenders.join(
        ", "
      )}`,
      // A probe that never completed is reported as such rather than as a
      // status, so the advice cannot read as though both were observed.
      { getStatus: get?.status ?? "not observed", deleteStatus: del?.status ?? "not observed" }
    );
  }

  const { result, sessionId } = await legacyInitialize(ctx);
  if (result.status < 200 || result.status >= 300 || !sessionId) {
    // No session to terminate — nothing to advise on.
    return undefined;
  }
  const deleteResult = await rawRequest(ctx, {
    method: "DELETE",
    headers: legacyHeaders({
      protocolVersion:
        ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION,
      sessionId,
    }),
    timeoutMs: Math.min(ctx.config.checkTimeout, 3_000),
  });
  if (deleteResult.status < 500) {
    // 2xx terminated it, 405 declined to support termination (MAY), and any
    // other 4xx is at worst odd — none of these earn advice.
    return undefined;
  }

  return warning(
    "readiness-session-termination",
    "Explicit Session Termination",
    "SHOULD",
    `DELETE with the session id got HTTP ${deleteResult.status}. Clients SHOULD send this DELETE when abandoning a session (servers MAY answer 405 to decline), but a 5xx means the termination handler itself is broken`,
    { status: deleteResult.status }
  );
}

function metadataUrl(serverUrl: string, wellKnown: string): string {
  const url = new URL(serverUrl);
  return new URL(wellKnown, `${url.protocol}//${url.host}`).toString();
}

/**
 * A plain JSON document fetched over HTTP — OAuth metadata, not MCP traffic.
 *
 * `record: false` is load-bearing. These documents are not JSON-RPC and never
 * were, so letting them into the run-wide wire record fed them to
 * `wire-schema-valid`, which graded them against `JSONRPCMessage` and reported
 * both metadata documents as missing `id` and `jsonrpc` — on every server,
 * including ones with nothing else to report.
 *
 * This is the ONLY caller in this module that opts out, and deliberately so.
 * Every other `rawRequest` here speaks JSON-RPC to the MCP endpoint, including
 * the deliberately malformed body in `parseErrorHandlingWarning`, whose
 * response is exactly the kind of frame the wire check exists to grade.
 */
async function fetchJson(
  ctx: RawHttpCheckContext,
  url: string
): Promise<Record<string, unknown> | undefined> {
  const result = await rawRequest(ctx, {
    url,
    method: "GET",
    includeBaseHeaders: false,
    headers: { Accept: "application/json" },
    record: false,
  });
  return result.status === 200 &&
    result.json !== null &&
    typeof result.json === "object"
    ? (result.json as Record<string, unknown>)
    : undefined;
}

/**
 * RFC 9207 advises an authorization server to echo `iss` on the authorization
 * response so a client can detect mix-up attacks. It is RECOMMENDED, not
 * required, so its absence is advice — probed only when the resource actually
 * advertises OAuth metadata.
 */
async function oauthIssWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  const resourceMetadata = await fetchJson(
    ctx,
    metadataUrl(ctx.serverUrl, "/.well-known/oauth-protected-resource")
  );
  const authorizationServers = resourceMetadata?.authorization_servers;
  const issuer = Array.isArray(authorizationServers)
    ? authorizationServers[0]
    : undefined;
  if (typeof issuer !== "string") {
    return undefined;
  }

  const asMetadata = await fetchJson(
    ctx,
    metadataUrl(issuer, "/.well-known/oauth-authorization-server")
  );
  if (!asMetadata) {
    return undefined;
  }

  return asMetadata.authorization_response_iss_parameter_supported === true
    ? undefined
    : warning(
        "readiness-oauth-iss-advertised",
        "Authorization Response iss",
        "RECOMMENDED",
        `Authorization server ${issuer} does not advertise authorization_response_iss_parameter_supported; emitting iss lets clients detect authorization-server mix-up attacks`,
        { issuer }
      );
}

/**
 * Readiness advice that only the raw wire (or unauthenticated metadata
 * endpoints) can show. Each probe is independently guarded: readiness is
 * advisory, so a probe that throws contributes nothing and never fails a run.
 */
/**
 * SEP-2243 makes `MCP-Protocol-Version` REQUIRED on every POST and lists a
 * missing standard header among the conditions a server "**MUST** reject …
 * with `400 Bad Request`". It is nonetheless ADVICE and not a check, because
 * the same section grants an explicit escape hatch:
 *
 *   "A server that supports clients implementing protocol versions earlier
 *    than 2025-06-18 … MAY treat a request that omits the header as protocol
 *    version 2025-03-26. A server that does not support such clients MUST
 *    reject a request without the header."
 *
 * Nothing on the wire says which kind of server this is, so a check that
 * demanded rejection would fail conforming legacy-tolerant servers — including
 * the official server SDK, which answers such a request normally. That is
 * exactly the over-strict false positive this program exists to remove, so the
 * observation is reported and never scored.
 *
 * The sibling `modern-missing-method-header-rejected` IS a check: `Mcp-Method`
 * has no carve-out, and the reference implementation rejects without it.
 */
async function protocolVersionHeaderWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era !== "modern") {
    // The header does not exist before 2026-07-28; advising about its absence
    // on a 2025 wire would invent a requirement.
    return undefined;
  }

  const version = ctx.config.protocolVersion ?? "2026-07-28";
  const result = await rawRequest(ctx, {
    // Deliberately NO `MCP-Protocol-Version`, everything else well-formed —
    // `server/discover` is read-only, so a server that processes it anyway has
    // executed nothing.
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": "server/discover",
    },
    body: modernRequestBody({
      id: 9401,
      method: "server/discover",
      protocolVersion: version,
    }),
    timeoutMs: Math.min(ctx.config.checkTimeout, 5_000),
  });

  if (result.status >= 400 || jsonRpcError(result)) {
    // Rejected: the strict reading, and unobjectionable.
    return undefined;
  }

  return informational(
    "readiness-protocol-version-header-required",
    "Protocol Version Header Required",
    "SHOULD",
    `The server answered a POST carrying no MCP-Protocol-Version header with HTTP ${result.status} and no error. SEP-2243 makes the header REQUIRED on every POST; tolerating its absence is permitted only for servers that still support pre-2025-06-18 clients, and it denies intermediaries the routing signal the header exists to provide`,
    { status: result.status }
  );
}

/**
 * SEP-2164's error example carries the requested uri in `error.data`:
 *
 *   { "code": -32602, "message": "Resource not found",
 *     "data": { "uri": "file:///nonexistent.txt" } }
 *
 * ADVICE, at the weakest strength, because the spec shows it and never states
 * it — there is no MUST or SHOULD attached. Promoting an example to a
 * requirement is how a conformance suite acquires false positives, and the
 * `-32602` code itself is already a MUST covered by a real check. What the echo
 * actually buys is diagnosis: a client batching several reads gets an error per
 * request id, and without the uri a human reading a log cannot tell which read
 * failed.
 */
async function resourceErrorUriWarning(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning | undefined> {
  if (ctx.config.era !== "modern") {
    return undefined;
  }
  const version = ctx.config.protocolVersion ?? "2026-07-28";
  const missingUri = `mcpjam-readiness://missing/${version}`;
  const result = await rawRequest(ctx, {
    headers: {
      ...modernHeaders({
        protocolVersion: version,
        method: "resources/read",
        name: missingUri,
      }),
    },
    body: modernRequestBody({
      id: 9402,
      method: "resources/read",
      params: { uri: missingUri },
      protocolVersion: version,
    }),
    timeoutMs: Math.min(ctx.config.checkTimeout, 5_000),
  });

  const error = jsonRpcError(result);
  if (!error) {
    // No error at all is a different finding, and it belongs to the check that
    // asserts the -32602 MUST — not to advice about the error's contents.
    return undefined;
  }
  const data = error.data as { uri?: unknown } | undefined;
  if (typeof data?.uri === "string") {
    return undefined;
  }

  return informational(
    "readiness-resource-error-echoes-uri",
    "Resource Errors Name Their URI",
    "MAY",
    `The server's error for an unreadable resource carries no error.data.uri. The spec's own example echoes it, and without it a client that batches reads cannot tell a human which uri failed`,
    { probedUri: missingUri, jsonRpcCode: error.code }
  );
}

export async function collectRawReadiness(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessWarning[]> {
  const probes = [
    cacheTtlWarning(ctx),
    oauthIssWarning(ctx),
    xMcpHeaderDeclarationsWarning(ctx),
    parseErrorHandlingWarning(ctx),
    sessionTerminationWarning(ctx),
    protocolVersionHeaderWarning(ctx),
    resourceErrorUriWarning(ctx),
  ];
  const settled = await Promise.allSettled(probes);
  return settled.flatMap((outcome) =>
    outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []
  );
}
