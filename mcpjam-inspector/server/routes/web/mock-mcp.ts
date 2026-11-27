/**
 * The mock server's HTTP door: `/api/web/mock-mcp/:mockId`.
 *
 * A client outside MCPJam (Claude Code, Cursor, the SDK's own client) dials
 * this with its MCPJam API key or OAuth token as the bearer. The chain, in
 * order: a per-source limit, bearer auth, the refusal of anything that is not
 * a signed-in person, a per-key limit, then the handler, which asks the backend
 * about this caller on every request.
 * A grant opens nothing here (`services/mock/registry.ts` is the only door
 * for one).
 *
 * `/api/web/*`'s body cap and the app-wide Host and Origin checks run in front
 * of all of it; this file adds neither.
 */
import { Hono, type Context, type Next } from "hono";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { mcpOperationRateLimit } from "../../middleware/mcp-operation-rate-limit.js";
import { mockDoorSourceLimit } from "../../middleware/mock-door-source-limit.js";
import { looksLikeMockGrant } from "../../services/mock/grant-claims.js";
import { mockRefusalResponse, type MockRefusalKind } from "../../services/mock/refusal.js";
import { DEFAULT_MOCK_PROFILE, serveMock } from "../../services/mock/route.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { HOSTED_MODE } from "../../config.js";
import { callerContextFromHono } from "./auth.js";

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

/**
 * Whatever the bearer chain refused with, a client of this route reads
 * JSON-RPC: a refusal in any other shape is rewritten, keeping its status.
 */
export async function mockBearerGate(c: Context, next: Next) {
  const token = bearerOf(c);
  if (!token) return mockRefusalResponse("unauthorized");
  // A grant copied from a log or a trace opens nothing here.
  if (looksLikeMockGrant(token)) return mockRefusalResponse("grant_over_http");
  await next();
  const response = c.res;
  if (response.status < 400) return;
  let parsed: { jsonrpc?: unknown; message?: unknown } | undefined;
  try {
    parsed = JSON.parse(await response.clone().text()) as typeof parsed;
  } catch {
    parsed = undefined; // not JSON: the status alone decides
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
  const retryAfter = Number(response.headers.get("retry-after"));
  c.res = mockRefusalResponse(kind, {
    authMethod: c.get("authMethod") as string | undefined,
    ...(typeof parsed?.message === "string" && parsed.message.length <= 300
      ? { message: parsed.message }
      : {}),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
  });
}

/** Only a signed-in person gets past: a guest and a service credential are refused by name. */
export async function mockCallerGate(c: Context, next: Next) {
  const method = c.get("authMethod") as string | undefined;
  if (method === "guest") return mockRefusalResponse("guest");
  if (!method || !PERSON_AUTH_METHODS.has(method)) return mockRefusalResponse("forbidden");
  return next();
}

/**
 * Mounted before the router, in this order, at `/mock-mcp/*`. The source limit
 * runs inside the gate (so its refusal is JSON-RPC) and before bearer auth.
 */
export const mockDoorMiddleware = [
  mockBearerGate,
  mockDoorSourceLimit,
  bearerAuthMiddleware,
  mockCallerGate,
] as const;

const mockMcp = new Hono();

// Per caller and per mock, after auth has said who the caller is and before the
// handler asks the backend anything. `serverId` is the name the limiter reads.
mockMcp.use("/:serverId", mcpOperationRateLimit("mock-mcp"));

mockMcp.all("/:mockId", (c) =>
  serveMock(c.req.raw, c.req.param("mockId"), {
    kind: "http",
    bearerToken: bearerOf(c) as string,
    caller: callerContextFromHono(c),
    profile: { ...DEFAULT_MOCK_PROFILE, xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE) },
  }),
);

export default mockMcp;
