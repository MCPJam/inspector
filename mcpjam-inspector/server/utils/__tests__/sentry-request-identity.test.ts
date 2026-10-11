import { Hono } from "hono";
import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger } from "../logger.js";
import { getRequestLogger } from "../request-logger.js";
import { sentryRequestIdentityMiddleware } from "../sentry-request-identity.js";
import {
  createRequestStreamFailureReporter,
  oncePerTurn,
  type StreamFailureReporter,
} from "../stream-failure-reporter.js";
import {
  initializeDesktopSentryIdentity,
  setDesktopSentryActor,
} from "../../../shared/desktop-sentry-state.js";

type Captured = {
  message?: string;
  user?: { id?: string; email?: string };
  tags?: Record<string, unknown>;
};
let events: Captured[];
beforeEach(() => {
  events = [];
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.init({
    dsn: "https://public@example.invalid/1",
    defaultIntegrations: false,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === "event") events.push(payload as Captured);
        }
        return {};
      },
      flush: async () => true,
    }),
  });
});
afterEach(async () => {
  await Sentry.close(1000);
});

function app() {
  const server = new Hono();
  server.use("*", sentryRequestIdentityMiddleware);
  // Stand in for identity already verified by existing auth middleware.
  server.use("*", async (c, next) => {
    const user = c.req.header("x-test-user");
    const guest = c.req.header("x-test-guest");
    if (user) c.set("workosUserId", user);
    if (guest) c.set("guestId", guest);
    c.set("requestLogContext", {
      requestId: "request-test",
      authType: "unknown",
    } as never);
    if (c.req.header("x-test-local")) c.set("bridgeCaller", "local");
    await next();
  });
  return server;
}

describe("emitted Sentry identity", () => {
  it("isolates overlapping users and repeated errors", async () => {
    const server = app();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.get("/error", async (c) => {
      if (c.get("workosUserId") === "user_A") await wait;
      logger.error("failed", new Error("failure"));
      return c.json({ ok: true });
    });
    const first = server.request("/error", {
      headers: { "x-test-user": "user_A" },
    });
    await server.request("/error", { headers: { "x-test-user": "user_B" } });
    release();
    await first;
    await server.request("/error", { headers: { "x-test-user": "user_A" } });
    await Sentry.flush(1000);
    expect(events.map((event) => event.user?.id)).toEqual([
      "user_B",
      "user_A",
      "user_A",
    ]);
    expect(events.every((event) => event.tags?.actor_kind === "signedIn")).toBe(
      true,
    );
  });
  it("keeps guests identifiable and clears ambient identity for unknown requests", async () => {
    Sentry.setUser({ id: "ambient", email: "private@example.com" });
    Sentry.setTag("actor_kind", "signedIn");
    const server = app();
    server.get("/error", (c) => {
      logger.error("failed", new Error("failure"));
      return c.json({});
    });
    await server.request("/error", { headers: { "x-test-guest": "guest_A" } });
    await server.request("/error");
    await Sentry.flush(1000);
    expect(events[0].user).toEqual({ id: "guest_A" });
    expect(events[0].tags?.actor_kind).toBe("guest");
    expect(events[1].user?.id).toBeUndefined();
    expect(events[1].user?.email).toBeUndefined();
    expect(events[1].tags?.actor_kind).toBeUndefined();
  });
  it("uses verified actors before the desktop fallback, including guest rotation", async () => {
    initializeDesktopSentryIdentity("installation:desktop-test");
    setDesktopSentryActor(null);
    const server = app();
    server.get("/error", (c) => {
      logger.error("failed", new Error("failure"));
      return c.json({});
    });
    await server.request("/error", { headers: { "x-test-local": "1" } });
    await server.request("/error", {
      headers: {
        "x-test-local": "1",
        "x-test-user": "user_A",
        "x-test-guest": "guest_A",
      },
    });
    await server.request("/error", {
      headers: { "x-test-local": "1", "x-test-guest": "guest_A" },
    });
    await server.request("/error", {
      headers: { "x-test-local": "1", "x-test-guest": "guest_B" },
    });
    await Sentry.flush(1000);
    expect(
      events.map((event) => [event.user?.id, event.tags?.actor_kind]),
    ).toEqual([
      ["installation:desktop-test", "installation"],
      ["user_A", "signedIn"],
      ["guest_A", "guest"],
      ["guest_B", "guest"],
    ]);
  });
  it("binds delayed request logs, for both messages and exceptions", async () => {
    let log!: ReturnType<typeof getRequestLogger>;
    const server = app();
    server.get("/delayed", (c) => {
      log = getRequestLogger(c, "test");
      return c.json({});
    });
    await server.request("/delayed", { headers: { "x-test-user": "user_A" } });
    Sentry.setUser({ id: "user_B", email: "private@example.com" });
    log.event(
      "http.request.completed",
      { statusCode: 500 },
      { sentry: true },
    );
    log.event(
      "http.request.completed",
      { statusCode: 500 },
      { sentry: true, error: new Error("delayed") },
    );
    await Sentry.flush(1000);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.user)).toEqual([
      { id: "user_A" },
      { id: "user_A" },
    ]);
  });
  it("keeps the original desktop actor for delayed and deduplicated stream captures", async () => {
    initializeDesktopSentryIdentity("installation:desktop-test");
    setDesktopSentryActor({ id: "user_A", kind: "signedIn" });
    let report!: StreamFailureReporter;
    const server = app();
    server.get("/stream", (c) => {
      report = oncePerTurn(createRequestStreamFailureReporter(c, "chat"));
      return c.json({});
    });
    await server.request("/stream", { headers: { "x-test-local": "1" } });
    setDesktopSentryActor({ id: "user_B", kind: "signedIn" });
    const failure = {
      message: "stream failed",
      source: "mcp.chat-v2.backend-stream",
      hop: "mcpjam_internal",
      transport: "http_stream",
    } as const;
    const error = new Error("Request body exceeds 256 KiB limit");
    report({ ...failure, error });
    report({ ...failure, error });
    report({ ...failure, error: new Error("another failure") });
    await Sentry.flush(1000);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.user)).toEqual([
      { id: "user_A" },
      { id: "user_A" },
    ]);
  });
});
