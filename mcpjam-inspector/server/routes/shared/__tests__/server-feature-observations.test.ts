import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rollout:
    vi.fn<(authorization: string | null | undefined) => Promise<boolean>>(),
  authorize: vi.fn(),
  authorizeLocal: vi.fn(),
  mutation: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("../../web/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web/auth.js")>();
  return { ...actual, authorizeServerAs: mocks.authorize };
});
vi.mock("../../../utils/local-server-resolver.js", () => ({
  authorizeServerLocal: mocks.authorizeLocal,
}));
vi.mock("../../../utils/server-canvas-rollout.js", () => ({
  resolveServerCanvasRollout: mocks.rollout,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = mocks.setAuth;
    mutation = mocks.mutation;
  },
}));
vi.mock("../../../env.js", () => ({
  getInspectorClientRuntimeConfig: () => ({
    convexUrl: "https://example.convex.cloud",
  }),
}));

import { Hono } from "hono";
import { ErrorCode, WebRouteError } from "../../web/errors.js";
import {
  rememberHostedContext,
  resetHostedContextsForTests,
} from "../../../services/server-canvas/connection-context.js";
import { localContextHash } from "../../../services/server-canvas/observation-recorders.js";
import { registerLocalConnectionScope } from "../../../utils/mcp-connections.js";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  hostedServerFeatureRoutes,
  localServerFeatureRoutes,
} from "../server-feature-observations.js";

const CONTEXT = "ctx_0123456789abcdef";
/** This server's clock when a batch arrives. */
const RECEIVED_AT = Date.UTC(2026, 10, 18, 12, 0, 0);
const ACTOR = "user_a";
const BODY = {
  projectId: "prj_1",
  serverId: "srv_1",
  flushId: "flush-0001",
  observations: [
    {
      featureId: "apps.app-tools-call",
      count: 2,
      firstSeenAt: 10,
      lastSeenAt: 20,
    },
  ],
};

type FakeManager = Pick<
  MCPClientManager,
  "getInitializationInfo" | "listServers" | "getConnectionStatus"
>;

type AuthorizeServerAs = typeof import("../../web/auth.js").authorizeServerAs;

/** The backend authorizes the caller and names `userId` in its log context. */
function authorizesAs(userId: string | null) {
  mocks.authorize.mockImplementation(
    async (...[who]: Parameters<AuthorizeServerAs>) => {
      who.onLogContext?.({ userId });
      return { success: true };
    },
  );
}

/** The local manager with one live connection, "My Server", for srv_1. */
function localManager(): MCPClientManager {
  const fake: FakeManager = {
    getInitializationInfo: (key) =>
      key === "My Server"
        ? {
            protocolVersion: "2025-11-25",
            transport: "stdio",
            serverCapabilities: undefined,
            serverVersion: undefined,
            instructions: undefined,
            clientCapabilities: {},
          }
        : undefined,
    listServers: () => ["My Server"],
    getConnectionStatus: () => "connected",
  };
  const manager = fake as MCPClientManager;
  registerLocalConnectionScope(manager, "My Server", {
    projectId: "prj_1",
    serverId: "srv_1",
  });
  return manager;
}

const LOCAL_MANAGER = localManager();

function app(local = false) {
  const root = new Hono();
  root.use("*", async (c, next) => {
    c.mcpClientManager = LOCAL_MANAGER;
    await next();
  });
  root.route(
    "/server-features",
    local ? localServerFeatureRoutes : hostedServerFeatureRoutes,
  );
  return root;
}

function post(body: unknown, { local = false, bearer = "user-token" } = {}) {
  return app(local).request("/server-features/observations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: RECEIVED_AT });
  resetHostedContextsForTests();
  mocks.rollout.mockReset().mockResolvedValue(true);
  mocks.authorize.mockReset();
  authorizesAs(ACTOR);
  mocks.authorizeLocal.mockReset().mockResolvedValue({ ok: true });
  mocks.mutation.mockReset().mockResolvedValue(undefined);
  mocks.setAuth.mockReset();
  rememberHostedContext(
    { projectId: "prj_1", serverId: "srv_1", actorId: ACTOR },
    CONTEXT,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hosted server-features observations route", () => {
  it("authorizes the server and writes the batch as apps-bridge", async () => {
    const response = await post(BODY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: 1 });
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ caller: expect.anything() }),
      "user-token",
      "prj_1",
      "srv_1",
    );
    expect(mocks.setAuth).toHaveBeenCalledWith("user-token");
    expect(mocks.mutation.mock.calls[0][1]).toEqual({
      projectId: "prj_1",
      serverId: "srv_1",
      contextHash: CONTEXT,
      flushId: "flush-0001",
      observations: [
        {
          featureId: "apps.app-tools-call",
          count: 2,
          firstSeenAt: RECEIVED_AT,
          lastSeenAt: RECEIVED_AT,
          source: "apps-bridge",
        },
      ],
    });
  });

  it("refuses a mock server by name and records nothing", async () => {
    mocks.authorize.mockResolvedValue({
      success: true,
      serverConfig: { mock: { mockId: "m1" } },
    });
    const response = await post(BODY);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      "Feature observations do not take mock servers",
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("writes the time the batch arrived, not the browser's", async () => {
    const future = RECEIVED_AT + 365 * 24 * 60 * 60 * 1000;
    const response = await post({
      ...BODY,
      observations: [
        { ...BODY.observations[0], firstSeenAt: future, lastSeenAt: future },
      ],
    });
    expect(await response.json()).toEqual({ recorded: 1 });
    expect(mocks.mutation.mock.calls[0][1].observations).toEqual([
      expect.objectContaining({
        firstSeenAt: RECEIVED_AT,
        lastSeenAt: RECEIVED_AT,
      }),
    ]);
  });

  it("passes the browser's flushId through on a repeated send", async () => {
    await post(BODY);
    await post(BODY);
    const flushIds = mocks.mutation.mock.calls.map(([, args]) => args.flushId);
    expect(flushIds).toEqual(["flush-0001", "flush-0001"]);
  });

  it("writes nothing and skips authorization when the rollout is off", async () => {
    mocks.rollout.mockResolvedValue(false);
    const response = await post(BODY);
    expect(await response.json()).toEqual({ recorded: 0 });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses a caller the server is not shared with", async () => {
    mocks.authorize.mockRejectedValue(
      new WebRouteError(403, ErrorCode.FORBIDDEN, "No access to this server"),
    );
    const response = await post(BODY);
    expect(response.status).toBe(403);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses a request without a bearer", async () => {
    const response = await post(BODY, { bearer: "" });
    expect(response.status).toBe(401);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a feature id the bridge cannot show",
      {
        ...BODY,
        observations: [
          { ...BODY.observations[0], featureId: "tool-results.text" },
        ],
      },
    ],
    [
      "payload fields",
      {
        ...BODY,
        observations: [{ ...BODY.observations[0], message: "private" }],
      },
    ],
    [
      "times out of order",
      { ...BODY, observations: [{ ...BODY.observations[0], firstSeenAt: 30 }] },
    ],
    ["an empty batch", { ...BODY, observations: [] }],
  ])("rejects %s", async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("drops the batch when this instance has seen no context for the caller", async () => {
    resetHostedContextsForTests();
    const response = await post(BODY);
    expect(await response.json()).toEqual({ recorded: 0 });
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("never files one member's batch under another member's context", async () => {
    authorizesAs("user_b");
    expect(await (await post(BODY)).json()).toEqual({ recorded: 0 });
    rememberHostedContext(
      { projectId: "prj_1", serverId: "srv_1", actorId: "user_b" },
      "ctx_fedcba9876543210",
    );
    expect(await (await post(BODY)).json()).toEqual({ recorded: 1 });
    expect(mocks.mutation.mock.calls[0][1].contextHash).toBe(
      "ctx_fedcba9876543210",
    );
  });

  it("drops the batch when the backend names no authorized user", async () => {
    authorizesAs(null);
    expect(await (await post(BODY)).json()).toEqual({ recorded: 0 });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("still asks the rollout and authorization on a cache miss", async () => {
    resetHostedContextsForTests();
    mocks.authorize.mockRejectedValue(
      new WebRouteError(403, ErrorCode.FORBIDDEN, "No access to this server"),
    );
    expect((await post(BODY)).status).toBe(403);
    mocks.rollout.mockResolvedValue(false);
    expect(await (await post(BODY)).json()).toEqual({ recorded: 0 });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe("local server-features observations route", () => {
  it("authorizes locally and writes under the live connection's context", async () => {
    const response = await post(BODY, { local: true });
    expect(await response.json()).toEqual({ recorded: 1 });
    expect(mocks.authorizeLocal).toHaveBeenCalledWith(
      expect.anything(),
      "user-token",
      "prj_1",
      "srv_1",
    );
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.mutation.mock.calls[0][1]).toMatchObject({
      serverId: "srv_1",
      contextHash: localContextHash(LOCAL_MANAGER, "My Server"),
    });
    expect(localContextHash(LOCAL_MANAGER, "My Server")).toMatch(/^ctx_/);
  });

  it("writes nothing for a server with no live local connection", async () => {
    const response = await post(
      { ...BODY, serverId: "srv_other" },
      { local: true },
    );
    expect(await response.json()).toEqual({ recorded: 0 });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
