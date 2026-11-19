import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, SignJWT } from "jose";
import type { AuthKitGatewayDeps } from "../../../services/authkit-jwt.js";
const state = vi.hoisted(() => ({ deps: undefined as AuthKitGatewayDeps | undefined, memberships: [] as string[], authorize: undefined as (() => Promise<void>) | undefined, report: vi.fn() }));
vi.mock("../../../utils/route-error-report.js", () => ({ reportRouteFailure: state.report }));
vi.mock("../../../config.js", async (original) => ({ ...(await original<object>()), HOSTED_MODE: false }));
vi.mock("../../../services/authkit-jwt.js", async (original) => {
  const actual = await original<typeof import("../../../services/authkit-jwt.js")>();
  return { ...actual,
    verifyAuthKitToken: (token: string) => actual.verifyAuthKitToken(token, state.deps),
    classifyAuthKitBearer: (token: string) => actual.classifyAuthKitBearer(token, state.deps),
  };
});
vi.mock("../auth.js", async (original) => {
  const actual = await original<typeof import("../auth.js")>();
  return { ...actual, authorizeProject: (_context: unknown, _token: string, projectId: string) => {
    state.memberships.push(projectId);
    if (state.authorize) return state.authorize();
    if (projectId !== "project") throw new actual.WebRouteError(403, actual.ErrorCode.FORBIDDEN, "Project access refused");
    return Promise.resolve();
  } };
});
import routes from "../turn-authorization.js";
import { WebRouteError, ErrorCode } from "../auth.js";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { prepareTurnAuthorization } from "../../../services/chat-turn/turn-authorization.js";
import type { TurnAuthorization } from "../../../services/turn-authorization.js";
import { turnAuthorizationPart } from "../../../../shared/turn-authorization.js";
import { RevokedSessionCache, setRevokedSessionCacheForTests } from "../../../services/revoked-session-cache.js";
import { verifyAuthKitToken } from "../../../services/authkit-jwt.js";
import { getConvexBearerForRequest } from "../../../utils/v1-convex-token.js";

const clientId = "client_01K4C1TVPBE7JTBFQJF9SDW9P9";
const issuer = "https://login.mcpjam.com";
const requestId = "f56e90a1-dc58-443e-85b0-14677744b9b3";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let authorization: TurnAuthorization | undefined;
let event: unknown;
let cache: RevokedSessionCache;
let readRequestBearer: (() => Promise<string>) | undefined;
async function token(subject = "actor", sid = "session", org = "org") {
  return new SignJWT({ sid, org_id: org }).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(clientId).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
}
const app = new Hono().post("/start", bearerAuthMiddleware, async (c) => {
  authorization = await prepareTurnAuthorization(c, { projectId: "project", chatSessionId: "chat", requestId, harness: "codex", executionTarget: { kind: "host", hostId: "host" } }, { own() {} });
  readRequestBearer = () => getConvexBearerForRequest(c);
  authorization?.start("turn", { write: (part) => { event = part; } });
  return c.json({ started: !!authorization });
}).route("/api/mcp/turn-authorization", routes);
function identity() {
  const { expiresAt, tokenExpiresAt, ...value } = turnAuthorizationPart.parse(event).data;
  void expiresAt; void tokenExpiresAt; return value;
}
const renew = (bearer: string, body = identity()) => app.request("/api/mcp/turn-authorization", {
  method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(async () => {
  vi.useFakeTimers(); state.memberships = []; state.authorize = undefined; state.report.mockClear(); authorization = undefined;
  keys = await generateKeyPair("RS256");
  state.deps = { clientId, resolveKey: (candidate) => candidate === issuer ? keys.publicKey : null, anyAudienceIssuers: new Set([issuer]) };
  cache = new RevokedSessionCache({ fetchPage: async () => ({ sessions: [], cursor: null, isDone: true, watermark: Date.now() }) });
  await cache.scan(); setRevokedSessionCacheForTests(cache);
});
afterEach(() => { authorization?.dispose(); setRevokedSessionCacheForTests(null); vi.useRealTimers(); });
it("renews a real signed session through the mounted authenticated route after initial JWT expiry", async () => {
  const original = await token();
  expect((await app.request("/start", { method: "POST", headers: { authorization: `Bearer ${original}` } })).status).toBe(200);
  expect(event).toMatchObject({ type: "data-turn-authorization", transient: true });
  await vi.advanceTimersByTimeAsync(4 * 60_000); await cache.scan();
  const fresh = await token(); expect((await renew(fresh)).status).toBe(200);
  await vi.advanceTimersByTimeAsync(2 * 60_000); await cache.scan();
  await expect(verifyAuthKitToken(original)).rejects.toThrow();
  expect(await authorization!.getAuthorization()).toBe(`Bearer ${fresh}`);
  expect(await readRequestBearer!()).toBe(fresh);
  expect(state.memberships).toEqual(["project"]);
  authorization!.dispose(); expect((await renew(fresh)).status).toBe(401);
  await expect(readRequestBearer!()).rejects.toThrow();
});
it("refuses foreign scope and identity without consuming or changing the original handle", async () => {
  const original = await token(); await app.request("/start", { method: "POST", headers: { authorization: `Bearer ${original}` } });
  expect((await renew(await token("foreign"))).status).toBe(401);
  expect((await renew(await token("actor", "foreign"))).status).toBe(401);
  expect((await renew(await token("actor", "session", "foreign"))).status).toBe(401);
  for (const field of ["chatSessionId", "turnId", "requestId", "handle"] as const)
    expect((await renew(original, { ...identity(), [field]: "foreign" })).status).toBeGreaterThanOrEqual(400);
  expect((await renew(original, { ...identity(), projectId: "foreign" })).status).toBe(403);
  expect(await authorization!.getAuthorization()).toBe(`Bearer ${original}`);
});
it("rejects expired signatures and revoked sessions through gateway validation", async () => {
  const original = await token(); await app.request("/start", { method: "POST", headers: { authorization: `Bearer ${original}` } });
  expect((await renew(original.slice(0, -8) + "invalid")).status).toBe(401);
  await vi.advanceTimersByTimeAsync(6 * 60_000); await cache.scan();
  expect((await renew(original)).status).toBe(401);
  const fresh = await token(); cache.markRevokedLocally("session"); expect((await renew(fresh)).status).toBe(401);
});

it("prepares the same native authorization for an interactive emulated chat", async () => {
  const native = new Hono().post("/", bearerAuthMiddleware, async (c) => {
    const auth = await prepareTurnAuthorization(c, { projectId: "project", chatSessionId: "chat", requestId,
      executionTarget: { kind: "host", hostId: "host" } }, { own() {} });
    return c.json({ renewableHarness: !!auth });
  });
  const response = await native.request("/", { method: "POST", headers: { authorization: `Bearer ${await token()}` } });
  expect(await response.json()).toEqual({ renewableHarness: true });
});

it("treats a real Node client disconnect during the body read as cancellation", async () => {
  vi.useRealTimers();
  let finished!: (status: number) => void;
  const result = new Promise<number>((resolve) => { finished = resolve; });
  const observed = new Hono().use("*", async (c, next) => {
    await next();
    finished(c.res.status);
  }).route("/", app);
  const server = serve({ fetch: observed.fetch, port: 0, hostname: "127.0.0.1" });
  try {
    const bearer = await token();
    const req = request({ hostname: "127.0.0.1", port: (server.address() as AddressInfo).port,
      path: "/api/mcp/turn-authorization", method: "POST", headers: {
        authorization: `Bearer ${bearer}`, "content-type": "application/json",
      } });
    req.on("error", () => { /* The client deliberately closes its unfinished request. */ });
    req.write('{"handle":');
    await new Promise((resolve) => setTimeout(resolve, 30));
    req.destroy();
    expect(await result).toBe(499);
    expect(state.memberships).toEqual([]);
    expect(state.report).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("keeps an independent authorization refusal when the request also aborts", async () => {
  const bearer = await token();
  await app.request("/start", { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
  const controller = new AbortController();
  state.authorize = async () => {
    queueMicrotask(() => queueMicrotask(() => controller.abort(new Error("Client connection prematurely closed."))));
    throw new WebRouteError(403, ErrorCode.FORBIDDEN, "Project access refused");
  };
  const response = await app.request("/api/mcp/turn-authorization", {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(identity()), signal: controller.signal,
  });
  expect(controller.signal.aborted).toBe(true);
  expect(response.status).toBe(403);
  expect(state.report).toHaveBeenCalledOnce();
});
