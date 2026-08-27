import { Hono } from "hono";
import { z } from "zod";
import { listAllTools } from "@mcpjam/sdk/operations";
import { runEphemeralConnection } from "./auth.js";
import {
  assertBearerToken,
  ErrorCode,
  parseWithSchema,
  readJsonBody,
  WebRouteError,
} from "./errors.js";
import { getClientIp } from "../../utils/client-ip.js";
import { hashGuestSpendIp } from "../../utils/guest-spend-ip.js";

/**
 * Connector Bench relay.
 *
 * The chrome-less score site drives a benchmark run entirely through these
 * routes; the backend owns everything durable (the stable target, the
 * classification receipt, the quote, the run row, the result document). This
 * file is the edge in front of `/internal/v1/bench/*` and nothing more — the
 * worker, the UI and write enforcement are separate lanes.
 *
 * ## Two tokens, always
 *
 * Every relayed call carries BOTH `INSPECTOR_SERVICE_TOKEN` (this is the
 * inspector) and the caller's own bearer (on behalf of this user or guest) —
 * the pattern `hostedTasksRoutes` established. The backend derives the acting
 * identity from the bearer and must never take it from the body, so nothing
 * here sends a user id.
 *
 * ## 404 means "not enabled", not "broken"
 *
 * The backend halves of this contract sit behind `BENCHMARK_RUNS_ENABLED` and
 * land after this router does. A 404 therefore has to degrade into a clean
 * "benchmark runs are not enabled" answer rather than a 500 — that is
 * precisely what lets the inspector stack merge before the flag flips. The one
 * exception is the entity envelope (`{ ok: false, error: "Not found" }`), which
 * a deployed route uses to say a specific run or result link is missing; see
 * `isEntityNotFound` in services/internal-backend.ts for the same shape.
 *
 * ## Start work vs. continue work
 *
 * `/preflight` and `/runs` spend our egress and the caller's credits, so they
 * carry a per-IP ceiling on top of the per-guest one (guest identities are
 * free to mint; the IP is the honest unit). Polling and cancelling a run
 * already paid for are NOT debited — charging them would let a start consume
 * the last slot and then 429 the caller out of the run they just launched.
 */

const bench = new Hono();

const BACKEND_PREFLIGHT_PATH = "/internal/v1/bench/preflight";
const BACKEND_QUOTES_PATH = "/internal/v1/bench/quotes";
const BACKEND_RUNS_PATH = "/internal/v1/bench/runs";
const BACKEND_RUN_GET_PATH = "/internal/v1/bench/runs/get";
const BACKEND_RUN_CANCEL_PATH = "/internal/v1/bench/runs/cancel";
const BACKEND_RESULT_GET_PATH = "/internal/v1/bench/results/get";

/** The guest per-IP daily spend key. Computed here; never read off the wire. */
const GUEST_IP_HASH_HEADER = "x-mcpjam-guest-ip-hash";

const FEATURE_DISABLED_MESSAGE =
  "Benchmark runs are not enabled for this deployment yet.";

/**
 * Bound every call to Convex. A backend that accepts the connection and then
 * goes quiet would otherwise park a request indefinitely — and `/results/:secret`
 * takes no session, so there is nothing to stop someone collecting those.
 *
 * Preflight gets its own budget because it is the only route that waits on a
 * classification the backend may have to compute rather than read.
 */
const BACKEND_TIMEOUT_MS = 10_000;
const PREFLIGHT_BACKEND_TIMEOUT_MS = 30_000;

/** The dial + `tools/list` drain in front of preflight, separate from the relay. */
const PREFLIGHT_CONNECT_TIMEOUT_MS = 30_000;

// ── Per-IP budgets ───────────────────────────────────────────────────

/**
 * Parity with the conformance run ceiling, and for the same reason: a
 * preflight opens a real connection to a caller-named third party, and a run
 * commissions far more work than that. PER PROCESS, like every other limiter
 * in this family — the real ceiling is this number times the replica count.
 */
const START_WORK_RATE_LIMIT = 30;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** Result reads are cheap individually, so the miss budget is looser. */
const READ_MISS_RATE_LIMIT = 60;

/**
 * Bounded like `resultCache` below. Only EXPIRED windows are swept, and the
 * key comes from a client-supplied forwarding header — so a caller rotating
 * `x-forwarded-for` adds one live entry per request and none of them age out
 * for ten minutes. A limiter that can be made to exhaust memory is a
 * liability, not a defense.
 */
const WINDOW_MAX_ENTRIES = 10_000;
const startWorkWindows = new Map<
  string,
  { count: number; windowStart: number }
>();
const readWindows = new Map<string, { count: number; windowStart: number }>();

/**
 * Expire windows on a timer, not on the request. Sweeping inside the handler
 * is O(entries), so once a churner fills the map every subsequent request pays
 * for the whole table — the limiter becomes the amplifier it was meant to
 * prevent.
 */
setInterval(() => {
  const now = Date.now();
  for (const windows of [startWorkWindows, readWindows]) {
    for (const [key, value] of windows) {
      if (now - value.windowStart >= RATE_LIMIT_WINDOW_MS) {
        windows.delete(key);
      }
    }
  }
}, 60_000).unref();

function consumeWindow(
  windows: Map<string, { count: number; windowStart: number }>,
  clientKey: string,
  now: number,
  limit: number,
  message: string,
) {
  const rateWindow = windows.get(clientKey);
  if (rateWindow) {
    if (now - rateWindow.windowStart >= RATE_LIMIT_WINDOW_MS) {
      // Expired in place. The timer above is a memory sweep, not the clock —
      // correctness cannot depend on when it last ran.
      rateWindow.count = 1;
      rateWindow.windowStart = now;
      return;
    }
    if (rateWindow.count >= limit) {
      throw new WebRouteError(429, ErrorCode.RATE_LIMITED, message);
    }
    rateWindow.count++;
    return;
  }

  if (windows.size >= WINDOW_MAX_ENTRIES) {
    // FAIL CLOSED rather than evict. Evicting the oldest entry would bound
    // memory while handing whoever owned it a brand-new allowance — so a
    // churner could reset their own exhausted bucket just by filling the map,
    // which is precisely what this limiter exists to stop.
    throw new WebRouteError(429, ErrorCode.RATE_LIMITED, message);
  }
  windows.set(clientKey, { count: 1, windowStart: now });
}

/**
 * Charged by `/preflight` and `/runs` ONLY, and charged BEFORE the dial —
 * the budget exists to bound egress, so it cannot sit behind the round trip
 * it is bounding.
 */
function consumeStartWorkRateLimit(clientKey: string) {
  consumeWindow(
    startWorkWindows,
    clientKey,
    Date.now(),
    START_WORK_RATE_LIMIT,
    "Too many benchmark runs from this address. Try again in a few minutes.",
  );
}

function consumeReadRateLimit(clientKey: string) {
  consumeWindow(
    readWindows,
    clientKey,
    Date.now(),
    READ_MISS_RATE_LIMIT,
    "Too many result lookups. Please try again later.",
  );
}

// ── Result cache ─────────────────────────────────────────────────────

/**
 * Small, short-lived read cache. A shared result link gets opened repeatedly
 * in a burst (a thread, a PR comment), and every hit is otherwise a Convex
 * round trip for a document that can never change — a finished run is
 * immutable.
 */
const RESULT_CACHE_TTL_MS = 60_000;
const RESULT_CACHE_MAX_ENTRIES = 200;
const resultCache = new Map<string, { at: number; payload: unknown }>();

function readCachedResult(secret: string): unknown | null {
  const hit = resultCache.get(secret);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_CACHE_TTL_MS) {
    resultCache.delete(secret);
    return null;
  }
  return hit.payload;
}

function cacheResult(secret: string, payload: unknown) {
  if (resultCache.size >= RESULT_CACHE_MAX_ENTRIES) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = resultCache.keys().next();
    if (!oldest.done) resultCache.delete(oldest.value);
  }
  resultCache.set(secret, { at: Date.now(), payload });
}

// ── Backend transport ────────────────────────────────────────────────

function backendConfig(): { convexUrl: string; serviceToken: string } {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Benchmark runs are not configured",
    );
  }

  // These requests carry the service token — the credential that authenticates
  // us AS the inspector. Sending it in cleartext to a remote host would put it
  // on the wire for anyone on the path. Loopback is exempt because local dev
  // legitimately runs Convex over http on 127.0.0.1.
  let parsed: URL;
  try {
    parsed = new URL(convexUrl);
  } catch {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Benchmark runs are misconfigured",
    );
  }
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  // `http:` only for the loopback exemption — `ftp://localhost` is a
  // misconfiguration, and letting it reach fetch reports it as an upstream
  // 502 instead of the config error it is.
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback)
  ) {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Benchmark runs are misconfigured: refusing to send the service token over cleartext",
    );
  }

  return { convexUrl: convexUrl.replace(/\/$/, ""), serviceToken };
}

type BackendBody = {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  [key: string]: unknown;
};

function backendMessage(body: BackendBody | null, fallback: string): string {
  if (typeof body?.error === "string" && body.error.trim()) return body.error;
  if (typeof body?.message === "string" && body.message.trim()) {
    return body.message;
  }
  return fallback;
}

/**
 * One two-token call against a `/internal/v1/bench/*` route.
 *
 * Every backend path is a POST, `/results/get` included: the result secret is
 * the whole credential for that document, and a query string is the one part
 * of a request that reliably survives into access logs.
 *
 * @param bearer the caller's own token, omitted only by `/results/:secret`,
 * which is deliberately reachable with no session at all.
 * @param notFoundMessage what an ENTITY-level 404 means for this route. When
 * absent, every 404 is the disabled/undeployed case.
 */
async function callBackend(
  path: string,
  payload: Record<string, unknown>,
  options: {
    bearer?: string;
    guestIpHash?: string | null;
    timeoutMs?: number;
    notFoundMessage?: string;
    unreachableMessage: string;
  },
): Promise<BackendBody> {
  const { convexUrl, serviceToken } = backendConfig();

  let response: Response;
  try {
    response = await fetch(`${convexUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
        ...(options.bearer
          ? { authorization: `Bearer ${options.bearer}` }
          : {}),
        ...(options.guestIpHash
          ? { [GUEST_IP_HASH_HEADER]: options.guestIpHash }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? BACKEND_TIMEOUT_MS),
      // The scheme check above validates the CONFIGURED host. `fetch` follows
      // redirects by default and replays headers to wherever it lands, so a
      // 3xx could carry both tokens to another host — over http, even. Refuse
      // to follow; the credentials stay confined to the host we vetted.
      redirect: "manual",
    });
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      options.unreachableMessage,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "The benchmark service redirected; refusing to forward the service token",
    );
  }

  const body = (await response.json().catch(() => null)) as BackendBody | null;

  if (response.status === 404) {
    // An entity envelope only counts when the route declared it can miss one.
    // Anything else — a bare Convex routing 404, an HTML error page, a flag
    // that is off — is the feature not being enabled here yet.
    if (options.notFoundMessage && body?.ok === false) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        options.notFoundMessage,
      );
    }
    throw new WebRouteError(
      503,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      FEATURE_DISABLED_MESSAGE,
    );
  }

  if (response.ok && body?.ok === true) {
    return body;
  }

  switch (response.status) {
    case 400:
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        backendMessage(body, "The benchmark service rejected this request."),
      );
    case 401:
      // Ambiguous between "the caller's bearer expired" and "our service token
      // is wrong", and only the first is actionable by the browser — so it is
      // surfaced as the one the client can retry after re-authenticating.
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        backendMessage(body, "Sign in again to run a benchmark."),
      );
    case 402:
      throw new WebRouteError(
        402,
        ErrorCode.BILLING_LIMIT_REACHED,
        backendMessage(body, "This benchmark run exceeds your plan's limits."),
        body ? (body as Record<string, unknown>) : undefined,
      );
    case 403:
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        backendMessage(body, "You do not have access to this benchmark."),
      );
    case 409:
      throw new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        backendMessage(body, "This benchmark run is no longer in that state."),
      );
    case 429:
      throw new WebRouteError(
        429,
        ErrorCode.RATE_LIMITED,
        backendMessage(body, "Too many benchmark requests. Try again shortly."),
      );
    default:
      throw new WebRouteError(
        response.status >= 500 || response.ok ? 502 : response.status,
        ErrorCode.SERVER_UNREACHABLE,
        backendMessage(body, options.unreachableMessage),
      );
  }
}

/**
 * The per-IP spend key the backend meters guests by. Hashed here so the raw
 * address never reaches Convex; omitted when it cannot be produced, so an
 * unresolvable IP falls back to the backend's cookie-only bucket instead of
 * pooling unrelated guests together.
 */
async function guestSpendKey(c: Parameters<typeof getClientIp>[0]) {
  const clientIp = getClientIp(c);
  return clientIp ? await hashGuestSpendIp(clientIp) : null;
}

/** Everything the backend answered except its own envelope flag. */
function relayed(body: BackendBody): Record<string, unknown> {
  const { ok: _ok, ...rest } = body;
  return rest;
}

// ── Schemas ──────────────────────────────────────────────────────────

/**
 * A benchmark always names a SAVED server, never a URL and never a set of
 * caller-supplied auth headers. That is the whole point of the indirection:
 * the connection is authorized and credentialed by the backend from the
 * project's own stored config, so a caller cannot point a run at an arbitrary
 * host or attach a token they were never granted. These schemas are stripping
 * `z.object`s, so a body that carries `oauthAccessToken` or `headers` loses
 * them here rather than downstream.
 */
const targetSchema = z.object({
  projectId: z.string().trim().min(1).max(128),
  serverId: z.string().trim().min(1).max(128),
});

/**
 * Which parts of the bench a caller wants. The IDs themselves are the
 * backend's vocabulary — it mints them in the preflight response and it is the
 * only thing that can validate them — so this checks shape and size only, the
 * way the score relay treats a suite report as an opaque blob with a checked
 * outer shape.
 */
const selectionSchema = z.object({
  categoryIds: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  trackIds: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  actorIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
});

const preflightSchema = targetSchema;

const quoteSchema = targetSchema.extend({
  selection: selectionSchema.optional(),
});

const startRunSchema = targetSchema.extend({
  /**
   * The classification receipt `/preflight` returned. A run is quoted and
   * priced against a specific classification of a specific tool surface, so
   * the backend needs to know which one the caller was looking at — a run
   * started against a receipt that no longer matches the target is a
   * conflict, not a silent re-classification.
   */
  receiptId: z.string().trim().min(1).max(256),
  selection: selectionSchema.optional(),
  /** Bounded free-form prefs (per-actor overrides the score site collects). */
  preferences: z.record(z.string(), z.unknown()).optional(),
});

// ── Tool snapshot ────────────────────────────────────────────────────

/**
 * The snapshot crosses to Convex in one request body, and its size is the
 * TARGET's choice rather than ours — `tools/list` returns whatever the
 * caller's server answers. Stop at whichever bound trips first and say so: a
 * truncated snapshot classifies the tools it did see, which is strictly more
 * useful than a body the backend refuses whole.
 */
const SNAPSHOT_MAX_TOOLS = 500;
const SNAPSHOT_MAX_BYTES = 512 * 1024;

interface ToolSnapshot {
  tools: Array<Record<string, unknown>>;
  toolCount: number;
  truncated: boolean;
  capturedAt: number;
}

function buildToolSnapshot(tools: unknown[]): ToolSnapshot {
  const entries: Array<Record<string, unknown>> = [];
  let bytes = 0;
  let truncated = false;

  for (const raw of tools) {
    if (entries.length >= SNAPSHOT_MAX_TOOLS) {
      truncated = true;
      break;
    }
    const tool = (raw ?? {}) as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name) continue;

    // `_meta` is deliberately dropped. It is a server-controlled free-form bag
    // that classification does not read, and this snapshot becomes durable
    // backend state — forwarding it would persist whatever a target chose to
    // attach to its own tools.
    const entry: Record<string, unknown> = { name: tool.name };
    if (typeof tool.title === "string") entry.title = tool.title;
    if (typeof tool.description === "string") {
      entry.description = tool.description;
    }
    if (tool.inputSchema) entry.inputSchema = tool.inputSchema;
    if (tool.outputSchema) entry.outputSchema = tool.outputSchema;
    if (tool.annotations) entry.annotations = tool.annotations;

    const size = JSON.stringify(entry).length;
    if (bytes + size > SNAPSHOT_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    entries.push(entry);
  }

  return {
    tools: entries,
    toolCount: entries.length,
    truncated,
    capturedAt: Date.now(),
  };
}

// ── Routes ───────────────────────────────────────────────────────────

/**
 * Resolve a saved server, dial it, capture its tool surface, and ask the
 * backend what can be run against it.
 *
 * The only route here that does more than relay, and the ordering is the
 * design: debit → connect → snapshot → classify. The dial happens through the
 * ordinary hosted authorize-and-connect path, so membership, stored
 * credentials and egress policy are all decided by the backend from the saved
 * server row — this route never sees a URL or a token it could substitute.
 */
bench.post("/preflight", async (c) => {
  consumeStartWorkRateLimit(getClientIp(c) ?? "unknown");

  const bearer = assertBearerToken(c);
  const body = parseWithSchema(preflightSchema, await readJsonBody(c));

  // Resolved before the dial, and the result deliberately discarded: a
  // misconfigured backend means the classification can never land, and
  // connecting to the caller's server to learn that spends their time for
  // nothing.
  backendConfig();

  // A FRESH body, not the caller's. `runEphemeralConnection` re-reads its raw
  // argument for fields no route schema declares (the XAA policy), so handing
  // it the original request body would reintroduce exactly the caller-supplied
  // connection inputs the schema above exists to strip.
  const connectBody = { projectId: body.projectId, serverId: body.serverId };

  const snapshot = await runEphemeralConnection(
    c,
    connectBody,
    preflightSchema,
    async (manager) => {
      // `bypass`, and every page of it: a benchmark is scored against the
      // surface the server actually serves right now, and a partial or stale
      // list would silently narrow what the classifier ever sees.
      const { tools } = await listAllTools(manager, {
        serverId: body.serverId,
        cacheMode: "bypass",
      });
      return buildToolSnapshot(tools);
    },
    { timeoutMs: PREFLIGHT_CONNECT_TIMEOUT_MS },
  );

  const backend = await callBackend(
    BACKEND_PREFLIGHT_PATH,
    {
      projectId: body.projectId,
      serverId: body.serverId,
      toolSnapshot: snapshot,
    },
    {
      bearer,
      guestIpHash: await guestSpendKey(c),
      timeoutMs: PREFLIGHT_BACKEND_TIMEOUT_MS,
      unreachableMessage: "Failed to prepare this benchmark.",
    },
  );

  // Ours last: what this relay actually captured is not the backend's to
  // overwrite, and `success` is the envelope rather than a relayed field.
  return c.json({
    ...relayed(backend),
    success: true,
    toolCount: snapshot.toolCount,
    toolSnapshotTruncated: snapshot.truncated,
  });
});

bench.post("/quotes", async (c) => {
  const bearer = assertBearerToken(c);
  const body = parseWithSchema(quoteSchema, await readJsonBody(c));

  const backend = await callBackend(BACKEND_QUOTES_PATH, body, {
    bearer,
    guestIpHash: await guestSpendKey(c),
    unreachableMessage: "Failed to price this benchmark.",
  });

  return c.json({ ...relayed(backend), success: true });
});

bench.post("/runs", async (c) => {
  consumeStartWorkRateLimit(getClientIp(c) ?? "unknown");

  const bearer = assertBearerToken(c);
  const body = parseWithSchema(startRunSchema, await readJsonBody(c));

  const backend = await callBackend(BACKEND_RUNS_PATH, body, {
    bearer,
    guestIpHash: await guestSpendKey(c),
    unreachableMessage: "Failed to start this benchmark run.",
  });

  return c.json({ ...relayed(backend), success: true });
});

/**
 * A continuation, NOT a start: deliberately outside the per-IP budget. A run
 * is polled for as long as it takes, and a poller who gets locked out of their
 * own run has no way back to a result they already paid for.
 */
bench.get("/runs/:runId", async (c) => {
  const bearer = assertBearerToken(c);
  const runId = c.req.param("runId");
  if (!runId) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Missing run id");
  }

  const backend = await callBackend(
    BACKEND_RUN_GET_PATH,
    { runId },
    {
      bearer,
      notFoundMessage: "That benchmark run no longer exists.",
      unreachableMessage: "Failed to load this benchmark run.",
    },
  );

  return c.json({ ...relayed(backend), success: true });
});

/** Also a continuation — see the note on the poll route. */
bench.post("/runs/:runId/cancel", async (c) => {
  const bearer = assertBearerToken(c);
  const runId = c.req.param("runId");
  if (!runId) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Missing run id");
  }

  const backend = await callBackend(
    BACKEND_RUN_CANCEL_PATH,
    { runId },
    {
      bearer,
      notFoundMessage: "That benchmark run no longer exists.",
      unreachableMessage: "Failed to cancel this benchmark run.",
    },
  );

  return c.json({ ...relayed(backend), success: true });
});

/**
 * NO BEARER AUTH, and that is the point rather than an oversight (the score
 * relay's precedent): a result link must open for someone with no session at
 * all — a teammate, a maintainer, an incognito window. The secret in the URL
 * is the entire credential, and the backend returns only the public artifact.
 */
bench.get("/results/:secret", async (c) => {
  const secret = c.req.param("secret");
  if (!secret) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Missing secret");
  }

  const cached = readCachedResult(secret);
  if (cached) {
    return c.json({ success: true, result: cached });
  }

  // Only MISSES are charged. A secret is the whole credential, so a guesser
  // gets 404s that never populate the cache — without a budget, every guess is
  // a free Convex round trip and this public route becomes a load amplifier
  // aimed at our own backend. Legitimate readers hit the cache and pay nothing.
  consumeReadRateLimit(getClientIp(c) ?? "unknown");

  const backend = await callBackend(
    BACKEND_RESULT_GET_PATH,
    { secret },
    {
      notFoundMessage:
        "That result link is not valid, or the run no longer exists.",
      unreachableMessage: "Failed to load this benchmark result.",
    },
  );

  const result = backend.result;
  if (!result) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to load this benchmark result.",
    );
  }

  cacheResult(secret, result);
  return c.json({ success: true, result });
});

export default bench;
