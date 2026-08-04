/**
 * Modern-era (2026-07-28) MUST checks — Phase 7 §15.3.
 *
 * Everything here is on the RAW evidence path: each check asserts something
 * only the wire can prove — a header the official client refuses to send, a
 * member the client consumes and hides before app code sees it, or an HTTP
 * status the client folds into an in-band error. The client-provable modern
 * evidence lives with the other client checks (`modern-client-handshake` in
 * `core.ts`).
 *
 * Two authoring rules this module follows everywhere:
 *
 *   1. **HTTP status and in-band JSON-RPC code are SEPARATE facts.** On the
 *      modern wire an HTTP 400 arrives WITH a well-formed JSON-RPC error body,
 *      and the SDK surfaces that body in-band as a `ProtocolError` — so
 *      official-client evidence alone cannot tell "400 + -32020" from
 *      "200 + -32020". Each check asserts both from the capture and reports
 *      them independently, so a failure names which half is wrong.
 *   2. **Hostile framing never goes through a client.**
 *      `TransportSendOptions.headers` skips reserved header names, so a probe
 *      that needs a wrong `Mcp-Method` / `Mcp-Name` / `MCP-Protocol-Version`
 *      MUST build the request itself (see `raw-http.ts`).
 *
 * The spec's HTTP status mapping for ladder-produced errors (the statuses
 * asserted below) is: -32020 HeaderMismatch ⇒ 400, -32022
 * UnsupportedProtocolVersion ⇒ 400, -32021 MissingRequiredClientCapability ⇒
 * 400, -32601 MethodNotFound ⇒ 404. Handler-produced errors (e.g. -32602 for a
 * missing resource) stay in-band on HTTP 200.
 */

import type {
  MCPCheckSkipReason,
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import { CHECK_ERAS } from "../types.js";
import {
  errorMessage,
  eraSkipMessage,
  failedResult,
  passedResult,
  couldNotRunResult,
  notApplicableResult,
} from "./helpers.js";
import {
  jsonRpcError,
  jsonRpcNotifications,
  jsonRpcResult,
  MAX_TOOLS_LIST_PAGES,
  modernHeaders,
  modernRequestBody,
  rawRequest,
  walkToolsList,
  type ToolsListWalkTermination,
  type JsonRpcErrorShape,
  type RawHttpResult,
} from "../raw-http.js";
import { scanXMcpHeaderDeclarations } from "../../mcp-client-manager/mcp-header-mirror.js";
import {
  filterRequests,
  isSubscriptionNotificationMethod,
  observeListenStream,
  subscriptionTagOf,
  LISTEN_METHOD,
  LISTEN_OBSERVATION_WINDOW_MS,
  SUBSCRIPTION_ACK_METHOD,
  type ListenObservation,
  type SubscriptionFilterWire,
  type SubscriptionNotificationMethod,
} from "../raw-listen.js";

/** Wire revision the modern checks frame their probes with when unpinned. */
const MODERN_WIRE_VERSION = "2026-07-28";

/** A protocol version no server supports — for the unsupported-version probe. */
const UNSUPPORTED_WIRE_VERSION = "1999-01-01";

const HEADER_MISMATCH = -32020;
const MISSING_CLIENT_CAPABILITY = -32021;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/**
 * Methods present in the 2025 registry and ABSENT from the 2026 one, i.e.
 * removed by the revision rather than merely unimplemented. `completion/complete`
 * is deliberately NOT here: it survives into 2026, so a -32601 for it means
 * "not implemented", which is not a conformance failure.
 */
const REMOVED_MODERN_METHODS = [
  "initialize",
  "ping",
  "logging/setLevel",
  "resources/subscribe",
  "resources/unsubscribe",
] as const;

/** Result members every cacheable modern result must carry (SEP-2549). */
const CACHE_HINT_FIELDS = ["ttlMs", "cacheScope"] as const;

export type ModernCheckId = keyof typeof MODERN_CHECK_METADATA;

type CheckMeta = Pick<
  MCPCheckResult,
  "id" | "category" | "title" | "description"
>;

const MODERN_CHECK_METADATA = {
  "modern-server-discover": {
    id: "modern-server-discover",
    category: "protocol",
    title: "Modern Server Discovery",
    description:
      "server/discover returns the supported protocol versions, capabilities, and server identity.",
  },
  "modern-result-type-present": {
    id: "modern-result-type-present",
    category: "protocol",
    title: "Modern Result Type",
    description: "Every modern result carries the wire member resultType.",
  },
  "modern-cacheable-result-hints": {
    id: "modern-cacheable-result-hints",
    category: "protocol",
    title: "Cacheable Result Hints",
    description: "Cacheable modern results carry ttlMs and cacheScope.",
  },
  "modern-protocol-version-header-mismatch": {
    id: "modern-protocol-version-header-mismatch",
    category: "protocol",
    title: "Protocol Version Header Mismatch",
    description:
      "A MCP-Protocol-Version header disagreeing with the request envelope is rejected with HTTP 400 and JSON-RPC -32020.",
  },
  "modern-method-header-mismatch": {
    id: "modern-method-header-mismatch",
    category: "protocol",
    title: "Mcp-Method Header Mismatch",
    description:
      "An Mcp-Method header disagreeing with the body method is rejected with HTTP 400 and JSON-RPC -32020.",
  },
  "modern-name-header-mismatch": {
    id: "modern-name-header-mismatch",
    category: "protocol",
    title: "Mcp-Name Header Mismatch",
    description:
      "An Mcp-Name header disagreeing with the body target is rejected with HTTP 400 and JSON-RPC -32020.",
  },
  "modern-unsupported-version-error": {
    id: "modern-unsupported-version-error",
    category: "protocol",
    title: "Unsupported Envelope Version",
    description:
      "An unsupported envelope protocol version is rejected with JSON-RPC -32022 naming the supported versions.",
  },
  "modern-undeclared-capability-error": {
    id: "modern-undeclared-capability-error",
    category: "protocol",
    title: "Undeclared Client Capability",
    description:
      "A server that needs an undeclared client capability for input_required answers JSON-RPC -32021.",
  },
  "modern-removed-methods-not-found": {
    id: "modern-removed-methods-not-found",
    category: "protocol",
    title: "Removed Methods Rejected",
    description:
      "Methods removed by the 2026 revision answer JSON-RPC -32601 with HTTP 404.",
  },
  "modern-resource-not-found-invalid-params": {
    id: "modern-resource-not-found-invalid-params",
    category: "resources",
    title: "Resource Not Found",
    description:
      "Reading an unknown resource answers in-band JSON-RPC -32602 on HTTP 200.",
  },
  "modern-logs-require-log-level": {
    id: "modern-logs-require-log-level",
    category: "core",
    title: "Logs Require A Log Level",
    description:
      "No log notifications are emitted for a request that carried no modern log level.",
  },
  "modern-no-session-id": {
    id: "modern-no-session-id",
    category: "transport",
    title: "No Session Id Minted",
    description: "A modern server never mints an Mcp-Session-Id.",
  },
  "modern-subscription-ack-precedes-notifications": {
    id: "modern-subscription-ack-precedes-notifications",
    category: "transport",
    title: "Subscription Acknowledgement Ordering",
    description:
      "A subscriptions/listen stream acknowledges before it emits any notification.",
  },
  "modern-subscription-filter-and-tagging": {
    id: "modern-subscription-filter-and-tagging",
    category: "transport",
    title: "Subscription Filtering And Tagging",
    description:
      "A subscription emits only the requested notification types and tags every message with the subscription id.",
  },
  "modern-subscription-graceful-close": {
    id: "modern-subscription-graceful-close",
    category: "transport",
    title: "Subscription Graceful Close",
    description:
      "Closing a subscription gracefully returns the subscriptions/listen completion result.",
  },
  // The one modern check that reads as a `tools-*` check in a report. It lives
  // on the RAW path for the same reason as its neighbours: the official client
  // hides exactly the fact it asserts — `Client.listTools()` EXCLUDES tools
  // whose `x-mcp-header` declarations are invalid (that exclusion is itself a
  // SEP-2243 MUST), so a client-backed check would only ever see the survivors
  // and pass vacuously against the servers it exists to catch.
  "tools-x-mcp-header-declarations-valid": {
    id: "tools-x-mcp-header-declarations-valid",
    category: "tools",
    title: "x-mcp-header Declarations Valid",
    description:
      "Every published tool's SEP-2243 x-mcp-header declarations satisfy the spec's constraints: statically reachable through a chain of `properties`, an RFC 9110 token name, a primitive type, and case-insensitively unique.",
  },
} as const satisfies Record<string, CheckMeta>;

/**
 * The three subscription MUST checks, all driven off ONE observed
 * `subscriptions/listen` stream (see `raw-listen.ts`).
 *
 * They are on the raw path for the same reason as their neighbours here: the
 * official client hides exactly the facts they assert. `McpSubscription`
 * surfaces the honored filter and a `closed` promise — not the ORDER of the
 * frames, not the `_meta` subscription-id tag, and not the completion result
 * as a distinct observation. Only the wire proves those.
 */
export const SUBSCRIPTION_CHECK_IDS = [
  "modern-subscription-ack-precedes-notifications",
  "modern-subscription-filter-and-tagging",
  "modern-subscription-graceful-close",
] as const;

function isModernCheckId(id: MCPCheckId): id is ModernCheckId {
  return id in MODERN_CHECK_METADATA;
}

function protocolVersion(ctx: RawHttpCheckContext): string {
  return ctx.config.protocolVersion ?? MODERN_WIRE_VERSION;
}

/** One well-formed modern request, framed exactly as a conforming client would. */
async function modernProbe(
  ctx: RawHttpCheckContext,
  options: {
    id: number;
    method: string;
    params?: Record<string, unknown>;
    name?: string;
    clientCapabilities?: Record<string, unknown>;
    logLevel?: string;
    headerOverrides?: Record<string, string>;
    envelopeVersion?: string;
  }
): Promise<RawHttpResult> {
  const version = protocolVersion(ctx);
  return await rawRequest(ctx, {
    headers: {
      ...modernHeaders({
        protocolVersion: version,
        method: options.method,
        name: options.name,
      }),
      ...(options.headerOverrides ?? {}),
    },
    body: modernRequestBody({
      id: options.id,
      method: options.method,
      params: options.params,
      protocolVersion: options.envelopeVersion ?? version,
      clientCapabilities: options.clientCapabilities,
      logLevel: options.logLevel,
    }),
  });
}

/**
 * Assert the two halves of a ladder-produced rejection independently: the HTTP
 * status the spec's status table assigns, and the in-band JSON-RPC code.
 * Returns the human-readable mismatches (empty ⇒ both facts hold).
 */
function checkRejection(
  result: RawHttpResult,
  expected: { status: number; code: number }
): { problems: string[]; error?: JsonRpcErrorShape } {
  const problems: string[] = [];
  const error = jsonRpcError(result);

  if (result.status !== expected.status) {
    problems.push(
      `expected HTTP ${expected.status}, got HTTP ${result.status}`
    );
  }
  if (!error) {
    problems.push("expected an in-band JSON-RPC error object, got none");
  } else if (error.code !== expected.code) {
    problems.push(
      `expected in-band JSON-RPC code ${expected.code}, got ${error.code}`
    );
  }

  return { problems, error };
}

function rejectionDetails(
  result: RawHttpResult,
  error: JsonRpcErrorShape | undefined
): Record<string, unknown> {
  return {
    httpStatus: result.status,
    jsonRpcCode: error?.code,
    jsonRpcMessage: error?.message,
  };
}

interface ModernRunState {
  /** Every raw exchange the modern track performed, for cross-cutting checks. */
  observed: RawHttpResult[];
  /** The `server/discover` probe, run at most once per run. */
  discover?: RawHttpResult;
  /**
   * The single `subscriptions/listen` observation the three subscription
   * checks share. One stream, three assertions: opening a stream per check
   * would triple the traffic and — worse — let the checks disagree about what
   * the server did, since each stream is a fresh subscription.
   */
  subscription?: Promise<SubscriptionProbe>;
}

async function discoverOnce(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<RawHttpResult> {
  if (!state.discover) {
    state.discover = await track(
      state,
      modernProbe(ctx, { id: 7001, method: "server/discover" })
    );
  }
  return state.discover;
}

async function track(
  state: ModernRunState,
  probe: Promise<RawHttpResult>
): Promise<RawHttpResult> {
  const result = await probe;
  state.observed.push(result);
  return result;
}

function advertisedCapabilities(
  discover: RawHttpResult
): Record<string, unknown> {
  const capabilities = jsonRpcResult(discover)?.capabilities;
  return capabilities !== null && typeof capabilities === "object"
    ? (capabilities as Record<string, unknown>)
    : {};
}

/**
 * Cacheable list methods to probe, gated on advertised capabilities.
 * Capability advertisements OMIT empty `{}` objects on the wire, so presence of
 * the KEY is the only signal — never assert an empty capability object exists.
 */
function cacheableListMethods(capabilities: Record<string, unknown>): string[] {
  const methods: string[] = [];
  if (capabilities.tools !== undefined) methods.push("tools/list");
  if (capabilities.prompts !== undefined) methods.push("prompts/list");
  if (capabilities.resources !== undefined) methods.push("resources/list");
  return methods;
}

/**
 * Where a 2026 server states its identity.
 *
 * `DiscoverResult` has no `serverInfo` member — the 2026 encode seam stamps
 * identity into `_meta` on EVERY result instead (spec PR #3002), so demanding
 * a top-level `serverInfo` here failed every spec-correct server, including
 * ones built on the official server SDK. The top-level read is kept as a
 * lenient fallback: a server that also mirrors it there is not wrong, and a
 * conformance check should not punish the more informative answer.
 */
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

function readServerIdentity(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const meta = payload._meta as Record<string, unknown> | undefined;
  const stamped = meta?.[SERVER_INFO_META_KEY];
  if (stamped !== null && typeof stamped === "object") {
    return stamped as Record<string, unknown>;
  }
  const topLevel = payload.serverInfo;
  return topLevel !== null && typeof topLevel === "object"
    ? (topLevel as Record<string, unknown>)
    : undefined;
}

async function runServerDiscoverCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-server-discover"];
  const startedAt = Date.now();
  const result = await discoverOnce(ctx, state);
  const payload = jsonRpcResult(result);

  if (result.status !== 200 || !payload) {
    return failedResult(
      meta,
      Date.now() - startedAt,
      `server/discover did not return a result (HTTP ${result.status})`,
      {
        httpStatus: result.status,
        jsonRpcCode: jsonRpcError(result)?.code,
      }
    );
  }

  const supportedVersions = payload.supportedVersions;
  const serverInfo = readServerIdentity(payload);
  const problems: string[] = [];

  if (
    !Array.isArray(supportedVersions) ||
    supportedVersions.length === 0 ||
    supportedVersions.some((version) => typeof version !== "string")
  ) {
    problems.push("supportedVersions must be a non-empty array of strings");
  }
  if (
    payload.capabilities === null ||
    typeof payload.capabilities !== "object"
  ) {
    problems.push("capabilities must be an object");
  }
  // Identity is a SHOULD (spec PR #3002), not a member of the result: a
  // present-but-malformed stamp is a real defect, an absent one is not.
  if (
    serverInfo !== undefined &&
    (typeof serverInfo.name !== "string" ||
      typeof serverInfo.version !== "string")
  ) {
    problems.push(
      `${SERVER_INFO_META_KEY} must carry a string name and a string version`
    );
  }

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `server/discover result is incomplete: ${problems.join("; ")}`,
        { httpStatus: result.status, result: payload }
      )
    : passedResult(meta, Date.now() - startedAt, {
        httpStatus: result.status,
        supportedVersions,
        capabilities: Object.keys(
          payload.capabilities as Record<string, unknown>
        ),
        // Reported either way so a silent server is visible in the artifact
        // without being scored as a failure.
        serverInfo: serverInfo ?? null,
      });
}

/**
 * Probe the cacheable surface once and reuse it for both the `resultType` and
 * the cache-hint checks — the two assertions read different members off the
 * same frames, so probing twice would only double the traffic.
 */
async function collectCacheableResults(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<Array<{ method: string; result: RawHttpResult }>> {
  const discover = await discoverOnce(ctx, state);
  const collected: Array<{ method: string; result: RawHttpResult }> = [
    { method: "server/discover", result: discover },
  ];

  let id = 7100;
  for (const method of cacheableListMethods(advertisedCapabilities(discover))) {
    collected.push({
      method,
      result: await track(state, modernProbe(ctx, { id: id++, method })),
    });
  }

  return collected;
}

function runResultTypeCheck(
  probes: Array<{ method: string; result: RawHttpResult }>,
  startedAt: number
): MCPCheckResult {
  const meta = MODERN_CHECK_METADATA["modern-result-type-present"];
  const missing: string[] = [];
  const observed: Record<string, unknown> = {};

  for (const { method, result } of probes) {
    const payload = jsonRpcResult(result);
    if (!payload) {
      continue;
    }
    const resultType = payload.resultType;
    observed[method] = resultType;
    if (typeof resultType !== "string" || resultType.length === 0) {
      missing.push(method);
    }
  }

  if (Object.keys(observed).length === 0) {
    return couldNotRunResult(
      meta,
      "No modern result could be obtained to inspect for resultType"
    );
  }

  return missing.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Modern results are missing the required wire member resultType: ${missing.join(
          ", "
        )}`,
        { resultTypes: observed }
      )
    : passedResult(meta, Date.now() - startedAt, { resultTypes: observed });
}

function runCacheHintsCheck(
  probes: Array<{ method: string; result: RawHttpResult }>,
  startedAt: number
): MCPCheckResult {
  const meta = MODERN_CHECK_METADATA["modern-cacheable-result-hints"];
  const problems: string[] = [];
  const observed: Record<string, unknown> = {};

  for (const { method, result } of probes) {
    const payload = jsonRpcResult(result);
    if (!payload) {
      continue;
    }
    observed[method] = {
      ttlMs: payload.ttlMs,
      cacheScope: payload.cacheScope,
    };
    for (const field of CACHE_HINT_FIELDS) {
      if (payload[field] === undefined) {
        problems.push(`${method} is missing ${field}`);
      }
    }
    if (payload.ttlMs !== undefined && typeof payload.ttlMs !== "number") {
      problems.push(`${method} carries a non-numeric ttlMs`);
    }
    if (
      payload.cacheScope !== undefined &&
      typeof payload.cacheScope !== "string"
    ) {
      problems.push(`${method} carries a non-string cacheScope`);
    }
  }

  if (Object.keys(observed).length === 0) {
    return couldNotRunResult(
      meta,
      "No cacheable modern result could be obtained to inspect"
    );
  }

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Cacheable modern results are missing cache hints: ${problems.join(
          "; "
        )}`,
        { cacheHints: observed }
      )
    : passedResult(meta, Date.now() - startedAt, { cacheHints: observed });
}

async function runProtocolVersionHeaderMismatchCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-protocol-version-header-mismatch"];
  const startedAt = Date.now();
  // The envelope claims the negotiated revision; the header names a DIFFERENT
  // one. Only the raw harness can send this — the client transport refuses to
  // let a caller overwrite a reserved header.
  const result = await track(
    state,
    modernProbe(ctx, {
      id: 7200,
      method: "server/discover",
      headerOverrides: { "MCP-Protocol-Version": "2025-11-25" },
    })
  );

  const { problems, error } = checkRejection(result, {
    status: 400,
    code: HEADER_MISMATCH,
  });

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Mismatched MCP-Protocol-Version header was not rejected as required: ${problems.join(
          "; "
        )}`,
        rejectionDetails(result, error)
      )
    : passedResult(
        meta,
        Date.now() - startedAt,
        rejectionDetails(result, error)
      );
}

async function runMethodHeaderMismatchCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-method-header-mismatch"];
  const startedAt = Date.now();
  const result = await track(
    state,
    modernProbe(ctx, {
      id: 7300,
      method: "server/discover",
      headerOverrides: { "Mcp-Method": "tools/list" },
    })
  );

  const { problems, error } = checkRejection(result, {
    status: 400,
    code: HEADER_MISMATCH,
  });

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Mismatched Mcp-Method header was not rejected as required: ${problems.join(
          "; "
        )}`,
        rejectionDetails(result, error)
      )
    : passedResult(
        meta,
        Date.now() - startedAt,
        rejectionDetails(result, error)
      );
}

/**
 * `Mcp-Name` only applies to a request whose body names a target. The probe
 * deliberately picks a READ-ONLY target (a resource, else a prompt): a
 * conforming server rejects the mismatch pre-dispatch, but a non-conforming one
 * would execute whatever was sent, and a conformance run must not fire
 * arbitrary side-effecting tools at the server under test.
 */
function selectNameHeaderTarget(
  ctx: RawHttpCheckContext,
  discover: RawHttpResult
):
  | { method: string; params: Record<string, unknown>; name: string }
  | undefined {
  const capabilities = advertisedCapabilities(discover);
  const resourceUri = ctx.surface?.resourceUris[0];
  if (resourceUri && capabilities.resources !== undefined) {
    return {
      method: "resources/read",
      params: { uri: resourceUri },
      name: resourceUri,
    };
  }

  const promptName = ctx.surface?.promptNames[0];
  if (promptName && capabilities.prompts !== undefined) {
    return {
      method: "prompts/get",
      params: { name: promptName },
      name: promptName,
    };
  }

  return undefined;
}

async function runNameHeaderMismatchCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-name-header-mismatch"];
  const startedAt = Date.now();
  const target = selectNameHeaderTarget(ctx, await discoverOnce(ctx, state));

  if (!target) {
    return couldNotRunResult(
      meta,
      "Server exposes no read-only named target (resource or prompt) to probe the Mcp-Name header with"
    );
  }

  const result = await track(
    state,
    modernProbe(ctx, {
      id: 7400,
      method: target.method,
      params: target.params,
      name: `mcpjam-conformance-mismatch-${target.name}`,
    })
  );

  const { problems, error } = checkRejection(result, {
    status: 400,
    code: HEADER_MISMATCH,
  });

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Mismatched Mcp-Name header was not rejected as required: ${problems.join(
          "; "
        )}`,
        { ...rejectionDetails(result, error), probedMethod: target.method }
      )
    : passedResult(meta, Date.now() - startedAt, {
        ...rejectionDetails(result, error),
        probedMethod: target.method,
      });
}

async function runUnsupportedVersionCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-unsupported-version-error"];
  const startedAt = Date.now();
  // Header and envelope agree on the unsupported version: they must, or the
  // header-mismatch rung (-32020) answers first and the probe never reaches
  // version negotiation.
  const result = await track(
    state,
    modernProbe(ctx, {
      id: 7500,
      method: "server/discover",
      envelopeVersion: UNSUPPORTED_WIRE_VERSION,
      headerOverrides: { "MCP-Protocol-Version": UNSUPPORTED_WIRE_VERSION },
    })
  );

  const { problems, error } = checkRejection(result, {
    status: 400,
    code: UNSUPPORTED_PROTOCOL_VERSION,
  });

  const data = error?.data as Record<string, unknown> | undefined;
  const supported = data?.supported ?? data?.supportedVersions;
  if (
    !Array.isArray(supported) ||
    supported.length === 0 ||
    supported.some((version) => typeof version !== "string")
  ) {
    problems.push(
      "error data must name the supported protocol versions as a non-empty array of strings"
    );
  }

  const details = {
    ...rejectionDetails(result, error),
    supportedVersions: supported,
  };

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Unsupported envelope version was not rejected as required: ${problems.join(
          "; "
        )}`,
        details
      )
    : passedResult(meta, Date.now() - startedAt, details);
}

async function runUndeclaredCapabilityCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-undeclared-capability-error"];
  const startedAt = Date.now();
  const probe = ctx.config.inputRequiredProbe;

  if (!probe) {
    return couldNotRunResult(
      meta,
      "No inputRequiredProbe configured: set inputRequiredProbe.toolName to a tool that requests input so the check can prove the -32021 rejection"
    );
  }

  // Declared capabilities are deliberately EMPTY: that is the condition under
  // test. A server that needs `elicitation` (or any other client capability) to
  // serve `input_required` must answer -32021 instead of asking anyway.
  const result = await track(
    state,
    modernProbe(ctx, {
      id: 7600,
      method: "tools/call",
      params: { name: probe.toolName, arguments: probe.arguments ?? {} },
      name: probe.toolName,
      clientCapabilities: {},
    })
  );

  const payload = jsonRpcResult(result);
  if (payload?.resultType === "input_required") {
    return failedResult(
      meta,
      Date.now() - startedAt,
      "Server requested input although the request declared no client capabilities; it must answer JSON-RPC -32021 instead",
      { httpStatus: result.status, resultType: payload.resultType }
    );
  }

  if (payload) {
    return couldNotRunResult(
      meta,
      `Tool "${probe.toolName}" completed without requesting input, so the undeclared-capability path was never exercised`,
      { httpStatus: result.status, resultType: payload.resultType }
    );
  }

  const { problems, error } = checkRejection(result, {
    status: 400,
    code: MISSING_CLIENT_CAPABILITY,
  });

  const data = error?.data as Record<string, unknown> | undefined;
  if (
    error?.code === MISSING_CLIENT_CAPABILITY &&
    !data?.requiredCapabilities
  ) {
    problems.push("error data must name the requiredCapabilities");
  }

  const details = {
    ...rejectionDetails(result, error),
    requiredCapabilities: data?.requiredCapabilities,
    probedTool: probe.toolName,
  };

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Undeclared client capability was not rejected as required: ${problems.join(
          "; "
        )}`,
        details
      )
    : passedResult(meta, Date.now() - startedAt, details);
}

async function runRemovedMethodsCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-removed-methods-not-found"];
  const startedAt = Date.now();
  const problems: string[] = [];
  const observed: Record<string, unknown> = {};

  let id = 7700;
  for (const method of REMOVED_MODERN_METHODS) {
    const result = await track(state, modernProbe(ctx, { id: id++, method }));
    const { problems: methodProblems, error } = checkRejection(result, {
      status: 404,
      code: METHOD_NOT_FOUND,
    });
    observed[method] = {
      httpStatus: result.status,
      jsonRpcCode: error?.code,
    };
    for (const problem of methodProblems) {
      problems.push(`${method}: ${problem}`);
    }
  }

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Methods removed by the 2026 revision were not rejected as required: ${problems.join(
          "; "
        )}`,
        { removedMethods: observed }
      )
    : passedResult(meta, Date.now() - startedAt, { removedMethods: observed });
}

async function runResourceNotFoundCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta =
    MODERN_CHECK_METADATA["modern-resource-not-found-invalid-params"];
  const startedAt = Date.now();
  const capabilities = advertisedCapabilities(await discoverOnce(ctx, state));

  if (capabilities.resources === undefined) {
    return notApplicableResult(
      meta,
      "Server does not advertise the resources capability"
    );
  }

  const missingUri = `mcpjam-conformance://missing/${Date.now()}`;
  const result = await track(
    state,
    modernProbe(ctx, {
      id: 7800,
      method: "resources/read",
      params: { uri: missingUri },
      name: missingUri,
    })
  );

  const error = jsonRpcError(result);
  const problems: string[] = [];
  // A handler-produced error stays in-band on HTTP 200 in the modern era; the
  // status and the code are asserted as separate facts.
  if (result.status !== 200) {
    problems.push(
      `expected HTTP 200 (in-band error), got HTTP ${result.status}`
    );
  }
  if (!error) {
    problems.push("expected an in-band JSON-RPC error object, got none");
  } else if (error.code !== INVALID_PARAMS) {
    problems.push(
      `expected in-band JSON-RPC code ${INVALID_PARAMS}, got ${error.code}`
    );
  }

  const details = { ...rejectionDetails(result, error), probedUri: missingUri };

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Reading an unknown resource was not rejected as required: ${problems.join(
          "; "
        )}`,
        details
      )
    : passedResult(meta, Date.now() - startedAt, details);
}

async function runLogLevelCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-logs-require-log-level"];
  const startedAt = Date.now();
  const probe = ctx.config.logProbe;

  // Deliberately NO log level in the envelope: the modern era carries the
  // logging opt-in per request, so a request without one must produce no log
  // records at all. With a `logProbe` the request is a tool the operator says
  // DOES log, which turns "no records" from an absence into evidence.
  const silent = await track(
    state,
    probe
      ? modernProbe(ctx, {
          id: 7900,
          method: "tools/call",
          params: { name: probe.toolName, arguments: probe.arguments ?? {} },
          name: probe.toolName,
        })
      : modernProbe(ctx, { id: 7900, method: "server/discover" })
  );

  const unrequested = logRecords(silent);
  if (unrequested.length > 0) {
    return failedResult(
      meta,
      Date.now() - startedAt,
      `Server emitted ${unrequested.length} log notification(s) for a request that carried no modern log level`,
      {
        logNotificationCount: unrequested.length,
        probedTool: probe?.toolName,
      }
    );
  }

  if (!probe) {
    return passedResult(meta, Date.now() - startedAt, {
      logNotificationCount: 0,
      evidence:
        "No logProbe configured: asserted against an ordinary request, which cannot show the server logs at all",
    });
  }

  // Positive control: the SAME call carrying a log level. Records here prove
  // the silence above was the opt-in gate working, not a server that never
  // logs. Their absence is not a MUST violation, so it is reported, not failed.
  const requested = await track(
    state,
    modernProbe(ctx, {
      id: 7901,
      method: "tools/call",
      params: { name: probe.toolName, arguments: probe.arguments ?? {} },
      name: probe.toolName,
      logLevel: "debug",
    })
  );

  return passedResult(meta, Date.now() - startedAt, {
    logNotificationCount: 0,
    probedTool: probe.toolName,
    logNotificationCountWithLevel: logRecords(requested).length,
  });
}

/** `notifications/message` records carried on a response. */
function logRecords(result: RawHttpResult): Array<Record<string, unknown>> {
  return jsonRpcNotifications(result).filter(
    (notification) => notification.method === "notifications/message"
  );
}

async function runNoSessionIdCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-no-session-id"];
  const startedAt = Date.now();
  // Inspect every response this run already collected; probe once if this is
  // the only selected check.
  if (state.observed.length === 0) {
    await discoverOnce(ctx, state);
  }

  const offenders = state.observed
    .filter((result) => result.headers["mcp-session-id"] !== undefined)
    .map((result) => ({
      status: result.status,
      sessionId: result.headers["mcp-session-id"],
    }));

  return offenders.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        "Server minted an Mcp-Session-Id on a modern response; the 2026 era is sessionless",
        { offenders, inspectedResponses: state.observed.length }
      )
    : passedResult(meta, Date.now() - startedAt, {
        inspectedResponses: state.observed.length,
      });
}

/**
 * Outcome of the shared subscription probe: either an observed stream, or a
 * reason none could be observed. A reason is always a SKIP for all three
 * checks — "this server has nothing to subscribe to" and "this server would
 * not open a stream" are not violations of the three MUSTs asserted here, and
 * a check that failed on them would be reporting a conformance failure it did
 * not observe.
 */
/**
 * Forward the probe's own classification: one call site funnels three distinct
 * unavailable reasons, and only the "nothing subscribable advertised" one is
 * genuinely inapplicable. Hardcoding either value here would mislabel two of
 * the three.
 */
function skippedFromProbe(
  check: Parameters<typeof notApplicableResult>[0],
  reason: string,
  skipReason: MCPCheckSkipReason,
  details?: Record<string, unknown>,
): MCPCheckResult {
  return skipReason === "could-not-run"
    ? couldNotRunResult(check, reason, details)
    : notApplicableResult(check, reason, details);
}

type SubscriptionProbe =
  | { kind: "observed"; observation: ListenObservation }
  | {
      kind: "unavailable";
      reason: string;
      /**
       * Why the probe yielded nothing. A server that advertises nothing
       * subscribable has no obligation to test; one that refused to open a
       * stream, or whose stream could not be read, leaves the subscription
       * MUSTs untested.
       */
      skipReason: MCPCheckSkipReason;
      details?: Record<string, unknown>;
    };

/**
 * The filter to request, derived from what the server ADVERTISES. Asking for
 * a notification type the server never advertised would make the honored
 * filter narrower than the requested one for a legitimate reason, muddying
 * the filtering assertion; asking for exactly the advertised set keeps
 * "requested" and "should be honored" the same thing.
 */
function subscribableFilter(
  ctx: RawHttpCheckContext,
  discover: RawHttpResult
): SubscriptionFilterWire {
  const capabilities = advertisedCapabilities(discover);
  const listChanged = (key: "tools" | "prompts" | "resources"): boolean => {
    const capability = capabilities[key];
    return (
      capability !== null &&
      typeof capability === "object" &&
      (capability as Record<string, unknown>).listChanged === true
    );
  };
  const resources = capabilities.resources as
    | Record<string, unknown>
    | undefined;
  const watchedUri = ctx.surface?.resourceUris[0];

  return {
    ...(listChanged("tools") ? { toolsListChanged: true } : {}),
    ...(listChanged("prompts") ? { promptsListChanged: true } : {}),
    ...(listChanged("resources") ? { resourcesListChanged: true } : {}),
    ...(resources?.subscribe === true && watchedUri
      ? { resourceSubscriptions: [watchedUri] }
      : {}),
  };
}

function isEmptyFilter(filter: SubscriptionFilterWire): boolean {
  return (
    !filter.toolsListChanged &&
    !filter.promptsListChanged &&
    !filter.resourcesListChanged &&
    (filter.resourceSubscriptions?.length ?? 0) === 0
  );
}

async function probeSubscription(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<SubscriptionProbe> {
  const filter = subscribableFilter(ctx, await discoverOnce(ctx, state));
  if (isEmptyFilter(filter)) {
    return {
      kind: "unavailable",
      skipReason: "not-applicable",
      reason: `Server advertises no subscribable notification type (tools/prompts/resources listChanged, or resources.subscribe with a listed resource), so no ${LISTEN_METHOD} stream can be opened`,
    };
  }

  const observation = await observeListenStream(ctx, {
    id: 8000,
    filter,
    protocolVersion: protocolVersion(ctx),
    maxMs: Math.min(ctx.config.checkTimeout, LISTEN_OBSERVATION_WINDOW_MS),
  });

  if (observation.outcome === "not-a-stream") {
    const code = (
      observation.json as { error?: { code?: unknown } } | undefined
    )?.error?.code;
    return {
      kind: "unavailable",
      skipReason: "could-not-run",
      reason: `Server did not open a ${LISTEN_METHOD} stream (HTTP ${observation.status}, content-type "${observation.contentType}"), so the subscription MUSTs could not be observed`,
      details: { httpStatus: observation.status, jsonRpcCode: code },
    };
  }
  if (observation.outcome === "stream-error") {
    return {
      kind: "unavailable",
      skipReason: "could-not-run",
      reason: `The ${LISTEN_METHOD} stream could not be read to a stopping point (${observation.streamError}); reported as a skip rather than a conformance failure`,
      details: { httpStatus: observation.status },
    };
  }

  return { kind: "observed", observation };
}

function subscriptionOnce(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<SubscriptionProbe> {
  state.subscription ??= probeSubscription(ctx, state);
  return state.subscription;
}

/** The change notifications the stream carried, in wire order. */
function subscriptionNotifications(observation: ListenObservation): Array<{
  index: number;
  method: SubscriptionNotificationMethod;
  message: Record<string, unknown>;
}> {
  return observation.messages.flatMap((message, index) =>
    typeof message.method === "string" &&
    isSubscriptionNotificationMethod(message.method)
      ? [{ index, method: message.method, message }]
      : []
  );
}

function observationDetails(
  observation: ListenObservation
): Record<string, unknown> {
  return {
    subscriptionId: observation.subscriptionId,
    requestedFilter: observation.requestedFilter,
    messageCount: observation.messages.length,
    streamOutcome: observation.outcome,
    observedMs: observation.observedMs,
  };
}

async function runSubscriptionAckOrderingCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta =
    MODERN_CHECK_METADATA["modern-subscription-ack-precedes-notifications"];
  const startedAt = Date.now();
  const probe = await subscriptionOnce(ctx, state);
  if (probe.kind === "unavailable") {
    return skippedFromProbe(meta, probe.reason, probe.skipReason, probe.details);
  }

  const { observation } = probe;
  const ackIndex = observation.messages.findIndex(
    (message) => message.method === SUBSCRIPTION_ACK_METHOD
  );
  const notifications = subscriptionNotifications(observation);
  const firstNotification = notifications[0];
  const details = {
    ...observationDetails(observation),
    ackIndex,
    firstNotificationIndex: firstNotification?.index ?? -1,
  };

  if (ackIndex === -1 && notifications.length === 0) {
    return couldNotRunResult(
      meta,
      `The ${LISTEN_METHOD} stream carried neither an acknowledgement nor a notification within ${observation.observedMs}ms, so the ordering MUST was never exercised`,
      details
    );
  }
  if (ackIndex === -1) {
    return failedResult(
      meta,
      Date.now() - startedAt,
      `Server emitted ${notifications.length} subscription notification(s) but never sent ${SUBSCRIPTION_ACK_METHOD}`,
      details
    );
  }
  if (firstNotification && firstNotification.index < ackIndex) {
    return failedResult(
      meta,
      Date.now() - startedAt,
      `Server emitted ${firstNotification.method} before ${SUBSCRIPTION_ACK_METHOD} (notification at frame ${firstNotification.index}, acknowledgement at frame ${ackIndex})`,
      details
    );
  }

  return passedResult(meta, Date.now() - startedAt, {
    ...details,
    notificationCount: notifications.length,
    acknowledgedFilter: (
      observation.messages[ackIndex] as { params?: Record<string, unknown> }
    ).params?.notifications,
  });
}

async function runSubscriptionFilterAndTaggingCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-subscription-filter-and-tagging"];
  const startedAt = Date.now();
  const probe = await subscriptionOnce(ctx, state);
  if (probe.kind === "unavailable") {
    return skippedFromProbe(meta, probe.reason, probe.skipReason, probe.details);
  }

  const { observation } = probe;
  if (observation.messages.length === 0) {
    return couldNotRunResult(
      meta,
      `The ${LISTEN_METHOD} stream carried no message within ${observation.observedMs}ms, so neither filtering nor tagging could be observed`,
      observationDetails(observation)
    );
  }

  const problems: string[] = [];
  const untagged: Array<{ index: number; method: unknown; tag: unknown }> = [];

  for (const [index, message] of observation.messages.entries()) {
    const tag = subscriptionTagOf(message);
    // A server that stamps the id as a string still identifies the stream
    // unambiguously; only a MISSING or DIFFERENT id is a violation.
    if (
      tag === undefined ||
      String(tag) !== String(observation.subscriptionId)
    ) {
      untagged.push({
        index,
        method: message.method ?? "(result)",
        tag,
      });
    }
  }
  if (untagged.length > 0) {
    problems.push(
      `${untagged.length} message(s) were not tagged with the subscription id ${observation.subscriptionId}`
    );
  }

  const unrequested = subscriptionNotifications(observation).filter(
    ({ method, message }) =>
      !filterRequests(
        observation.requestedFilter,
        method,
        (message.params as { uri?: unknown } | undefined)?.uri
      )
  );
  if (unrequested.length > 0) {
    problems.push(
      `${
        unrequested.length
      } notification(s) were of a type the subscription never requested: ${[
        ...new Set(unrequested.map(({ method }) => method)),
      ].join(", ")}`
    );
  }

  const details = {
    ...observationDetails(observation),
    notificationMethods: subscriptionNotifications(observation).map(
      ({ method }) => method
    ),
    untaggedMessages: untagged,
  };

  return problems.length > 0
    ? failedResult(
        meta,
        Date.now() - startedAt,
        `Subscription stream violated the filtering/tagging MUST: ${problems.join(
          "; "
        )}`,
        details
      )
    : passedResult(meta, Date.now() - startedAt, details);
}

async function runSubscriptionGracefulCloseCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["modern-subscription-graceful-close"];
  const startedAt = Date.now();
  const probe = await subscriptionOnce(ctx, state);
  if (probe.kind === "unavailable") {
    return skippedFromProbe(meta, probe.reason, probe.skipReason, probe.details);
  }

  const { observation } = probe;
  const details = {
    ...observationDetails(observation),
    completionResult: observation.completionResult,
  };

  if (observation.outcome === "completed") {
    return passedResult(meta, Date.now() - startedAt, details);
  }
  if (observation.outcome === "stream-ended") {
    // The body ended cleanly: the server chose to end the subscription, and
    // the completion result is what the spec says that choice looks like on
    // the wire. An UNCLEAN end never reaches here — it is a `stream-error`,
    // which the probe reports as a skip.
    return failedResult(
      meta,
      Date.now() - startedAt,
      `Server closed the ${LISTEN_METHOD} stream without returning the completion result for subscription ${observation.subscriptionId}`,
      details
    );
  }

  return couldNotRunResult(
    meta,
    `The subscription was still open after ${observation.observedMs}ms. A graceful close is server-initiated, so a client-side probe cannot induce one; reported as a skip rather than a failure`,
    details
  );
}

async function runModernCheck(
  id: ModernCheckId,
  ctx: RawHttpCheckContext,
  state: ModernRunState,
  cacheableProbes: () => Promise<
    Array<{ method: string; result: RawHttpResult }>
  >
): Promise<MCPCheckResult> {
  const startedAt = Date.now();
  switch (id) {
    case "modern-server-discover":
      return await runServerDiscoverCheck(ctx, state);
    case "modern-result-type-present":
      return runResultTypeCheck(await cacheableProbes(), startedAt);
    case "modern-cacheable-result-hints":
      return runCacheHintsCheck(await cacheableProbes(), startedAt);
    case "modern-protocol-version-header-mismatch":
      return await runProtocolVersionHeaderMismatchCheck(ctx, state);
    case "modern-method-header-mismatch":
      return await runMethodHeaderMismatchCheck(ctx, state);
    case "modern-name-header-mismatch":
      return await runNameHeaderMismatchCheck(ctx, state);
    case "modern-unsupported-version-error":
      return await runUnsupportedVersionCheck(ctx, state);
    case "modern-undeclared-capability-error":
      return await runUndeclaredCapabilityCheck(ctx, state);
    case "modern-removed-methods-not-found":
      return await runRemovedMethodsCheck(ctx, state);
    case "modern-resource-not-found-invalid-params":
      return await runResourceNotFoundCheck(ctx, state);
    case "modern-logs-require-log-level":
      return await runLogLevelCheck(ctx, state);
    case "modern-no-session-id":
      return await runNoSessionIdCheck(ctx, state);
    case "modern-subscription-ack-precedes-notifications":
      return await runSubscriptionAckOrderingCheck(ctx, state);
    case "modern-subscription-filter-and-tagging":
      return await runSubscriptionFilterAndTaggingCheck(ctx, state);
    case "modern-subscription-graceful-close":
      return await runSubscriptionGracefulCloseCheck(ctx, state);
    case "tools-x-mcp-header-declarations-valid":
      return await runXMcpHeaderDeclarationsCheck(ctx, state);
  }
}

/**
 * SEP-2243: `x-mcp-header` declarations are part of a tool DEFINITION's
 * validity, not of any one call — a client "MUST treat the tool definition as
 * invalid" (and exclude it from `tools/list`) when a declaration breaks any
 * constraint. So a server that publishes one has effectively hidden that tool
 * from every conforming client, and no `tools/call` will ever surface it.
 *
 * Raw, and unavoidably so: the official client applies that same exclusion
 * before app code sees the listing, so a check reading `manager.listTools()`
 * would be handed only the survivors and would pass against precisely the
 * servers it exists to catch. The wire is the only place the offenders exist.
 *
 * Read-only by construction: one `tools/list`, no tool is ever called, so this
 * is safe against a server with side-effecting tools. Pagination is walked to
 * the end — an offender on page 3 is just as invisible as one on page 1.
 */
async function runXMcpHeaderDeclarationsCheck(
  ctx: RawHttpCheckContext,
  state: ModernRunState
): Promise<MCPCheckResult> {
  const meta = MODERN_CHECK_METADATA["tools-x-mcp-header-declarations-valid"];
  const startedAt = Date.now();

  const discover = await discoverOnce(ctx, state);
  if (advertisedCapabilities(discover).tools === undefined) {
    return notApplicableResult(meta, "Server does not advertise the tools capability");
  }

  // Shared with the readiness sibling: one bounded, cycle-safe walk, so a
  // cursor bug cannot exist in one and not the other.
  const walk = await walkToolsList({
    startId: 7300,
    request: ({ id, cursor }) =>
      track(
        state,
        modernProbe(ctx, {
          id,
          method: "tools/list",
          ...(cursor !== undefined ? { params: { cursor } } : {}),
        })
      ),
  });

  if (walk.malformedPage && walk.tools.length === 0) {
    return failedResult(
      meta,
      Date.now() - startedAt,
      "tools/list did not return a tools array",
      { pagesRead: walk.pagesRead }
    );
  }

  const violations: Array<{ tool: string; reason: string }> = [];
  let declaringTools = 0;
  for (const entry of walk.tools) {
    if (entry.inputSchema === undefined) continue;
    const scan = scanXMcpHeaderDeclarations(entry.inputSchema);
    if (!scan.valid) {
      violations.push({
        tool: typeof entry.name === "string" ? entry.name : "<unnamed>",
        reason: scan.reason,
      });
    } else if (scan.declarations.length > 0) {
      declaringTools += 1;
    }
  }
  const toolCount = walk.tools.length;
  const pagesRead = walk.pagesRead;
  // `complete` is the ONLY termination that licenses a pass — the others mean
  // tools were left unread, and certifying a MUST over a partial listing would
  // be a claim the evidence does not support. A malformed page or cursor also
  // terminates as non-`complete` inside the walk, so this needs no adjustment.
  const termination: ToolsListWalkTermination = walk.termination;

  // Violations found on the pages we DID read are real regardless of how the
  // walk ended — report them first, and say the coverage was partial.
  if (violations.length > 0) {
    return failedResult(
      meta,
      Date.now() - startedAt,
      // The consequence is severe enough to name in the message: a conforming
      // client does not merely skip the header, it drops the whole tool.
      `${violations.length} tool(s) carry invalid x-mcp-header declarations; a conforming client MUST treat those tool definitions as invalid and exclude them from tools/list: ${violations
        .map((entry) => `${entry.tool} (${entry.reason})`)
        .join(", ")}${
        termination === "complete"
          ? ""
          : ` (note: the tools/list walk ended early — ${terminationReason(termination)} — so further tools were not scanned)`
      }`,
      { violations, toolCount, termination, pagesRead }
    );
  }

  if (termination !== "complete") {
    // No violations among the tools we could read, but we did not read them
    // all. "Passed" would certify coverage the run never achieved, and an
    // offender on an unreachable page would be silently blessed. A skip is the
    // honest verdict: the MUST was not established either way.
    return couldNotRunResult(
      meta,
      `Could not enumerate every tool: ${terminationReason(termination)}. The declarations on ${toolCount} scanned tool(s) are valid, but the rest were unreachable.`,
      { toolCount, declaringTools, termination, pagesRead }
    );
  }

  return passedResult(meta, Date.now() - startedAt, {
    toolCount,
    declaringTools,
  });
}

function terminationReason(termination: ToolsListWalkTermination): string {
  return termination === "repeated-cursor"
    ? "tools/list reissued a cursor it had already handed out instead of advancing"
    : `the ${MAX_TOOLS_LIST_PAGES}-page walk limit was reached (or a page came back malformed)`;
}

/**
 * Run the selected modern checks. Ordering follows {@link MCP_CHECK_IDS} so a
 * report reads the same way every time; `server/discover` and the cacheable
 * probes are each performed at most once and shared.
 */
export async function runModernChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>
): Promise<MCPCheckResult[]> {
  const requested = [...selectedCheckIds].filter(isModernCheckId);
  if (requested.length === 0) {
    return [];
  }

  const results: MCPCheckResult[] = [];
  const applicable: ModernCheckId[] = [];
  for (const id of requested) {
    if (CHECK_ERAS[id].includes(ctx.config.era)) {
      applicable.push(id);
    } else {
      // Era gate through CHECK_ERAS, exactly like the other raw runners: on a
      // legacy run every modern check is a deterministic skip and no HTTP is
      // attempted, which is what keeps a legacy report byte-identical.
      results.push(
        notApplicableResult(
          MODERN_CHECK_METADATA[id],
          eraSkipMessage(ctx.config.era, ctx.config.protocolVersion)
        )
      );
    }
  }

  if (applicable.length === 0) {
    return results;
  }

  const state: ModernRunState = { observed: [] };
  let cacheable: Array<{ method: string; result: RawHttpResult }> | undefined;
  const cacheableProbes = async () => {
    cacheable ??= await collectCacheableResults(ctx, state);
    return cacheable;
  };

  // `modern-no-session-id` inspects the responses every other modern check
  // already collected, so it runs last regardless of selection order.
  const ordered = [
    ...applicable.filter((id) => id !== "modern-no-session-id"),
    ...applicable.filter((id) => id === "modern-no-session-id"),
  ];

  for (const id of ordered) {
    const startedAt = Date.now();
    try {
      results.push(await runModernCheck(id, ctx, state, cacheableProbes));
    } catch (error) {
      results.push(
        failedResult(
          MODERN_CHECK_METADATA[id],
          Date.now() - startedAt,
          errorMessage(error),
          undefined,
          error
        )
      );
    }
  }

  return results;
}

export const MODERN_CHECK_IDS = Object.keys(
  MODERN_CHECK_METADATA
) as ModernCheckId[];

export { MODERN_CHECK_METADATA };
