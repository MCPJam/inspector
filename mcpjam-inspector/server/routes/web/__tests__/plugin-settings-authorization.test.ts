import { Hono, type Context } from "hono";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginPreviewInstance } from "../../../services/plugin-host/instances";
const f = vi.hoisted(() => ({
  verify: undefined as
    | undefined
    | ((token: string) => Promise<{ sub: string; sid: string; orgId: string }>),
  live: new AbortController(),
  release: vi.fn(),
  calls: 0,
  late: undefined as undefined | (() => Promise<string>),
  finish: undefined as undefined | (() => void),
  changed: false,
  receiptOnly: false,
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<object>()),
  HOSTED_MODE: false,
}));
vi.mock("../../../services/authkit-jwt.js", async (original) => ({
  ...(await original<object>()),
  verifyAuthKitToken: (token: string) => f.verify!(token),
  classifyAuthKitBearer: async (token: string) => ({
    kind: "verified",
    ...(await f.verify!(token)),
  }),
}));
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<object>()),
  admitPluginWorkspace: async () => ({
    actorId: "actor",
    projectId: "project",
  }),
  resolvePluginCleanupActor: async () => "actor",
}));
vi.mock("../../../services/plugin-host/instances.js", () => ({
  pluginInstances: {
    getPersistent: () => instance,
    get: () => instance,
    signal: () => f.live.signal,
    closePersistent: async () => f.live.abort(),
  },
}));
vi.mock("../../../services/plugin-host/request-runtime.js", () => ({
  assertPluginInstanceBindingCurrent: async () => {
    if (f.changed) throw new Error("Scope changed");
  },
  createPluginRequestRuntime: () => ({ release: f.release }),
}));
vi.mock("../../../services/plugin-host/request-invocation.js", () => ({
  invokePluginRequest: async (c: Context, input: { receiptOnly: boolean }) => {
    f.receiptOnly = input.receiptOnly;
    if (!input.receiptOnly) f.calls++;
    f.late = () => getConvexBearerForRequest(c);
    await new Promise<void>((resolve) => {
      f.finish = resolve;
    });
    await f.late();
    return c.json({ status: "completed", result: { content: [] } });
  },
}));
vi.mock("../auth.js", async (original) => ({
  ...(await original<object>()),
  authorizeProject: async (_c: Context, _token: string, projectId: string) => {
    if (projectId !== "project") throw new Error("Project refused");
  },
}));
import renewRoutes from "../turn-authorization";
import routes from "../plugin-settings";
import { getConvexBearerForRequest } from "../../../utils/v1-convex-token";
import {
  turnAuthorizationPart,
  turnAuthorizationIdentity,
} from "../../../../shared/turn-authorization";
import {
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../../../services/revoked-session-cache";
const instance: PluginPreviewInstance = {
  owner: {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive",
  },
  subject: "subject",
  hostId: "host",
  hostRevision: "revision",
  serverIdentity: { kind: "standalone", serverId: "server" },
  resourceUri: "ui://settings",
  activation: {
    selector: { kind: "settings" },
    toolName: "read",
    revision: "revision",
    operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    settings: { readTool: "read", updateTool: "save", revision: "revision" },
  },
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let cache: RevokedSessionCache;
let metadata: ReturnType<typeof turnAuthorizationPart.parse> | undefined;
const owner = {
  projectId: "project",
  pluginWorkspace: { version: 1, workspaceId: "workspace" },
  instanceToken: "token",
};
const operationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const mint = (sub = "actor", sid = "session", org = "org") =>
  new SignJWT({ sid, org_id: org })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
const app = new Hono()
  .use("*", async (c, next) => {
    try {
      const actor = await f.verify!(
        c.req.header("authorization")!.replace(/^Bearer /, ""),
      );
      c.set("authMethod", "authkit_jwt");
      c.set("workosUserId", actor.sub);
      await next();
    } catch {
      return c.json({ denied: true }, 401);
    }
  })
  .route("/settings", routes)
  .route("/authorization", renewRoutes);
const post = (path: string, token: string, body: unknown) =>
  app.request(`/settings/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
function identity() {
  const { tokenExpiresAt, expiresAt, ...value } = metadata!.data;
  void tokenExpiresAt;
  void expiresAt;
  return turnAuthorizationIdentity.parse(value);
}
async function prepare(token: string) {
  const response = await post("renew", token, {
    ...owner,
    operation: {
      kind: "call",
      invocationId: operationId,
      requestId,
      params: { name: "read", arguments: {} },
    },
  });
  expect(response.status).toBe(200);
  metadata = turnAuthorizationPart.parse(
    (await response.json()).operationAuthorization,
  );
  return identity();
}
beforeEach(async () => {
  vi.useFakeTimers();
  keys = await generateKeyPair("RS256");
  f.live = new AbortController();
  f.calls = 0;
  f.changed = false;
  f.receiptOnly = false;
  f.late = undefined;
  f.finish = undefined;
  f.verify = async (token) => {
    const { payload } = await jwtVerify(token, keys.publicKey);
    return {
      sub: payload.sub!,
      sid: String(payload.sid),
      orgId: String(payload.org_id),
    };
  };
  cache = new RevokedSessionCache({
    fetchPage: async () => ({
      sessions: [],
      cursor: null,
      isDone: true,
      watermark: Date.now(),
    }),
  });
  await cache.scan();
  setRevokedSessionCacheForTests(cache);
});
afterEach(() => {
  f.live.abort();
  f.finish?.();
  metadata = undefined;
  setRevokedSessionCacheForTests(null);
  vi.useRealTimers();
});
it("renews the exact settings read through its original signed owner after expiry", async () => {
  const original = await mint();
  const authorization = await prepare(original);
  const call = post("read", original, { ...owner, operationId, authorization });
  await vi.waitFor(() => expect(f.finish).toBeDefined());
  await vi.advanceTimersByTimeAsync(240000);
  await cache.scan();
  const fresh = await mint();
  expect(
    (
      await app.request("/authorization", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fresh}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(authorization),
      })
    ).status,
  ).toBe(200);
  await vi.advanceTimersByTimeAsync(120000);
  await cache.scan();
  await expect(f.verify!(original)).rejects.toThrow();
  expect(await f.late!()).toBe(fresh);
  f.finish!();
  expect((await call).status).toBe(200);
  expect(f.calls).toBe(1);
  await expect(f.late!()).rejects.toThrow();
});
it("refuses changed route parameters and foreign identity without consuming the original claim", async () => {
  const original = await mint();
  const authorization = await prepare(original);
  for (const token of [
    await mint("foreign"),
    await mint("actor", "foreign"),
    await mint("actor", "session", "foreign"),
  ]) {
    expect(
      (await post("read", token, { ...owner, operationId, authorization }))
        .status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect(
    (
      await post("read", original, {
        ...owner,
        operationId: crypto.randomUUID(),
        authorization,
      })
    ).status,
  ).toBe(403);
  expect(f.calls).toBe(0);
  const call = post("read", original, { ...owner, operationId, authorization });
  await vi.waitFor(() => expect(f.finish).toBeDefined());
  f.finish!();
  expect((await call).status).toBe(200);
  expect(f.calls).toBe(1);
});
it("blocks late use after same-session revocation and preflight after capability change", async () => {
  const original = await mint();
  const authorization = await prepare(original);
  const call = post("read", original, { ...owner, operationId, authorization });
  await vi.waitFor(() => expect(f.finish).toBeDefined());
  cache.markRevokedLocally("session");
  await expect(f.late!()).rejects.toThrow();
  f.finish!();
  expect((await call).status).toBeGreaterThanOrEqual(400);
  expect(f.calls).toBe(1);
  f.changed = true;
  expect(
    (
      await post("renew", original, {
        ...owner,
        operation: {
          kind: "call",
          invocationId: operationId,
          requestId,
          params: { name: "read", arguments: {} },
        },
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
});
it("only recovers a receipt when a supplied preflight has expired", async () => {
  const original = await mint();
  const authorization = await prepare(original);
  await vi.advanceTimersByTimeAsync(61000);
  await cache.scan();
  const call = post("read", original, { ...owner, operationId, authorization });
  await vi.waitFor(() => expect(f.finish).toBeDefined());
  f.finish!();
  expect((await call).status).toBe(200);
  expect(f.receiptOnly).toBe(true);
  expect(f.calls).toBe(0);
});
