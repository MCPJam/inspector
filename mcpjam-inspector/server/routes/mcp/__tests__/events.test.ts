/**
 * LOCAL `/api/mcp/events/*` against a REAL events MCP server (the SDK's
 * official-server fixture) through the real `MCPClientManager`, served on a
 * real socket so the fixture's webhook deliveries reach the development
 * receiver route exactly as they would on a desktop install.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
import { buildWebhookHeaders } from "@mcpjam/sdk/events";
import type { EventsStreamFrame } from "@/shared/events-api";
import {
  startEventsFixture,
  type EventsFixtureHandle,
} from "../../../../../sdk/tests/support/events-fixture.js";
import { createLocalEventsRouter } from "../events.js";
import { sessionAuthMiddleware } from "../../../middleware/session-auth.js";

const SERVER_ID = "events-fixture";

let fixture: EventsFixtureHandle;
let manager: MCPClientManager;
let server: ServerType;
let base: string;

beforeAll(async () => {
  fixture = await startEventsFixture({ allowInsecureCallbacks: true, nextPollMs: 1000 });
  manager = new MCPClientManager();
  await manager.connectToServer(SERVER_ID, { url: fixture.url, timeout: 10_000 });

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.mcpClientManager = manager;
    await next();
  });
  app.use("*", sessionAuthMiddleware);
  app.route(
    "/api/mcp/events",
    createLocalEventsRouter({
      publicOrigin: () => `${base}/api/mcp/events/hooks`,
      runtimeOptions: { pushOptions: { heartbeatIntervalMs: 60_000, maxBackoffMs: 200 } },
    }),
  );
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await manager.disconnectAllServers().catch(() => {});
  await fixture.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// The routes sit behind session auth like every `/api/mcp/*` route; tests
// present the process's session token like the browser does.
async function sessionToken(): Promise<string> {
  const { generateSessionToken, getSessionToken } = await import(
    "../../../services/session-token.js"
  );
  return getSessionToken() ?? generateSessionToken();
}

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/mcp/events${path}`, {
    method,
    headers: {
      "X-MCP-Session-Auth": `Bearer ${await sessionToken()}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function feed(): Promise<any[]> {
  return (await call("GET", "/feed?after=0&limit=1000")).body.entries;
}

describe("local events routes", () => {
  it("requires a session everywhere except the development receiver", async () => {
    const unauthenticated = await fetch(`${base}/api/mcp/events/feed`);
    expect(unauthenticated.status).toBe(401);
    const hook = await fetch(`${base}/api/mcp/events/hooks/i/nope/s/nope`, {
      method: "POST",
      body: "{}",
    });
    // Reached the route (no session needed) and was refused by the inbox.
    expect(hook.status).toBe(410);
  });

  it("reports support and lists descriptors", async () => {
    const support = await call("POST", "/support", { serverId: SERVER_ID });
    expect(support.status).toBe(200);
    expect(support.body.support).toMatchObject({ handshakeObserved: true, declared: true });
    expect(support.body.rawCapabilities).toHaveProperty("events");

    const list = await call("POST", "/list", { serverId: SERVER_ID });
    expect(list.status).toBe(200);
    expect(list.body.events.map((event: { name: string }) => event.name)).toEqual([
      "comment.created",
      "build.failed",
    ]);
    expect(list.body.support.declared).toBe(true);
  });

  it("polls once without creating a subscription", async () => {
    const first = await call("POST", "/poll", {
      serverId: SERVER_ID,
      name: "build.failed",
      arguments: {},
      cursor: null,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ events: [] });
    expect(typeof first.body.cursor).toBe("string");
  });

  it("maps a classified events error to EVENTS_RPC_ERROR", async () => {
    const response = await call("POST", "/poll", {
      serverId: SERVER_ID,
      name: "no.such.event",
      arguments: {},
      cursor: null,
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "EVENTS_RPC_ERROR",
      details: { kind: "NotFound", rpcCode: -32011 },
    });
  });

  it("creates a poll subscription whose events reach the feed", async () => {
    const created = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "main" },
      mode: "poll",
      profile: "draft@28ec35e",
    });
    expect(created.status).toBe(200);
    const id = created.body.subscription.id;
    expect(created.body.subscription).toMatchObject({ locality: "local", mode: "poll" });
    // Idempotent: the same live subscription again.
    const again = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "main" },
      mode: "poll",
      profile: "draft@28ec35e",
    });
    expect(again.body.subscription.id).toBe(id);

    await vi.waitFor(
      async () => {
        const list = await call("GET", `/subscriptions?serverId=${SERVER_ID}`);
        expect(list.body.subscriptions.find((s: any) => s.id === id).observedState).toBe("active");
      },
      { timeout: 5_000 },
    );
    await fixture.emit("build.failed", { branch: "main", buildId: "b1" });
    await vi.waitFor(
      async () => {
        const entries = await feed();
        expect(
          entries.find((entry) => entry.logicalSubscriptionId === id && entry.data?.buildId === "b1"),
        ).toMatchObject({ origin: "poll", namespace: "live", kind: "event" });
      },
      { timeout: 6_000, interval: 100 },
    );

    const paused = await call("POST", `/subscriptions/${id}/state`, { desiredState: "paused" });
    expect(paused.body.subscription.desiredState).toBe("paused");
    expect(paused.body.subscription.generation).toBe(2);
  });

  it("simulates into the simulation namespace", async () => {
    const created = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "sim" },
      mode: "poll",
      profile: "draft@28ec35e",
    });
    const simulated = await call("POST", "/simulate", {
      subscriptionId: created.body.subscription.id,
      event: { data: { branch: "sim", buildId: "s1" } },
    });
    expect(simulated.status).toBe(200);
    expect(simulated.body.entry).toMatchObject({
      origin: "simulation",
      namespace: "simulation",
      name: "build.failed",
      data: { branch: "sim", buildId: "s1" },
    });
    const missing = await call("POST", "/simulate", {
      subscriptionId: "esub_missing",
      event: { data: {} },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("EVENTS_NOT_FOUND");
  });

  it("refuses a local webhook unless the insecure receiver is acknowledged", async () => {
    const refused = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "comment.created",
      arguments: { document_id: "doc_x" },
      mode: "webhook",
      profile: "draft@28ec35e",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("EVENTS_UNAVAILABLE");
  });

  it("registers a webhook through the local receiver and journals deliveries end to end", async () => {
    const created = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "comment.created",
      arguments: { document_id: "doc_w" },
      mode: "webhook",
      profile: "draft@28ec35e",
      overrides: ["insecure-local-receiver"],
    });
    expect(created.status).toBe(200);
    const id = created.body.subscription.id;
    expect(created.body.subscription.overrides).toEqual(["insecure-local-receiver"]);

    let subscription: any;
    await vi.waitFor(
      async () => {
        const list = await call("GET", "/subscriptions");
        subscription = list.body.subscriptions.find((s: any) => s.id === id);
        expect(subscription.observedState).toBe("active");
      },
      { timeout: 5_000 },
    );
    // Plain http on the inspector's own port, under the hooks route.
    expect(subscription.callbackUrl).toMatch(
      new RegExp(`^${base}/api/mcp/events/hooks/i/[a-z2-7]+/s/[a-z2-7]+$`),
    );
    expect(JSON.stringify(subscription)).not.toMatch(/whsec_/);
    // The fixture verified the receiver through the challenge.
    expect(
      fixture.subscriptions().find((row) => row.url === subscription.callbackUrl),
    ).toMatchObject({ verified: true, active: true });

    await fixture.emit("comment.created", { document_id: "doc_w", comment_id: "w1", text: "hey" });
    await vi.waitFor(
      async () => {
        const entries = await feed();
        expect(
          entries.find((entry) => entry.logicalSubscriptionId === id && entry.kind === "event"),
        ).toMatchObject({
          origin: "webhook",
          eventId: expect.any(String),
          data: { document_id: "doc_w", comment_id: "w1", text: "hey" },
        });
      },
      { timeout: 5_000 },
    );

    // A forged delivery to the same slot is refused and never journalled.
    const forged = await fetch(subscription.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await buildWebhookHeaders({
          secrets: [`whsec_${Buffer.alloc(32, 7).toString("base64")}`],
          webhookId: "evt_forged",
          subscriptionId: "sub_forged",
          timestampSeconds: Math.floor(Date.now() / 1000),
          body: '{"eventId":"evt_forged"}',
        })),
      },
      body: '{"eventId":"evt_forged"}',
    });
    expect(forged.status).toBe(401);
    expect((await feed()).some((entry) => entry.eventId === "evt_forged")).toBe(false);

    const rotated = await call("POST", `/subscriptions/${id}/rotate`);
    expect(rotated.status).toBe(200);
  });

  it("delivers push events through events/stream", async () => {
    const created = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "comment.created",
      arguments: { document_id: "doc_p" },
      mode: "push",
      profile: "draft@28ec35e",
    });
    expect(created.status).toBe(200);
    const id = created.body.subscription.id;
    await vi.waitFor(() => expect(fixture.openStreams()).toBeGreaterThanOrEqual(1), {
      timeout: 5_000,
    });
    await fixture.emit("comment.created", { document_id: "doc_p", comment_id: "p1", text: "pushed" });
    await vi.waitFor(
      async () => {
        const entries = await feed();
        expect(
          entries.find((entry) => entry.logicalSubscriptionId === id && entry.kind === "event"),
        ).toMatchObject({ origin: "push", data: { comment_id: "p1" } });
      },
      { timeout: 5_000 },
    );
    await call("POST", `/subscriptions/${id}/state`, { desiredState: "removed" });
    await vi.waitFor(() => expect(fixture.openStreams()).toBe(0), { timeout: 5_000 });
  });

  it("streams a snapshot, the backlog, then live frames", async () => {
    const controller = new AbortController();
    const response = await fetch(
      `${base}/api/mcp/events/stream?after=0&_token=${await sessionToken()}`,
      { signal: controller.signal },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: EventsStreamFrame[] = [];
    let buffer = "";
    const readUntil = async (predicate: () => boolean) => {
      while (!predicate()) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("");
          if (data) frames.push(JSON.parse(data));
        }
      }
    };
    await readUntil(() => frames.length >= 1);
    expect(frames[0]).toMatchObject({ type: "snapshot", subscriptions: expect.any(Array) });
    const snapshot = frames[0] as Extract<EventsStreamFrame, { type: "snapshot" }>;
    expect(snapshot.nextAfter).toBeGreaterThan(0);
    await readUntil(() => frames.filter((f) => f.type === "entry").length >= snapshot.nextAfter);

    const target = snapshot.subscriptions.find((s) => s.mode === "poll")!;
    await call("POST", "/simulate", {
      subscriptionId: target.id,
      event: { eventId: "sim_live_1", data: { branch: "sim", buildId: "live" } },
    });
    await readUntil(() =>
      frames.some((f) => f.type === "entry" && f.entry.eventId === "sim_live_1"),
    );
    controller.abort();
  });

  // LAST: it wipes the connection's capability capture.
  it("answers list for an undeclared server with 200 and refuses poll", async () => {
    (manager as unknown as { eventsCapabilityCapture: { clear(id: string): void } })
      .eventsCapabilityCapture.clear(SERVER_ID);
    const before = fixture.received.length;
    const list = await call("POST", "/list", { serverId: SERVER_ID });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ events: [], support: { declared: false } });
    const poll = await call("POST", "/poll", {
      serverId: SERVER_ID,
      name: "build.failed",
      arguments: {},
      cursor: null,
    });
    expect(poll.status).toBe(400);
    expect(poll.body.code).toBe("EVENTS_UNDECLARED");
    // Neither reached the wire.
    expect(fixture.received.slice(before).filter((row) => row.method.startsWith("events/"))).toEqual([]);
  });
});
