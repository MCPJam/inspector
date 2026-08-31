import type { ErrorOrigin } from "@mcpjam/sdk";
import type { RouteFailureHop } from "./route-error-report.js";

export type Environment =
  | "prod"
  | "staging"
  | "preview"
  | "dev"
  | "local"
  | "test";

export type AuthType = "signedIn" | "guest" | "system" | "unknown";

export type ProjectRole =
  | "owner"
  | "admin"
  | "member"
  | "guest"
  | "editor"
  | "chat";

export type AccessLevel = "project_member" | "shared_chat";
export type Surface = "preview" | "share_link";
export type ServerTransport = "stdio" | "http";

interface CommonLogContext {
  event: LogEventName;
  timestamp: string;
  environment: Environment;
  release: string | null;
  component: string;
  durationMs?: number;

  authType: AuthType;
  /**
   * Whether the caller presented a bearer credential AT ALL, set by
   * `bearerAuthMiddleware` on every route it fronts. This is not "was the
   * caller authorized" — an invalid key, an unknown user and an orphaned key
   * are all `true`. It answers the one question a 401 count cannot: did
   * somebody's credential fail, or did nobody send one?
   *
   * The distinction is the difference between a customer outage and
   * background noise. A contracted pentest sweep (or any scanner) walks the
   * public API with no `Authorization` header and produces hundreds of
   * perfectly correct 401s; a real auth incident produces 401s from callers
   * who DID present something. Without this field both fingerprint as
   * "route 401" and the 4xx storm monitor cannot tell them apart — which is
   * exactly what happened on 2026-08-18, where a scan tripped the WARN and
   * triage had no query that could name the caller.
   *
   * Absent on routes that do not run `bearerAuthMiddleware`; monitors must
   * treat null as "unknown", never as "no credential".
   */
  credentialPresented?: boolean | null;
  userId?: string | null;
  userExternalId?: string | null;
  guestExternalId?: string | null;
  emailDomain?: string | null;
  orgId?: string | null;
  orgPlan?: string | null;
  orgSeatQuantity?: number | null;
  orgCreatedBy?: string | null;
  projectId?: string | null;
  projectRole?: ProjectRole | null;
  accessLevel?: AccessLevel | null;
  serverId?: string | null;
  sessionId?: string | null;
  scenarioId?: string | null;
  surface?: Surface | null;
  serverTransport?: ServerTransport | null;
  statusCode?: number | null;
}

export interface RequestLogContext extends CommonLogContext {
  requestId: string;
  route: string;
  method: string;
}

export interface SystemLogContext extends CommonLogContext {
  requestId: null;
  route: null;
  method: null;
  authType: "system" | "unknown";
}

export type BaseLogContext = RequestLogContext | SystemLogContext;

/**
 * A failure that HTTP status cannot see: an SSE `{type:"error"}` chunk after
 * 200 headers, or a JSON-RPC error envelope returned over HTTP 200. The
 * middleware's streaming branch returns before any `http.request.failed` /
 * `http.request.completed` emission, so a request gets exactly one of the
 * HTTP events OR (possibly) this one — never both. Registered in BOTH event
 * maps: chat requests emit through `getRequestLogger` (full request
 * envelope), while evals/swarm engine runs emit through `getSystemLogger`
 * (`requestId: null`, omitted-not-fabricated).
 *
 * Emitted only via `server/utils/stream-failure-reporter.ts`, which runs
 * `reportRouteFailure` first — so `origin` here is always the EFFECTIVE
 * value the Sentry capture decision was made on (post `mcpjam_internal`
 * promotion), the same axis as `http.request.failed.origin`.
 */
type RouteOperationFailedFields = {
  /** How the failure was carried to the client. */
  transport: "http_stream" | "rpc_envelope";
  /**
   * Stable catch-site id, e.g. "mcp.chat-v2.backend-stream". The same string
   * `reportRouteFailure` tags Sentry with (as `route:${source}`).
   */
  source: string;
  /**
   * Whose hop failed, as declared at the call site.
   *
   * Imported from `route-error-report.ts` rather than re-listed. A hand-copied
   * union here is a literal list `tsc` only checks at the ONE call site that
   * builds this payload — every other consumer (an APL query, a monitor
   * predicate) silently disagrees with the source of truth, and a new hop
   * looks like a compile error in the reporter rather than in this file.
   */
  hop: RouteFailureHop;
  /** Effective origin from the capture decision — see the doc block above. */
  origin: ErrorOrigin;
  /** Catalog slug behind `origin`, e.g. `transport/econnrefused`. */
  slug?: string;
  /**
   * Structured code when one exists: a backend denial code
   * ("user_rate_limit"), a JSON-RPC error code as a string ("-32000"), or a
   * route ErrorCode. Omitted otherwise.
   */
  errorCode?: string;
  /** Capped at 500 chars; scrubbed by scrubLogPayload on emit. */
  errorMessage: string;
  /** rpc_envelope only: the JSON-RPC method that failed ("tools/call", …). */
  rpcMethod?: string;
};

export type RequestEventMap = {
  /**
   * 4xx responses land here, not on `http.request.failed` — a 4xx is a
   * declared client outcome, not a server failure. But "declared outcome"
   * does not mean "uninteresting": an abnormal RATE of one class (the 401
   * half of the 2026-08-06 incident, a 429 storm from our own guard) is an
   * incident signal, and the class monitors fingerprint on
   * `coalesce(errorMessage, errorCode, route+status)`. The optional error
   * fields below exist so 4xx classes are sliceable by typed code and
   * origin instead of collapsing into one `route 401` bucket per route.
   * They are populated only for status >= 400.
   */
  "http.request.completed": {
    statusCode: number;
    errorCode?: string;
    errorMessage?: string;
    origin?: ErrorOrigin;
    slug?: string;
  };
  /**
   * `errorCode` is the route's own `ErrorCode` (SERVER_UNREACHABLE, TIMEOUT, …)
   * whenever one is known, and only falls back to a `classifyError` bucket for
   * genuinely uncaught throws. `errorMessage` carries the scrubbed text —
   * without it a 5xx is only ever "something failed", which is what made the
   * hosted connect 502s undiagnosable.
   */
  "http.request.failed": {
    statusCode: number;
    errorCode: string;
    errorMessage?: string;
    /**
     * Whose fault the failure was, per the SDK error-origin taxonomy, when
     * the failing route produced a normalized describe-error block.
     *
     * This is the measurement half of the error-origin work. Sentry capture is
     * deliberately restricted to `origin: "mcpjam"`; every other bucket —
     * above all `ambiguous`, which holds the whole timeout/reset/fetch-failure
     * family — is counted here instead, at no issue-tracker cost. Promoting a
     * bucket into the paging path should be argued from this field.
     */
    origin?: ErrorOrigin;
    /** Catalog slug behind `origin`, e.g. `transport/econnrefused`. */
    slug?: string;
  };
  "http.stream.opened": { statusCode: number };
  /**
   * Lifecycle, not failure: every wrapped stream emits exactly one of these,
   * whatever ends it. `outcome` is the only record of HOW a streaming
   * response died — the middleware's streaming branch returns before any
   * `http.request.failed`/`completed` emission, and a producer error or a
   * client disconnect used to skip the old flush()-only hook entirely,
   * leaving zero rows for the most common streaming failure. Aborts are
   * deliberately an `outcome` here and never a failure event: a user closing
   * a tab is normal operation, but its rate is a useful denominator.
   */
  "http.stream.closed": {
    statusCode: number;
    durationMs: number;
    outcome: "completed" | "aborted" | "errored";
    /** errored only; capped at 500 chars, scrubbed on emit. */
    errorMessage?: string;
  };
  "mcp.oauth.proxy.failed": {
    targetUrlHost: string;
    oauthPhase: "metadata" | "proxy" | "token";
    errorCode: string;
    statusCode?: number;
  };
  "tunnel.created": {
    tunnelKind: "shared" | "server";
    tunnelDomain: string;
    existed: boolean;
    credentialIdPresent?: boolean;
  };
  "tunnel.creation_failed": {
    tunnelKind: "shared" | "server";
    errorCode: string;
    credentialIdPresent?: boolean;
    tunnelDomain?: string;
  };
  "tunnel.record_failed": {
    tunnelKind: "shared" | "server";
    tunnelDomain?: string;
    errorCode: string;
  };
  "tunnel.rotated": {
    tunnelKind: "shared" | "server";
    tunnelDomain?: string;
    full?: boolean;
  };
  "tunnel.rotation_failed": {
    tunnelKind: "shared" | "server";
    errorCode: string;
    tunnelDomain?: string;
  };
  // One event per JSON-RPC request arriving through an active tunnel
  // (never for local UI calls). `path` is scrubbed of bearer secrets by
  // the request logger's URL scrubbing before emission.
  "tunnel.request": {
    tunnelKind: "shared" | "server";
    rpcMethod?: string;
    path: string;
  };
  "chat.session.persist.failed": {
    failureKind:
      | "timeout"
      | "http_error"
      // A 2xx whose body could not be read, or carried no version. Distinct
      // from http_error: the request succeeded, the contract did not.
      | "protocol_error"
      | "exception"
      | "version_conflict";
    statusCode?: number;
    /**
     * Sanitized, length-capped excerpt of the ingest's response body (see
     * `sanitizeDiagnosticText`: secrets, emails and bearer tokens are redacted
     * and it is truncated). Carried mainly for 4xx, where the body text names
     * the misconfiguration and is the difference between a diagnosable failure
     * and a bare status code.
     */
    responsePreview?: string;
    sourceType?: "scenario" | "direct" | "eval" | "swarm";
    // Product-surface discriminator carried alongside sourceType so PostHog
    // can pivot persist failures by surface without rejoining to chatSessions.
    // CAUTION: this `origin` is a DIFFERENT axis from the ErrorOrigin field
    // of the same name on `http.request.failed` / `route.operation.failed` —
    // never join the two in an APL query.
    origin?:
      | "playground"
      | "mcpjam_agent"
      | "scenario"
      | "eval"
      | "swarm"
      | "api";
  };
  /**
   * The backend accepted the request but declined the write, judging the
   * transcript a replay. Previously invisible — the turn was dropped and
   * nothing recorded it — which is how hosted turns went missing for months.
   * Its own event so the silent-drop class is measurable rather than inferred.
   */
  "chat.session.persist.skipped": {
    sourceType?: "scenario" | "direct" | "eval" | "swarm";
    origin?:
      | "playground"
      | "mcpjam_agent"
      | "scenario"
      | "eval"
      | "swarm"
      | "api";
    /** False means the payload had no idempotency key to dedupe on. */
    hasTurnId: boolean;
  };
  "widget.resource.served": {
    widgetType: "mcp_apps" | "chatgpt_apps";
    resourceUri: string;
    cspMode: "permissive" | "widget-declared";
    mimeTypeValid?: boolean;
    /**
     * Whether the inspector injected the OpenAI Apps SDK
     * `window.openai` shim into the served HTML. Helps audit
     * which hosts are flipping the compat flag in practice.
     */
    injectedOpenAiCompat?: boolean;
  };
  "widget.resource.failed": {
    widgetType: "mcp_apps" | "chatgpt_apps";
    resourceUri?: string;
    cspMode?: "permissive" | "widget-declared";
    errorCode: string;
  };
  "mcp.tool.execution.failed": {
    toolName: string;
    serverId?: string;
    errorCode: string;
  };
  // Project Computers terminal bridge (routes/web/computer-terminal.ts): the
  // PTY could not be brought up after a successful token handshake (sandbox
  // resume failed, envd unreachable, PTY create error, ...).
  "computer.terminal.pty_open_failed": {
    computerId: string;
    errorCode: string;
  };
  // Swarm AI generation (routes/web/swarm-generate.ts): the backend
  // /swarms/* endpoint answered with a server error. The upstream message is
  // deliberately NOT forwarded to the caller (it carries the deployment URL),
  // so this event is the only record of what the backend actually said.
  // `errorCode` is the backend envelope's own `code` when it sent one
  // ("mcpjam_config_error", "provider_error", …) and "upstream_server_error"
  // otherwise. The caller sees the envelope's `requestId` in the masked copy,
  // so a screenshot of the error resolves to this row.
  "swarm.generation.upstream_failed": {
    statusCode: number;
    errorCode: string;
  };
  "route.operation.failed": RouteOperationFailedFields;
};

export type SystemEventMap = {
  "mcp.connection.closed_with_pending_requests": { errorCode: string };
  /**
   * Auto-negotiation outcome, one line per connection attempt. Carries the
   * full dimension set — configured mode + negotiated era + transport +
   * surface + outcome + failure class — and no request payloads.
   * Low-cardinality by construction.
   */
  "mcp.connection.negotiated": {
    surface: string;
    serverId: string;
    transport: "http" | "stdio";
    configuredMode: "auto" | "modern-pin" | "legacy";
    outcome: "connected" | "failed";
    negotiatedEra?: "legacy" | "modern";
    negotiatedProtocolVersion?: string;
    failureClass?: string;
  };
  "process.unhandled_rejection": { errorCode: string };
  "process.uncaught_exception": { errorCode: string };
  /**
   * Heap and retained-buffer gauge, one line per sample that says something
   * (see utils/process-vitals.ts). Emitted on startup, on a heap step, and on a
   * slow heartbeat — never once per interval unconditionally, so a quiet
   * session costs almost nothing.
   *
   * Exists because INSPECTOR-ELECTRON-W3 crashed after 21 minutes with ZERO
   * breadcrumbs for the whole session: nothing recorded whether the heap ramped
   * or spiked, and the difference is the entire diagnosis. Every field is a
   * number or a three-valued reason, so cardinality is fixed.
   */
  "process.vitals": {
    reason: "startup" | "heap_step" | "heartbeat";
    uptimeSeconds: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    heapLimitBytes: number;
    oldSpaceUsedBytes: number;
    oldSpaceSizeBytes: number;
    externalBytes: number;
    rssBytes: number;
    peakHeapUsedBytes: number;
    rpcLogBufferBytes: number;
    rpcLogBufferEvents: number;
    rpcLogBufferServers: number;
    rpcLogTruncatedFrames: number;
    peakRpcLogBufferBytes: number;
    tokenizerPeakChars: number;
    tokenizerOversizeSkips: number;
  };
  /**
   * Aggregated socket-level failure counters, one line per flush interval
   * (see utils/socket-diagnostics.ts). These are connections that died before
   * Node parsed a request line, so they produce NO `http.request.*` event —
   * this is the only signal that they happened at all. Buckets are a fixed
   * set, so cardinality cannot grow with traffic. Never emitted per socket:
   * a reset storm must cost one row per interval, not one row per connection.
   */
  "http.socket.client_error": {
    total: number;
    econnreset: number;
    epipe: number;
    etimedout: number;
    econnaborted: number;
    parseError: number;
    headerOverflow: number;
    other: number;
  };
  // Aggregated PostHog relay proxy counters, one line per flush interval
  // (see routes/relay.ts). Low-cardinality by construction; never emitted
  // per-request.
  "relay.stats": {
    requests: number;
    res2xx: number;
    res3xx: number;
    res4xx: number;
    res5xx: number;
    upstream4xx: number;
    upstream5xx: number;
    timeouts: number;
    upstreamErrors: number;
    bodyLimitRejects: number;
    rateLimitRejects: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  };
  "route.operation.failed": RouteOperationFailedFields;
};

export type LogEventName = keyof RequestEventMap | keyof SystemEventMap;

export type RequestEventPayload<E extends keyof RequestEventMap> =
  RequestLogContext & { event: E } & RequestEventMap[E];

export type SystemEventPayload<E extends keyof SystemEventMap> =
  SystemLogContext & { event: E } & SystemEventMap[E];

// Resolve ENVIRONMENT per call (no module-level cache) so changes to
// process.env in tests or after a config reload take effect on the next emit.
// The "missing in production" warning still fires only once via warnedMissingEnv.
let warnedMissingEnv = false;

const ALLOWED_ENVIRONMENTS: Environment[] = [
  "prod",
  "staging",
  "preview",
  "dev",
  "local",
  "test",
];

export function resolveEnvironment(): Environment {
  const fromEnv = process.env.ENVIRONMENT;
  if (fromEnv && ALLOWED_ENVIRONMENTS.includes(fromEnv as Environment)) {
    return fromEnv as Environment;
  }
  if (process.env.NODE_ENV === "test") return "test";
  if (process.env.NODE_ENV === "production") {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      process.stderr.write(
        "[logging] ENVIRONMENT not set in production; defaulting to 'prod'\n"
      );
    }
    return "prod";
  }
  return "dev";
}

/**
 * Baked into the bundle by `server/tsup.config.ts` (`define`). MUST stay a
 * literal `process.env.X` member expression — esbuild's `define` is a
 * syntactic substitution and cannot see through a dynamic
 * `process.env[name]` lookup. Under tsx in dev the define is absent and this
 * reads the real environment, where npm provides `npm_package_version`.
 *
 * This is the canonical copy; `server/sentry.ts` (release tag) and
 * `server/utils/health-payload.ts` (`/health` version) resolve through it so
 * the three surfaces can never disagree about what build is running.
 */
const BAKED_VERSION = process.env.MCPJAM_INSPECTOR_VERSION;

function blankToNull(value: string | undefined): string | null {
  // Container platforms materialize a declared-but-unset variable as "",
  // which ?? does not catch.
  return value === undefined || value.trim() === "" ? null : value;
}

export function resolveAppVersion(): string | null {
  return (
    blankToNull(BAKED_VERSION) ?? blankToNull(process.env.npm_package_version)
  );
}

/**
 * The git-sha vars only exist on repo-connected builds. Production deploys
 * via `railway up` (a directory upload with no git metadata), so neither is
 * set there and every prod row carried `release: null` — which made the
 * "did a deploy cause this?" triage step in the alert runbooks impossible.
 * The baked package version is the fallback: prod deploys are releases, so
 * version boundaries ARE deploy boundaries, and it matches what `/health`
 * reports, so log rows and the canary correlate directly.
 */
export function resolveRelease(): string | null {
  return (
    blankToNull(process.env.RAILWAY_GIT_COMMIT_SHA) ??
    blankToNull(process.env.GIT_SHA) ??
    resolveAppVersion()
  );
}
