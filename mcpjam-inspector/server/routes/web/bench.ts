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
import { getAttestedClientIp } from "../../utils/client-ip.js";
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
 * free to mint; the IP is the honest unit). Only an address this deployment
 * can VOUCH for gets a window of its own — everything else shares one pooled
 * bucket, because a per-value key a caller can rotate is a way to fill the map
 * rather than a way to bound anyone. Polling and cancelling a run already paid
 * for are NOT debited — charging them would let a start consume the last slot
 * and then 429 the caller out of the run they just launched.
 *
 * ## Nothing is dialed before the backend is known to be there
 *
 * `/preflight` opens the caller's saved server, so it asks the backend whether
 * benchmark runs exist at all before it spends that connection; see
 * `assertBenchBackendEnabled`.
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
 * The one bucket every request we cannot place shares — one bucket, not one
 * each. Only an ATTESTED address earns a window of its own: a key minted from
 * a forwarding header is a key the caller picks, so keying per value lets a
 * single actor rotate `x-forwarded-for` until the map is full and then 429
 * every genuinely new caller until the entries expire, the limiter becoming
 * the outage it exists to prevent. Sweeping does not help — the entries are
 * live, not stale.
 */
const UNATTESTED_CLIENT_KEY = "_unattested";

/**
 * Pooled ceilings, deliberately looser than the per-address ones because they
 * bound a whole population rather than one actor. A deployment that lands here
 * for every request is one whose ingress we cannot read: set
 * `MCPJAM_TRUSTED_CLIENT_IP_HEADER` to the header it overwrites and callers
 * get their own budgets back.
 */
const UNATTESTED_START_WORK_RATE_LIMIT = 4 * START_WORK_RATE_LIMIT;
const UNATTESTED_READ_MISS_RATE_LIMIT = 4 * READ_MISS_RATE_LIMIT;

/**
 * Bounded like `resultCache` below, and now bounded by something a caller
 * cannot inflate: entries are only minted for addresses this deployment can
 * vouch for, so the map grows with real clients rather than with header
 * values.
 */
const WINDOW_MAX_ENTRIES = 10_000;
const startWorkWindows = new Map<
  string,
  { count: number; windowStart: number }
>();
const readWindows = new Map<string, { count: number; windowStart: number }>();

/** Test-only seams: a bound is only meaningful if a test can observe it. */
export const BENCH_WINDOW_MAX_ENTRIES = WINDOW_MAX_ENTRIES;
export function benchStartWorkWindowCountForTests(): number {
  return startWorkWindows.size;
}

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

/** An attested address gets its own window; everyone else shares one. */
function clientBudget(c: Parameters<typeof getAttestedClientIp>[0]) {
  const attested = getAttestedClientIp(c);
  return attested
    ? { key: attested, attested: true }
    : { key: UNATTESTED_CLIENT_KEY, attested: false };
}

/**
 * Charged by `/preflight` and `/runs` ONLY, and charged BEFORE the dial —
 * the budget exists to bound egress, so it cannot sit behind the round trip
 * it is bounding.
 */
function consumeStartWorkRateLimit(
  c: Parameters<typeof getAttestedClientIp>[0],
) {
  const { key, attested } = clientBudget(c);
  consumeWindow(
    startWorkWindows,
    key,
    Date.now(),
    attested ? START_WORK_RATE_LIMIT : UNATTESTED_START_WORK_RATE_LIMIT,
    attested
      ? "Too many benchmark runs from this address. Try again in a few minutes."
      : "Too many benchmark runs right now. Try again in a few minutes.",
  );
}

function consumeReadRateLimit(c: Parameters<typeof getAttestedClientIp>[0]) {
  const { key, attested } = clientBudget(c);
  consumeWindow(
    readWindows,
    key,
    Date.now(),
    attested ? READ_MISS_RATE_LIMIT : UNATTESTED_READ_MISS_RATE_LIMIT,
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

/** The one verdict a bare 404 and a cached-off probe both produce. */
function featureDisabled() {
  return new WebRouteError(
    503,
    ErrorCode.FEATURE_NOT_SUPPORTED,
    FEATURE_DISABLED_MESSAGE,
  );
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
    throw featureDisabled();
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
      // The envelope rides along, as it does on 402. `CONFLICT` cannot
      // distinguish "the exam moved under your quote" — which the score site
      // recovers from by re-quoting — from "this run is already finished",
      // which it cannot, and only the backend's own code says which.
      throw new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        backendMessage(body, "This benchmark run is no longer in that state."),
        body ? (body as Record<string, unknown>) : undefined,
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

// ── Capability probe ─────────────────────────────────────────────────

/**
 * Is the bench family deployed at all?
 *
 * Every other route here learns that from the call it was going to make
 * anyway. `/preflight` cannot: it dials the caller's saved server and drains
 * `tools/list` FIRST, so in the merge-before-enable state that dial buys a
 * `FEATURE_NOT_SUPPORTED` — and if the target happens to be down, the caller
 * is shown the target's failure instead of ours. Ask the backend before
 * spending someone else's connection.
 *
 * The probe rides the preflight path itself rather than a route of its own. A
 * dedicated probe path would 404 both when the family is absent AND when a
 * deployed backend simply never added that one route, and the second reading
 * would keep the feature off permanently. Only a BARE 404 disables; every
 * other answer — the 400 a deployed backend owes a body with no target
 * included — proves the route is there.
 */
const FEATURE_PROBE_ENABLED_TTL_MS = 5 * 60_000;
const FEATURE_PROBE_DISABLED_TTL_MS = 60_000;

let featureProbe: { enabled: boolean; at: number } | null = null;

async function assertBenchBackendEnabled(): Promise<void> {
  const now = Date.now();
  if (featureProbe) {
    const ttl = featureProbe.enabled
      ? FEATURE_PROBE_ENABLED_TTL_MS
      : FEATURE_PROBE_DISABLED_TTL_MS;
    if (now - featureProbe.at < ttl) {
      if (featureProbe.enabled) return;
      throw featureDisabled();
    }
  }

  // No bearer: this asks about the DEPLOYMENT, not about a caller, so the
  // verdict is the same for everyone and can be cached across them.
  try {
    await callBackend(
      BACKEND_PREFLIGHT_PATH,
      { probe: true },
      { unreachableMessage: FEATURE_DISABLED_MESSAGE },
    );
    featureProbe = { enabled: true, at: now };
    return;
  } catch (error) {
    if (
      error instanceof WebRouteError &&
      error.code === ErrorCode.FEATURE_NOT_SUPPORTED
    ) {
      featureProbe = { enabled: false, at: now };
      throw error;
    }
    // A verdict of any other kind still proves the route answered. Transport
    // failures prove nothing, so they are not cached — and neither is allowed
    // to BLOCK: the probe may only ever short-circuit the disabled case, never
    // become a new way for preflight to fail.
    if (
      error instanceof WebRouteError &&
      error.code !== ErrorCode.SERVER_UNREACHABLE
    ) {
      featureProbe = { enabled: true, at: now };
    }
  }
}

/**
 * The per-IP spend key the backend meters guests by. Hashed here so the raw
 * address never reaches Convex; omitted when no address can be VOUCHED for, so
 * such a caller falls back to the backend's cookie-only bucket instead of
 * pooling unrelated guests together.
 *
 * `getAttestedClientIp`, the same address the limiters above key on. This used
 * to call `getClientIp` on the reasoning that a forwarded hint is safe because
 * the backend "re-validates it under its own trust rules". It cannot: we send
 * the HMAC and never the address, so there is nothing left on that side to
 * validate against. `benchmarkJobRoutes` takes the hash verbatim as the
 * `guestIpKey` and buckets the daily allowance on it.
 *
 * That made the cap self-defeating. `getClientIp` honours `x-real-ip` and the
 * first `x-forwarded-for` entry even with no trusted ingress in front, so a
 * guest could rotate either header to mint a fresh bucket — and the IP bucket
 * is exactly what is supposed to catch a guest who clears their cookie to get
 * a second free run. Rotate one and clear the other and the daily limit is
 * gone.
 *
 * Unattested callers send NO key rather than a shared one. A pooled sentinel
 * would be worse than nothing here: the buckets meter runs, not table space,
 * so the first guest through would spend the whole deployment's allowance and
 * lock out everyone behind them.
 */
async function guestSpendKey(c: Parameters<typeof getAttestedClientIp>[0]) {
  const clientIp = getAttestedClientIp(c);
  return clientIp ? await hashGuestSpendIp(clientIp) : null;
}

/** Everything the backend answered except its own envelope flag. */
function relayed(body: BackendBody): Record<string, unknown> {
  const { ok: _ok, ...rest } = body;
  return rest;
}

/**
 * The poll route, and ONLY the poll route, is the one backend answer that
 * nests its entity: `/runs/get` replies `{ ok, run: { … } }` while `/runs`,
 * `/runs/cancel`, `/quotes` and `/preflight` all reply with the entity's own
 * fields at the top level.
 *
 * Passing that through unflattened is not a cosmetic difference. The caller
 * reads `status` to decide whether a run is still going, so a nested body
 * makes `status` `undefined` on every poll — which is not an error anywhere,
 * just a run that never appears to finish. Flattened here rather than in the
 * client so the relay presents one shape for a run however it was obtained.
 *
 * Tolerant of the flat form as well: if the backend ever stops nesting, this
 * keeps working rather than starting to return an empty object.
 */
function relayedRun(body: BackendBody): Record<string, unknown> {
  const rest = relayed(body);
  const nested = rest.run;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const { run: _run, ...outer } = rest;
    return { ...outer, ...(nested as Record<string, unknown>) };
  }
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

/**
 * Per-actor prefill the score site collects. The KEYS are the backend's
 * vocabulary — it mints the actor ids and it is the only thing that can
 * validate them — so this bounds size and shape-depth, not meaning, the same
 * way `selectionSchema` above treats the ids it carries.
 *
 * It has to be bounded HERE rather than left to the blanket 1 MB body cap:
 * this record is forwarded verbatim, and the backend may persist it against
 * the run and price from it. A megabyte of arbitrarily nested JSON per run
 * start is durable backend state nobody agreed to store.
 */
const PREFERENCES_MAX_KEYS = 32;
const PREFERENCES_MAX_KEY_LENGTH = 128;
const PREFERENCES_MAX_BYTES = 8 * 1024;
const PREFERENCES_MAX_DEPTH = 8;

/** True as soon as `value` nests past `limit` levels; stops at the first one. */
function nestsDeeperThan(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== "object") return false;
  if (limit <= 0) return true;
  return Object.values(value as Record<string, unknown>).some((child) =>
    nestsDeeperThan(child, limit - 1),
  );
}

const preferencesSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > PREFERENCES_MAX_KEYS) {
      ctx.addIssue({
        code: "custom",
        message: `must have at most ${PREFERENCES_MAX_KEYS} keys`,
      });
      return;
    }
    if (keys.some((key) => key.length > PREFERENCES_MAX_KEY_LENGTH)) {
      ctx.addIssue({
        code: "custom",
        message: `each key must be at most ${PREFERENCES_MAX_KEY_LENGTH} characters`,
      });
      return;
    }
    if (nestsDeeperThan(value, PREFERENCES_MAX_DEPTH)) {
      ctx.addIssue({
        code: "custom",
        message: `must not nest more than ${PREFERENCES_MAX_DEPTH} levels deep`,
      });
      return;
    }
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") > PREFERENCES_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message: `must serialize to at most ${PREFERENCES_MAX_BYTES} bytes`,
      });
    }
  });

const preflightSchema = targetSchema;

/**
 * What the caller agreed to before anything is spent or written. Both booleans
 * are optional and both default to "not consented" on the backend, so omitting
 * the object is the safe reading rather than a permissive one.
 */
const consentSchema = z.object({
  authenticatedChecks: z.boolean().optional(),
  writeCases: z.boolean().optional(),
});

/**
 * A quote is priced against the stable TARGET and the exact exam definition —
 * not against the saved server row. `/preflight` mints `benchmarkTargetId` and
 * returns the runnable `tracks`, each carrying the `profileId` and `version`
 * named here; the backend refuses the request outright without all three of
 * `projectId`, `benchmarkTargetId` and `profileId`.
 *
 * `serverId` rides along because the caller has it and the start call needs
 * it; the quote itself does not read it.
 */
const quoteSchema = targetSchema.extend({
  benchmarkTargetId: z.string().trim().min(1).max(256),
  profileId: z.string().trim().min(1).max(256),
  profileVersion: z.string().trim().min(1).max(128).optional(),
  consent: consentSchema.optional(),
  selection: selectionSchema.optional(),
});

const startRunSchema = targetSchema.extend({
  /**
   * The quote being accepted. This is what makes a start an ACCEPTANCE of a
   * price rather than a fresh request to spend: the backend re-checks the
   * quote's definition and consent hashes and refuses with a conflict if the
   * exam moved underneath it, and the quote id doubles as the admission
   * idempotency key. Without it the backend has no price to hold anyone to.
   */
  quoteId: z.string().trim().min(1).max(256),
  /**
   * The classification receipt `/preflight` returned. A run is quoted and
   * priced against a specific classification of a specific tool surface, so
   * the backend needs to know which one the caller was looking at — a run
   * started against a receipt that no longer matches the target is a
   * conflict, not a silent re-classification.
   */
  receiptId: z.string().trim().min(1).max(256),
  consent: consentSchema.optional(),
  /** Lets a caller retry a lost start without commissioning a second run. */
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
  selection: selectionSchema.optional(),
  preferences: preferencesSchema.optional(),
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

/**
 * What an entry costs beyond its own JSON: the comma joining it to the one
 * before. Counted so the bound holds for the array actually sent rather than
 * for the entries measured in isolation.
 */
const SNAPSHOT_ENTRY_FRAMING_BYTES = 1;

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

    // UTF-8 BYTES, which is what crosses the wire. `String.length` counts
    // UTF-16 code units, and a CJK or emoji description costs three to four
    // bytes per unit — so counting units would wave through a body several
    // times the size of a bound that calls itself bytes.
    const size =
      Buffer.byteLength(JSON.stringify(entry), "utf8") +
      SNAPSHOT_ENTRY_FRAMING_BYTES;
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
  consumeStartWorkRateLimit(c);

  const bearer = assertBearerToken(c);
  const body = parseWithSchema(preflightSchema, await readJsonBody(c));

  // Resolved before the dial, and the result deliberately discarded: a
  // misconfigured backend means the classification can never land, and
  // connecting to the caller's server to learn that spends their time for
  // nothing.
  backendConfig();

  // Same reasoning one step further out: a backend that has not enabled
  // benchmark runs cannot classify anything either, and finding that out by
  // opening the caller's server first is the one cost this route can avoid
  // paying. After validation, so a malformed request never reaches Convex.
  await assertBenchBackendEnabled();

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
  consumeStartWorkRateLimit(c);

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

  return c.json({ ...relayedRun(backend), success: true });
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
  consumeReadRateLimit(c);

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
