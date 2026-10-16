import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MCPEventsWireError } from "@mcpjam/sdk";
import { InvalidEventsPayloadError } from "@mcpjam/sdk/events";
import { ConvexError } from "convex/values";

/**
 * The hosted events routes. `withEphemeralConnection` is stubbed with a
 * faithful miniature (parse → connect → handler → disconnect → JSON), as the
 * tasks tests do, so the assertions are about THIS file's mapping; the
 * inbox/backend/membership seams are replaced through `setWebEventsDepsForTests`.
 */

let managerImpl: Record<string, unknown> = {};

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: vi.fn().mockResolvedValue("convex-jwt"),
}));

vi.mock("../auth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../auth.js")>("../auth.js");
  const { WebRouteError } = await import("../errors.js");
  return {
    ...actual,
    withEphemeralConnection: async (
      c: any,
      schema: any,
      fn: (manager: any, body: any) => Promise<unknown>,
    ) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
      try {
        return c.json(
          (await fn(managerImpl, parsed.data)) as Record<string, unknown>,
          200,
        );
      } catch (error) {
        if (error instanceof WebRouteError) {
          return c.json(
            {
              code: error.code,
              message: error.message,
              details: error.details,
            },
            error.status as 400,
          );
        }
        return c.json({ code: "INTERNAL_ERROR" }, 500);
      }
    },
  };
});

const { default: eventsRoute, setWebEventsDepsForTests } =
  await import("../events.js");

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("workosUserId", "user_workos_1");
  await next();
});
app.route("/", eventsRoute);

function post(path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const supportDeclared = {
  handshakeObserved: true,
  declared: true,
  listChanged: true,
  capability: { listChanged: true },
  source: "initialize",
};

function setManager(overrides: Record<string, unknown>) {
  managerImpl = {
    ensureEventsSupport: vi.fn().mockResolvedValue(supportDeclared),
    getEventsSupport: vi.fn().mockReturnValue(supportDeclared),
    getCapturedEventsCapability: vi.fn().mockReturnValue({
      rawCapabilities: { events: { listChanged: true } },
      protocolVersion: "2025-11-25",
    }),
    ...overrides,
  };
}

describe("hosted /api/web/events — server operations", () => {
  beforeEach(() => setManager({}));

  it("lists descriptors with the support matrix", async () => {
    setManager({
      listServerEvents: vi.fn().mockResolvedValue({
        events: [{ name: "comment.created", delivery: ["poll"] }],
        nextCursor: "n1",
      }),
    });
    const res = await post("/list", { projectId: "p1", serverId: "s1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: [{ name: "comment.created", delivery: ["poll"] }],
      nextCursor: "n1",
      support: supportDeclared,
      rawCapabilities: { events: { listChanged: true } },
      protocolVersion: "2025-11-25",
    });
  });

  it("answers an undeclared server's list with 200, no events and its raw capabilities", async () => {
    const undeclared = {
      handshakeObserved: true,
      declared: false,
      listChanged: false,
      source: "initialize",
    };
    const listServerEvents = vi.fn();
    setManager({
      ensureEventsSupport: vi.fn().mockResolvedValue(undeclared),
      getEventsSupport: vi.fn().mockReturnValue(undeclared),
      getCapturedEventsCapability: vi.fn().mockReturnValue({
        rawCapabilities: { tools: {} },
        protocolVersion: "2025-11-25",
      }),
      listServerEvents,
    });
    const res = await post("/list", { projectId: "p1", serverId: "s1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: [],
      support: undeclared,
      rawCapabilities: { tools: {} },
      protocolVersion: "2025-11-25",
    });
    // Advertise = enforce: nothing was sent to the server.
    expect(listServerEvents).not.toHaveBeenCalled();
  });

  it("maps an undeclared capability on poll to 400 EVENTS_UNDECLARED", async () => {
    setManager({
      pollServerEvents: vi.fn().mockRejectedValue(
        new MCPEventsWireError({
          method: "events/poll",
          serverId: "s1",
          handshakeObserved: true,
        }),
      ),
    });
    const res = await post("/poll", {
      projectId: "p1",
      serverId: "s1",
      name: "comment.created",
      cursor: null,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "EVENTS_UNDECLARED",
      details: { handshakeObserved: true },
    });
  });

  it("maps a malformed server answer to 502 EVENTS_INVALID_PAYLOAD", async () => {
    setManager({
      pollServerEvents: vi
        .fn()
        .mockRejectedValue(
          new InvalidEventsPayloadError("events/poll result", [
            "events: required",
          ]),
        ),
    });
    const res = await post("/poll", {
      projectId: "p1",
      serverId: "s1",
      name: "comment.created",
      arguments: {},
      cursor: null,
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("EVENTS_INVALID_PAYLOAD");
  });

  it("maps a classified events RPC error with its kind, redacting echoed secrets", async () => {
    const error = Object.assign(
      new Error("refusing delivery.secret whsec_AAAAAAAAAAAAAAAAAAAAAAAA"),
      {
        code: -32013,
        data: { retryAfterMs: 1000 },
      },
    );
    setManager({ pollServerEvents: vi.fn().mockRejectedValue(error) });
    const res = await post("/poll", {
      projectId: "p1",
      serverId: "s1",
      name: "comment.created",
      cursor: null,
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "EVENTS_RPC_ERROR",
      details: { kind: "ResourceExhausted", rpcCode: -32013, retryable: true },
    });
    expect(JSON.stringify(body)).not.toContain("whsec_AAAA");
  });
});

describe("hosted /api/web/events — inbox-backed routes", () => {
  const saved = {
    convex: process.env.CONVEX_HTTP_URL,
    service: process.env.INSPECTOR_SERVICE_TOKEN,
    key: process.env.EVENTS_INBOX_VIEWER_KEY,
    url: process.env.EVENTS_INBOX_URL,
  };
  const projectAccess = vi.fn();
  const authorizeSimulation = vi.fn();
  const getSubscription = vi.fn();
  const ensureInbox = vi.fn();
  const inbox = {
    getViewerEpoch: vi.fn(),
    simulate: vi.fn(),
    slotState: vi.fn(),
  };

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    process.env.EVENTS_INBOX_VIEWER_KEY =
      "viewer-key-for-tests-0123456789abcdef";
    process.env.EVENTS_INBOX_URL = "https://hooks.test";
    projectAccess
      .mockReset()
      .mockResolvedValue({ projectId: "p1", role: "member" });
    authorizeSimulation.mockReset().mockResolvedValue(undefined);
    ensureInbox
      .mockReset()
      .mockResolvedValue({ inboxId: "inboxabcdefghijklmnopqrstu" });
    getSubscription.mockReset().mockResolvedValue({
      _id: "sub_doc_1",
      projectId: "p1",
      logicalId: "esub_1",
      bindingKey: "b".repeat(64),
      eventName: "comment.created",
      desiredState: "active",
      inboxId: "inboxabcdefghijklmnopqrstu",
      slotId: "slotabcdefghijklmnopqrstuv",
      environmentId: null,
    });
    inbox.getViewerEpoch.mockReset().mockResolvedValue(3);
    inbox.simulate
      .mockReset()
      .mockResolvedValue({ accepted: 1, duplicates: 0 });
    inbox.slotState.mockReset().mockResolvedValue({
      state: "active",
      serverSubscriptionId: "srv_sub_1",
      observedSubscriptionIds: [],
      counts: { deliveries: 2 },
      rejections: [
        {
          reason: "bad_signature",
          slotId: "slotabcdefghijklmnopqrstuv",
          at: 5,
          headerNames: ["webhook-id"],
          bodyBytes: 10,
        },
      ],
    });
    setWebEventsDepsForTests({
      projectAccess,
      authorizeSimulation,
      backend: () => ({ ensureInbox, getSubscription }) as never,
      inbox: () => inbox as never,
      now: () => Date.UTC(2026, 8, 30, 12, 0, 0),
    });
  });

  afterEach(() => {
    setWebEventsDepsForTests(undefined);
    for (const [key, env] of [
      ["CONVEX_HTTP_URL", saved.convex],
      ["INSPECTOR_SERVICE_TOKEN", saved.service],
      ["EVENTS_INBOX_VIEWER_KEY", saved.key],
      ["EVENTS_INBOX_URL", saved.url],
    ] as const) {
      if (env === undefined) delete process.env[key];
      else process.env[key] = env;
    }
  });

  it("issues a viewer token for a member, at the inbox's current epoch", async () => {
    const res = await post("/viewer-token", { projectId: "p1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      inboxId: "inboxabcdefghijklmnopqrstu",
      feedUrl: "https://hooks.test/i/inboxabcdefghijklmnopqrstu/deliveries",
      streamUrl: "https://hooks.test/i/inboxabcdefghijklmnopqrstu/stream",
      expiresAt: Date.UTC(2026, 8, 30, 12, 10, 0),
    });
    const [, payload] = body.token.split(".");
    expect(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    ).toEqual({
      inboxId: "inboxabcdefghijklmnopqrstu",
      projectId: "p1",
      userId: "user_workos_1",
      epoch: 3,
      exp: Date.UTC(2026, 8, 30, 12, 10, 0) / 1000,
      scope: "feed:read",
    });
    expect(ensureInbox).toHaveBeenCalledWith("p1");
  });

  it("refuses a viewer token to a guest without a project grant", async () => {
    projectAccess.mockResolvedValue({
      projectId: "p1",
      role: "guest",
      projectRole: null,
    });
    const res = await post("/viewer-token", { projectId: "p1" });
    expect(res.status).toBe(403);
    expect(ensureInbox).not.toHaveBeenCalled();
  });

  it("answers 404 for a project the caller cannot see", async () => {
    projectAccess.mockResolvedValue(null);
    expect((await post("/viewer-token", { projectId: "p2" })).status).toBe(404);
  });

  it("simulates only into a subscription of the named project", async () => {
    const ok = await post("/simulate", {
      projectId: "p1",
      subscriptionId: "esub_1",
      event: { eventId: "sim_1", data: { text: "hi" } },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accepted: true, eventId: "sim_1" });
    expect(inbox.simulate).toHaveBeenCalledWith({
      logicalSubscriptionId: "esub_1",
      projectId: "p1",
      environmentId: null,
      bindingKey: "b".repeat(64),
      event: {
        eventId: "sim_1",
        name: "comment.created",
        timestamp: "2026-09-30T12:00:00.000Z",
        data: { text: "hi" },
      },
    });

    getSubscription.mockResolvedValue({
      _id: "x",
      projectId: "other",
      logicalId: "esub_9",
    });
    const foreign = await post("/simulate", {
      projectId: "p1",
      subscriptionId: "esub_9",
      event: { data: {} },
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).code).toBe("EVENTS_NOT_FOUND");
  });

  it("simulates only for the subscription's owner, whose credentials its triggers use", async () => {
    await post("/simulate", {
      projectId: "p1",
      subscriptionId: "esub_1",
      event: { data: {} },
    });
    expect(authorizeSimulation).toHaveBeenCalledWith(
      expect.anything(),
      "sub_doc_1",
    );

    // What the default seam throws when Convex refuses a non-owner.
    const { simulationRefusal } = await import("../events.js");
    authorizeSimulation.mockRejectedValue(
      simulationRefusal(
        new ConvexError({
          code: "FORBIDDEN",
          message: "Only the subscription's owner can simulate its events.",
        }),
      ),
    );
    inbox.simulate.mockClear();
    const res = await post("/simulate", {
      projectId: "p1",
      subscriptionId: "esub_1",
      event: { data: { text: "delete everything" } },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe(
      "Only the subscription's owner can simulate its events.",
    );
    expect(inbox.simulate).not.toHaveBeenCalled();
  });

  it("reports slot state with bounded rejection records", async () => {
    const res = await post("/slot-state", {
      projectId: "p1",
      subscriptionId: "esub_1",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "active",
      serverSubscriptionId: "srv_sub_1",
      observedSubscriptionIds: [],
      counts: { deliveries: 2 },
      rejections: [
        {
          reason: "bad_signature",
          slotId: "slotabcdefghijklmnopqrstuv",
          at: 5,
          headerNames: ["webhook-id"],
          bodyBytes: 10,
        },
      ],
    });
  });

  it("503s, not 500, when the viewer key is too short to sign with", async () => {
    process.env.EVENTS_INBOX_VIEWER_KEY = "too-short";
    const res = await post("/viewer-token", { projectId: "p1" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EVENTS_UNAVAILABLE");
    expect(ensureInbox).not.toHaveBeenCalled();
  });

  it("503s when the events plane is not configured", async () => {
    delete process.env.CONVEX_HTTP_URL;
    const res = await post("/viewer-token", { projectId: "p1" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EVENTS_UNAVAILABLE");
  });
});
