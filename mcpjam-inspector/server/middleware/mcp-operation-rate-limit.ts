import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import { HOSTED_MODE } from "../config.js";
import {
  SERVER_REQUEST_BUDGET_REASON,
  type ServerRequestBudgetDetails,
} from "../../shared/server-request-budget.js";

/**
 * MJ-012. A per-server request budget for the MCP operation routes on
 * `/api/web`: `/tools/*`, `/resources/*`, `/prompts/*` and `/tasks/*`.
 *
 * Every request on those routes opens a connection to one of the caller's MCP
 * servers and runs one operation on it. The limiters already in front of them
 * budget the CALLER — `passthroughRateLimitMiddleware` per session token,
 * `guestRateLimitMiddleware` per guest, the `sk_` bucket in
 * `bearerAuthMiddleware` per API key — across everything that caller does.
 * None of them bounds how often one caller reaches one server. This does, with
 * a token bucket per (principal, server, route family): BURST requests back
 * to back, then one more every REFILL_INTERVAL_MS.
 *
 * ## Keys
 *
 * - PRINCIPAL: the identity `bearerAuthMiddleware` resolved, which is why this
 *   is mounted behind it — see `principalKey`.
 * - SERVER: the `serverId` the route handler connects to, read from the same
 *   JSON body the handler reads. A request that does not name exactly one
 *   server — a batch (`/prompts/list-multi` names several), or a body the
 *   handler will reject — is charged to ONE shared bucket per principal and
 *   family instead. Charged rather than skipped, so omitting the field is never
 *   cheaper than sending it; one bucket rather than one per name, so a batch
 *   costs one request however many servers it lists. A body that carries both
 *   a `serverId` and a `serverIds` list is charged to both buckets.
 * - FAMILY: tools, resources, prompts and tasks each get their own bucket, so
 *   polling a server's tasks does not spend the budget for listing its tools.
 *
 * ## PER REPLICA, like every limiter in this directory
 *
 * The buckets live in this process's memory. Behind a load balancer with N
 * replicas, one (principal, server, family) can reach N × BURST requests at
 * once and N per REFILL_INTERVAL_MS sustained. Making it exact needs shared
 * state, not a smaller number.
 *
 * Local/desktop mode is exempt: there is one user, and it is the person who
 * started the process.
 */

/**
 * Requests a full bucket holds. Opening a server in the app lists its tools
 * from several places at once (the Tools tab, the aggregated tool list, the
 * host-compat check), so a page load spends a few of these.
 */
const BURST = 8;

/**
 * One request returns to the bucket every 2 s — 30 a minute sustained, per
 * server and family. The hosted Tasks tab polls a server no faster than
 * `HOSTED_TASK_POLL_FLOOR_MS` (also 2 s), so a steady poll fits.
 */
const REFILL_INTERVAL_MS = 2_000;

/**
 * Bounded, and kept in least-recently-used order: every access, admitted or
 * refused, moves its key to the end of the table.
 *
 * Buckets that have refilled to BURST are dropped first — on a timer, and at
 * the cap. A new bucket starts at BURST too, so dropping a full one changes
 * nothing about what its owner may send next.
 *
 * At the cap with no full bucket to drop, the least recently used bucket is
 * dropped instead. That can give its owner at most one early refill (at most
 * BURST extra requests), and pushing one bucket out takes about MAX_ENTRIES
 * newer keys, so the effect is bounded and small. Every request is charged to
 * a bucket; none is admitted without one.
 */
const MAX_ENTRIES = 10_000;

/**
 * A full prune walks the whole table, so at the cap it runs at most this often
 * rather than once per new key.
 */
const PRUNE_AT_CAP_INTERVAL_MS = 1_000;

/**
 * Longer than any server id the app issues. A longer value is treated as
 * naming no server, which keeps every table key short.
 */
const MAX_SERVER_ID_LENGTH = 256;

/** The bucket a request that names no single server is charged to. */
const SHARED_SERVER_KEY = "*";

export type McpOperationFamily = "tools" | "resources" | "prompts" | "tasks";

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();
let lastPruneAtCap = 0;

/** Tokens `bucket` holds at `now`, with the refill applied and capped. */
function available(bucket: Bucket, now: number): number {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  return Math.min(BURST, bucket.tokens + elapsed / REFILL_INTERVAL_MS);
}

/** Drop every bucket that is back at BURST. See MAX_ENTRIES. */
function pruneFull(now: number): void {
  for (const [key, bucket] of buckets) {
    if (available(bucket, now) >= BURST) buckets.delete(key);
  }
}

setInterval(() => pruneFull(Date.now()), 60_000).unref();

/** Free one slot at the cap. See MAX_ENTRIES. */
function makeRoom(now: number): void {
  if (now - lastPruneAtCap >= PRUNE_AT_CAP_INTERVAL_MS) {
    lastPruneAtCap = now;
    pruneFull(now);
  }
  if (buckets.size < MAX_ENTRIES) return;
  // Iteration order is insertion order, and every access re-inserts its key,
  // so the first key is the least recently used.
  const leastRecentlyUsed = buckets.keys().next();
  if (!leastRecentlyUsed.done) buckets.delete(leastRecentlyUsed.value);
}

/**
 * Spend one token from every bucket in `keys`, or from none of them.
 *
 * Returns `null` when the request is admitted, or the ms until every one of
 * those buckets holds a token again. A refused request spends nothing, so an
 * empty bucket refills on schedule however often it is asked.
 */
function spend(keys: readonly string[], now: number): number | null {
  let waitMs = 0;
  for (const key of keys) {
    const bucket = buckets.get(key);
    // An absent bucket is a full one.
    if (!bucket) continue;
    // Every access moves the key to the end, before anything is evicted below.
    buckets.delete(key);
    buckets.set(key, bucket);
    const tokens = available(bucket, now);
    if (tokens < 1) {
      waitMs = Math.max(waitMs, (1 - tokens) * REFILL_INTERVAL_MS);
    }
  }
  if (waitMs > 0) return waitMs;

  for (const key of keys) {
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.tokens = available(bucket, now) - 1;
      bucket.updatedAt = now;
      continue;
    }
    if (buckets.size >= MAX_ENTRIES) makeRoom(now);
    buckets.set(key, { tokens: BURST - 1, updatedAt: now });
  }
  return null;
}

/**
 * Whose budget a request spends.
 *
 * Dispatched on `authMethod` — the credential class `bearerAuthMiddleware`
 * verified — rather than on which identity variables happen to be set. A
 * verified session is keyed on its user, so every tab and every refreshed
 * token of one account shares one budget per server. A bearer the gateway
 * passed through unverified is keyed on the token itself, HASHED: it is a
 * credential, and an in-memory table has no business holding the raw value.
 */
function principalKey(c: Context): string {
  switch (c.get("authMethod")) {
    case "workos_api_key": {
      const keyId = c.get("workosApiKeyId");
      if (keyId) return `key:${keyId}`;
      break;
    }
    case "guest": {
      const guestId = c.get("guestId");
      if (guestId) return `guest:${guestId}`;
      break;
    }
    case "authkit_jwt":
    // The linked user, never the bot the service credential names.
    case "slack_service":
    case "discord_service": {
      const userId = c.get("workosUserId");
      if (userId) return `user:${userId}`;
      break;
    }
  }
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  return `bearer:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

/** The buckets this request spends. See "Keys" in the header. */
async function bucketKeys(
  c: Context,
  family: McpOperationFamily,
): Promise<string[]> {
  let body: unknown;
  try {
    // Hono caches the body, so the route handler's own read still sees it.
    body = await c.req.json();
  } catch {
    // Unreadable: the handler answers that itself. Charged to the shared
    // bucket below, like any request that names no server.
    body = undefined;
  }
  const fields =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const prefix = `${family}|${principalKey(c)}|`;
  const keys: string[] = [];
  const serverId = fields.serverId;
  if (
    typeof serverId === "string" &&
    serverId.length > 0 &&
    serverId.length <= MAX_SERVER_ID_LENGTH
  ) {
    keys.push(`${prefix}server:${serverId}`);
  }
  if (keys.length === 0 || Array.isArray(fields.serverIds)) {
    keys.push(`${prefix}${SHARED_SERVER_KEY}`);
  }
  return keys;
}

const TOO_MANY_MESSAGE =
  "Too many requests to this server. Slow down and retry.";

/**
 * Marks the refusal as this budget's, which is how the client tells it apart
 * from every other 429 and retries it after `Retry-After` — see
 * `shared/server-request-budget.ts`.
 */
const TOO_MANY_DETAILS: ServerRequestBudgetDetails = {
  reason: SERVER_REQUEST_BUDGET_REASON,
};

function tooMany(c: Context, waitMs: number) {
  // `requestLogContextMiddleware` reads the code and message off
  // `webErrorMeta` for a RETURNED response.
  c.set("webErrorMeta", {
    status: 429,
    code: ErrorCode.RATE_LIMITED,
    message: TOO_MANY_MESSAGE,
  });
  return c.json(
    {
      code: ErrorCode.RATE_LIMITED,
      message: TOO_MANY_MESSAGE,
      details: TOO_MANY_DETAILS,
    },
    429,
    {
      "Retry-After": String(Math.max(1, Math.ceil(waitMs / 1000))),
    },
  );
}

/**
 * The per-server budget for one route family. Mount it on that family's path
 * AFTER `bearerAuthMiddleware`, which resolves the principal it keys on.
 */
export function mcpOperationRateLimit(family: McpOperationFamily) {
  return async function mcpOperationRateLimitMiddleware(
    c: Context,
    next: Next,
  ): Promise<Response | void> {
    if (!HOSTED_MODE) return next();
    // Every operation route in these families is a POST. Anything else reaches
    // no handler, and must not spend a budget that one would.
    if (c.req.method !== "POST") return next();

    const waitMs = spend(await bucketKeys(c, family), Date.now());
    if (waitMs !== null) return tooMany(c, waitMs);
    return next();
  };
}

export const MCP_OPERATION_BURST = BURST;
export const MCP_OPERATION_REFILL_INTERVAL_MS = REFILL_INTERVAL_MS;
export const MCP_OPERATION_MAX_ENTRIES = MAX_ENTRIES;

/** Test-only: the bound is only meaningful if a test can observe it. */
export function mcpOperationRateLimitSizeForTests(): number {
  return buckets.size;
}

export function resetMcpOperationRateLimitForTests(): void {
  buckets.clear();
  lastPruneAtCap = 0;
}
