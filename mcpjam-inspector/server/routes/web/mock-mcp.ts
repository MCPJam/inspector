/**
 * The mock server's HTTP door: `/api/web/mock-mcp/:mockId`.
 *
 * A client outside MCPJam (Claude Code, Cursor, the SDK's own client) dials
 * this with its MCPJam API key or OAuth token as the bearer. The chain, in
 * order: a counter per source address (before any key is checked), a
 * remembered refusal, bearer auth, the refusal of anything that is not a
 * signed-in person, a counter per key, then the handler. A grant opens
 * nothing here (`services/mock/registry.ts` is the only door for one).
 *
 * `/api/web/*`'s 1 MB body cap and the app-wide Host and Origin checks
 * (`originValidationMiddleware`, `localHostAllowlistMiddleware`) run in front
 * of all of it; this file adds neither.
 */
import { createHash } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { getAttestedClientIp } from "../../utils/client-ip.js";
import { principalKey } from "../../utils/request-principal.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { digestOf } from "../../services/mock/backend.js";
import { looksLikeMockGrant } from "../../services/mock/grant-claims.js";
import { AnswerCache, MOCK_REFUSED_BEARER_MS } from "../../services/mock/limits.js";
import {
  MOCK_KEY_LIMIT_PER_MINUTE,
  MOCK_SOURCE_LIMIT_PER_MINUTE,
  WindowLimiter,
} from "../../services/mock/window-limiter.js";
import {
  mockRefusalResponse,
  type MockRefusalKind,
} from "../../services/mock/refusal.js";
import { DEFAULT_MOCK_PROFILE, serveMock } from "../../services/mock/route.js";
import { callerContextFromHono } from "./auth.js";

const sourceLimiter = new WindowLimiter(MOCK_SOURCE_LIMIT_PER_MINUTE);
/** Callers with no address we can vouch for share one window, four times as wide. */
const unattestedLimiter = new WindowLimiter(MOCK_SOURCE_LIMIT_PER_MINUTE * 4);
const keyLimiter = new WindowLimiter(MOCK_KEY_LIMIT_PER_MINUTE);
const refusedBearers = new AnswerCache<MockRefusalKind>(MOCK_REFUSED_BEARER_MS);

/** The credential kinds that are a signed-in person acting. */
const PERSON_AUTH_METHODS: ReadonlySet<string> = new Set([
  "workos_api_key",
  "workos_agent",
  "authkit_jwt",
  "unverified_passthrough",
]);

function bearerOf(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

function tooMany(retryAfterMs: number): Response {
  return mockRefusalResponse("rate_limited", { retryAfterSeconds: retryAfterMs / 1000 });
}

/** Step one: a counter per source address, before any key is checked. */
export async function mockSourceLimit(c: Context, next: Next) {
  const address = getAttestedClientIp(c);
  const waitMs = address
    ? sourceLimiter.take(`ip:${address}`)
    : unattestedLimiter.take("unattested");
  if (waitMs !== null) return tooMany(waitMs);
  return next();
}

/**
 * Step two: refuse what is known to fail, answer in JSON-RPC, and remember a
 * refused bearer. A bearer the chain turned away with 401 is not asked about
 * again for 30 seconds, so a loop with a bad key costs no WorkOS or backend
 * call after the first.
 */
export async function mockBearerGate(c: Context, next: Next) {
  const token = bearerOf(c);
  if (!token) return mockRefusalResponse("unauthorized");
  // A grant copied from a log or a trace opens nothing here.
  if (looksLikeMockGrant(token)) return mockRefusalResponse("grant_over_http");
  const remembered = refusedBearers.get(digestOf(token));
  if (remembered) return mockRefusalResponse(remembered);

  await next();

  const response = c.res;
  if (response.status < 400) return;
  if (response.status === 401) refusedBearers.set(digestOf(token), "unauthorized");
  // Whatever the chain refused with, a client of this route reads JSON-RPC.
  const text = await response.clone().text();
  let parsed: { jsonrpc?: unknown; message?: unknown } | undefined;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (parsed?.jsonrpc === "2.0") return;
  const kind: MockRefusalKind =
    response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "forbidden"
        : response.status === 429
          ? "rate_limited"
          : "unavailable";
  const message =
    typeof parsed?.message === "string" && parsed.message.length <= 300
      ? parsed.message
      : undefined;
  const retryAfter = Number(response.headers.get("retry-after"));
  c.res = mockRefusalResponse(kind, {
    ...(message ? { message } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter > 0
      ? { retryAfterSeconds: retryAfter }
      : {}),
  });
}

/** Step four: only a signed-in person gets past, and each key has its own counter. */
export async function mockCallerGate(c: Context, next: Next) {
  const method = c.get("authMethod") as string | undefined;
  if (method === "guest") return mockRefusalResponse("guest");
  if (!method || !PERSON_AUTH_METHODS.has(method)) {
    return mockRefusalResponse("forbidden");
  }
  const key = createHash("sha256").update(principalKey(c)).digest("hex");
  const waitMs = keyLimiter.take(key);
  if (waitMs !== null) return tooMany(waitMs);
  return next();
}

/** Mounted before the router, in this order, at `/mock-mcp/*`. */
export const mockDoorMiddleware = [
  mockSourceLimit,
  mockBearerGate,
  bearerAuthMiddleware,
  mockCallerGate,
] as const;

const mockMcp = new Hono();

mockMcp.all("/:mockId", (c) =>
  serveMock(c.req.raw, c.req.param("mockId"), {
    kind: "http",
    bearerToken: bearerOf(c) as string,
    caller: callerContextFromHono(c),
    profile: {
      ...DEFAULT_MOCK_PROFILE,
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
    },
  }),
);

/** Test seam. */
export function resetMockDoorForTests(): void {
  sourceLimiter.clear();
  unattestedLimiter.clear();
  keyLimiter.clear();
  refusedBearers.clear();
}

export default mockMcp;
