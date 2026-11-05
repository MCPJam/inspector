import { COMPLETED_TURN_RETRY_TTL_MS } from "../../../services/completed-turn-persistence.js";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PersistReceiptData } from "@/shared/persist-receipt";
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  membership: true,
  tokenBlocked: false,
}));
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (
    c: {
      req: { header: (key: string) => string };
      set: (key: string, value: string) => void;
      json: (body: unknown, status: number) => Response;
    },
    next: () => Promise<void>,
  ) => {
    const token = c.req.header("authorization");
    mocks.verify(token);
    if (!token?.startsWith("Bearer fresh-"))
      return c.json({ error: "Expired" }, 401);
    c.set("authMethod", "authkit_jwt");
    c.set("workosSessionId", "session");
    c.set("workosUserId", token.slice("Bearer fresh-".length));
    return next();
  },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async (c: {
    req: { header: (name: string) => string };
  }) =>
    mocks.tokenBlocked
      ? new Promise<string>(() => {})
      : c.req.header("authorization").slice(7),
}));
import routes from "../chat-persistence.js";
import { persistChatSessionToConvex } from "../../../utils/chat-ingestion.js";
import { finishPendingPersist } from "../../../utils/completed-turn-finalization.js";
import { completedTurnPersistence } from "../../../services/completed-turn-persistence.js";
import { createPersistReceiptRecovery } from "../../../../client/src/lib/persist-receipt-recovery.js";

const app = new Hono().route("/api/web/chat-persistence", routes);
const bodies: string[] = [];
beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  bodies.length = 0;
  mocks.membership = true;
  mocks.tokenBlocked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      if (input.endsWith("/web/authorize-project"))
        return Response.json(
          mocks.membership
            ? { chatEnvironments: true }
            : { error: "No access" },
          { status: mocks.membership ? 200 : 403 },
        );
      expect(input).toBe("https://convex.test/ingest-chat");
      bodies.push(String(init.body));
      return init.headers &&
        new Headers(init.headers).get("authorization") === "Bearer expired"
        ? Response.json(
            { error: "Could not validate token: token expired" },
            { status: 500 },
          )
        : Response.json({ version: 2 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("recovers an expired final ingest through a real route and client receipt without replaying the completed operation", async () => {
  let operations = 0;
  operations++;
  const first = await persistChatSessionToConvex({
    chatSessionId: "chat",
    modelId: "model",
    modelSource: "mcpjam",
    origin: "playground",
    startedAt: 1,
    projectId: "project",
    authHeader: "Bearer expired",
    retryOwner: { subject: "actor", projectId: "project" },
    turnTrace: { turnId: "turn" } as never,
    sessionMessages: [{ role: "user", content: "private completed payload" }],
  });
  expect(first.outcome).toBe("failed");
  const recovery = createPersistReceiptRecovery(async (input, init) =>
    app.request(String(input), {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fresh-actor",
      },
    }),
  );
  let clientResult: Promise<PersistReceiptData> | undefined;
  const result = await finishPendingPersist(
    first,
    {
      write(chunk) {
        if (chunk.type !== "data-persist-receipt")
          throw new Error("Unexpected part");
        const data = chunk.data as PersistReceiptData;
        clientResult = recovery(data);
        expect(recovery(data)).toBe(clientResult);
      },
    },
    { chatSessionId: "chat", turnId: "turn" },
  );
  expect(result).toEqual({ outcome: "saved", version: 2 });
  expect(await clientResult).toMatchObject({ outcome: "saved", version: 2 });
  expect(new Set(bodies).size).toBe(1);
  expect(operations).toBe(1);
  expect(bodies).toHaveLength(4); // Three bounded expired attempts, one fresh save.
});

it("rejects forged scope and replacement bodies without consuming the owner; revocation releases its waiter", async () => {
  const id = completedTurnPersistence.register(
    { subject: "actor", projectId: "project" },
    '{"chatSessionId":"chat","turnId":"turn"}',
    "chat",
    "turn",
  )!;
  const body = {
    retryHandle: id,
    projectId: "project",
    chatSessionId: "chat",
    turnId: "turn",
  };
  const request = (value: unknown, token = "fresh-actor") =>
    app.request("/api/web/chat-persistence", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(value),
    });
  expect((await request(body, "expired")).status).toBe(401);
  expect((await request(body, "fresh-other")).status).toBe(404);
  expect((await request({ ...body, projectId: "other" })).status).toBe(404);
  expect((await request({ ...body, turnId: "other" })).status).toBe(404);
  expect((await request({ ...body, body: "replacement" })).status).toBe(400);
  const waiting = completedTurnPersistence.wait(id);
  mocks.membership = false;
  expect((await request(body)).status).toBe(403);
  expect(await waiting).toMatchObject({ outcome: "failed" });
  expect((await request(body)).status).toBe(404);
  expect(bodies).toHaveLength(0);
});

it("cancels a waiting finalizer on client disconnect without any replay", async () => {
  const id = completedTurnPersistence.register(
    { subject: "actor", projectId: "project" },
    "{}",
    "chat",
    "turn",
  )!;
  const controller = new AbortController();
  const result = finishPendingPersist(
    { outcome: "failed", failureKind: "http_error", retryHandle: id },
    { write() {} },
    { chatSessionId: "chat", turnId: "turn" },
    controller.signal,
  );
  controller.abort();
  expect(await result).toMatchObject({ outcome: "failed" });
  expect(
    await completedTurnPersistence.retry(
      id,
      {
        subject: "actor",
        projectId: "project",
        chatSessionId: "chat",
        turnId: "turn",
      },
      vi.fn(),
    ),
  ).toBe("missing");
  expect(bodies).toHaveLength(0);
});

it.each(["token", "authorization"])(
  "ends the HTTP request and releases the waiter when %s never settles",
  async (stage) => {
    vi.useFakeTimers();
    mocks.tokenBlocked = stage === "token";
    vi.mocked(global.fetch).mockImplementation(
      async () => new Promise<Response>(() => {}),
    );
    const id = completedTurnPersistence.register(
      { subject: "actor", projectId: "project" },
      "{}",
      "chat",
      "turn",
    )!;
    const waiting = completedTurnPersistence.wait(id);
    const response = app.request("/api/web/chat-persistence", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fresh-actor",
      },
      body: JSON.stringify({
        retryHandle: id,
        projectId: "project",
        chatSessionId: "chat",
        turnId: "turn",
      }),
    });
    await vi.advanceTimersByTimeAsync(COMPLETED_TURN_RETRY_TTL_MS);
    expect((await response).status).toBe(200);
    expect(await waiting).toMatchObject({ outcome: "failed" });
    vi.useRealTimers();
  },
);
