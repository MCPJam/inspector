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
import type { EventsFeedEntryView, EventsStreamFrame } from "@/shared/events-api";
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

/** Open `/stream?<query>` and collect its frames as they are read. */
async function openStream(query: string) {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/api/mcp/events/stream?${query}&_token=${await sessionToken()}`,
    { signal: controller.signal },
  );
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
  return { response, frames, readUntil, close: () => controller.abort() };
}

describe("local events routes", () => {
  it("requires a session everywhere except the development receiver", async () => {
    const unauthenticated = await fetch(`${base}/api/mcp/events/feed`);
    expect(unauthenticated.status).toBe(401);
    const hook = await fetch(`${base}/api/mcp/events/hooks/events-fixture/i/nope/s/nope`, {
      method: "POST",
      body: "{}",
    });
    // Reached the route (no session needed) and was refused by the inbox.
    expect(hook.status).toBe(404);
    expect(await hook.json()).toEqual({ error: "unknown_slot" });
    const oldHook = await fetch(`${base}/api/mcp/events/hooks/i/nope/s/nope`, {
      method: "POST",
      body: "{}",
    });
    expect(oldHook.status).toBe(404);
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
      host: null,
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
      host: null,
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

  it("accepts every registered profile id, the historical ChatGPT one included", async () => {
    for (const profile of ["chatgpt@2026-11-05", "chatgpt@2026-09-30"]) {
      const created = await call("POST", "/subscriptions", {
        serverId: SERVER_ID,
        eventName: "build.failed",
        arguments: { branch: profile },
        mode: "poll",
        host: null,
        profile,
      });
      expect(created.status).toBe(200);
      expect(created.body.subscription.profile).toBe(profile);
    }
    const unknown = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "unknown" },
      mode: "poll",
      host: null,
      profile: "chatgpt@1999-01-01",
    });
    expect(unknown.status).toBe(400);
  });

  it("refuses a subscription that names no client, never defaulting one", async () => {
    const missing = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: {},
      mode: "poll",
    });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: "EVENTS_HOST_REQUIRED",
      message: "Choose the client to subscribe as, or MCPJam (built-in).",
    });
    const unreadable = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: {},
      mode: "poll",
      host: { id: "host_1", name: "ChatGPT", eventDeliveryModes: ["sse"] },
    });
    expect(unreadable.status).toBe(400);
    expect(unreadable.body.code).toBe("EVENTS_HOST_REQUIRED");
  });

  it("refuses a mode the client doesn't receive, as the Subscribe button would", async () => {
    const chatgpt = {
      id: "host_1",
      name: "ChatGPT",
      eventDeliveryModes: ["webhook"],
    };
    const refused = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "refused" },
      mode: "poll",
      host: chatgpt,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: "EVENTS_MODE_UNSUPPORTED",
      message:
        "ChatGPT doesn't receive events by poll. Turn it on in the client's Events tab, or pick another client.",
    });
    const none = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "none" },
      mode: "poll",
      host: { id: "host_2", name: "Claude", eventDeliveryModes: [] },
    });
    expect(none.status).toBe(400);
    expect(none.body.message).toBe(
      "Claude doesn't receive events. Turn on a delivery mode in the client's Events tab, or pick another client.",
    );
  });

  it("records the client, and refuses the same subscription under another one", async () => {
    const mcpjam = {
      id: "host_1",
      name: "Team MCPJam",
      eventDeliveryModes: ["poll", "push", "webhook"],
    };
    const created = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "hosts" },
      mode: "poll",
      host: mcpjam,
    });
    expect(created.status).toBe(200);
    expect(created.body.subscription.host).toEqual({
      id: "host_1",
      name: "Team MCPJam",
    });
    expect(created.body.subscription).not.toHaveProperty("profile");
    const again = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "hosts" },
      mode: "poll",
      host: null,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("EVENTS_CONFLICT");
    // Named, so the user can find the subscription that holds the event.
    expect(again.body.message).toBe(
      "build.failed is already subscribed under Team MCPJam with the same arguments. Remove that subscription in the Events tab, then subscribe again.",
    );
  });

  it("simulates into the simulation namespace", async () => {
    const created = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "build.failed",
      arguments: { branch: "sim" },
      mode: "poll",
      host: null,
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
      host: null,
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
      host: null,
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
      new RegExp(`^${base}/api/mcp/events/hooks/${SERVER_ID}/i/[a-z2-7]+/s/[a-z2-7]+$`),
    );
    expect(subscription.callbackVerifiedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(subscription)).not.toMatch(/whsec_/);
    expect(fixture.received).toContainEqual(expect.objectContaining({
      method: "events/subscribe",
      params: expect.objectContaining({
        delivery: expect.objectContaining({ url: subscription.callbackUrl }),
        ttlMs: 600_000,
      }),
    }));

    const wrongServer = subscription.callbackUrl.replace(`/hooks/${SERVER_ID}/`, "/hooks/other-server/");
    const wrong = await fetch(wrongServer, { method: "POST", body: "{}" });
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual({ error: "unknown_slot" });
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

  it("validates custom URLs and pins a live subscription to its receiver", async () => {
    const request = {
      serverId: SERVER_ID,
      eventName: "comment.created",
      arguments: { document_id: "doc_custom" },
      mode: "webhook",
      host: null,
    };
    const invalid = await call("POST", "/subscriptions", {
      ...request,
      receiver: { kind: "custom", baseUrl: "https://user:pass@example.com/hooks" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toBe("Remove the credentials from the callback URL.");

    const custom = {
      kind: "custom",
      baseUrl: `${base}/api/mcp/events/hooks/`,
    };
    const created = await call("POST", "/subscriptions", {
      ...request,
      receiver: custom,
      overrides: ["insecure-local-receiver"],
      ttlMs: null,
    });
    expect(created.status).toBe(200);
    const id = created.body.subscription.id;
    await vi.waitFor(async () => {
      const list = await call("GET", "/subscriptions");
      const subscription = list.body.subscriptions.find((row: { id: string }) => row.id === id);
      expect(subscription).toMatchObject({
        observedState: "active",
        callbackVerifiedAt: expect.any(Number),
      });
    });
    expect(fixture.received).toContainEqual(expect.objectContaining({
      method: "events/subscribe",
      params: expect.objectContaining({ ttlMs: null }),
    }));

    const conflict = await call("POST", "/subscriptions", { ...request, receiver: { kind: "local" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("EVENTS_CONFLICT");
    const replay = await call("POST", "/subscriptions", {
      ...request,
      receiver: { ...custom, baseUrl: custom.baseUrl.slice(0, -1) },
      overrides: ["insecure-local-receiver"],
    });
    expect(replay.body.subscription.id).toBe(id);
    await call("POST", `/subscriptions/${id}/state`, { desiredState: "removed" });
  });

  it("routes a server named like a URL dot segment without confusing similarly named servers", async () => {
    const serverId = "..";
    await manager.connectToServer(serverId, { url: fixture.url });
    try {
      const created = await call("POST", "/subscriptions", {
        serverId,
        eventName: "comment.created",
        arguments: { document_id: "doc_dot" },
        mode: "webhook",
        host: null,
        overrides: ["insecure-local-receiver"],
      });
      expect(created.status).toBe(200);
      const id = created.body.subscription.id;
      await vi.waitFor(async () => {
        const list = await call("GET", "/subscriptions");
        const subscription = list.body.subscriptions.find((row: { id: string }) => row.id === id);
        expect(subscription).toMatchObject({
          callbackUrl: expect.stringContaining("/hooks/~../i/"),
          callbackVerifiedAt: expect.any(Number),
        });
      });
      await call("POST", `/subscriptions/${id}/state`, { desiredState: "removed" });
    } finally {
      await manager.disconnectServer(serverId);
    }
  });

  it.each([
    {
      serverId: "beta-auth",
      options: { acceptedTokens: ["fixture-token"] },
      error: { kind: "callback_auth_required", retryable: false },
    },
    {
      serverId: "beta-tls",
      options: {
        deliveryFetch: async () => {
          throw new TypeError("fetch failed", { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
        },
      },
      error: { kind: "callback_tls_error", retryable: true },
    },
  ])("preserves classified subscribe refusals from $serverId", async ({ serverId, options, error }) => {
    const beta = await startEventsFixture({ beta: true, ...options });
    try {
      await manager.connectToServer(serverId, { url: beta.url });
      const created = await call("POST", "/subscriptions", {
        serverId,
        eventName: "comment.created",
        arguments: { document_id: serverId },
        mode: "webhook",
        host: null,
        receiver: { kind: "custom", baseUrl: "https://localhost:9443/hooks" },
      });
      expect(created.status).toBe(200);
      const id = created.body.subscription.id;
      await vi.waitFor(async () => {
        const list = await call("GET", "/subscriptions");
        const subscription = list.body.subscriptions.find((row: { id: string }) => row.id === id);
        expect(subscription?.lastError).toMatchObject(error);
      });
      await call("POST", `/subscriptions/${id}/state`, { desiredState: "removed" });
    } finally {
      await manager.disconnectServer(serverId);
      await beta.close();
    }
  });

  it("delivers push events through events/stream", async () => {
    const created = await call("POST", "/subscriptions", {
      serverId: SERVER_ID,
      eventName: "comment.created",
      arguments: { document_id: "doc_p" },
      mode: "push",
      host: null,
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
    const { response, frames, readUntil, close } = await openStream("after=0");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
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
    close();
  });

  // After the unscoped stream test: that one expects every journal entry in
  // the default project's backlog.
  it("scopes subscriptions, the feed and the stream to the project", async () => {
    const create = async (projectId: string) =>
      (
        await call("POST", "/subscriptions", {
          projectId,
          serverId: SERVER_ID,
          eventName: "build.failed",
          arguments: { branch: "scoped" },
          mode: "poll",
          host: null,
        })
      ).body.subscription;
    const a = await create("proj_a");
    const b = await create("proj_b");
    // The same subscription in another project is another subscription.
    expect(b.id).not.toBe(a.id);
    const simulate = (subscriptionId: string, buildId: string) =>
      call("POST", "/simulate", {
        subscriptionId,
        event: { data: { branch: "scoped", buildId } },
      });
    await simulate(a.id, "a1");
    await simulate(b.id, "b1");
    await simulate(a.id, "a2");
    await simulate(b.id, "b2");
    const buildIds = (entries: EventsFeedEntryView[]) =>
      entries.filter((entry) => entry.kind === "event").map((entry) => entry.data?.buildId);

    // The stream: project B's snapshot and backlog, then only its live frames.
    const { frames, readUntil, close } = await openStream("after=0&projectId=proj_b");
    const streamed = () =>
      buildIds(frames.flatMap((frame) => (frame.type === "entry" ? [frame.entry] : [])));
    await readUntil(() => streamed().includes("b2"));
    const snapshot = frames[0] as Extract<EventsStreamFrame, { type: "snapshot" }>;
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.subscriptions.map((s) => s.id)).toEqual([b.id]);
    await simulate(a.id, "a3");
    // Removing A tells project A's listeners only.
    await call("POST", `/subscriptions/${a.id}/state`, { desiredState: "removed" });
    await simulate(b.id, "b3");
    await readUntil(() => streamed().includes("b3"));
    close();
    expect(streamed()).toEqual(["b1", "b2", "b3"]);
    expect(
      frames.some((frame) => frame.type === "subscription" && frame.subscription.id === a.id),
    ).toBe(false);

    // The feed: A's occurrences stay in A after its removal, and nowhere else.
    const feedOf = async (projectId: string, after = 0, limit = 1000) =>
      (await call("GET", `/feed?after=${after}&limit=${limit}&projectId=${projectId}`)).body;
    expect(buildIds((await feedOf("proj_a")).entries)).toEqual(["a1", "a2", "a3"]);
    expect(buildIds((await feedOf("proj_b")).entries)).toEqual(["b1", "b2", "b3"]);
    const unscoped = await feed();
    expect(unscoped.some((entry) => [a.id, b.id].includes(entry.logicalSubscriptionId))).toBe(false);
    // A full page resumes after its last entry; a short one reaches the head.
    const first = await feedOf("proj_b", 0, 1);
    expect(buildIds(first.entries)).toEqual(["b1"]);
    expect(first.nextAfter).toBe(first.entries[0].seq);
    const rest = await feedOf("proj_b", first.nextAfter, 2);
    expect(buildIds(rest.entries)).toEqual(["b2", "b3"]);
    expect((await feedOf("proj_b", rest.nextAfter)).entries).toEqual([]);

    // The registry: each project lists its own, the removed one included.
    const listed = async (query: string): Promise<string[]> =>
      (await call("GET", `/subscriptions?serverId=${SERVER_ID}${query}`)).body.subscriptions.map(
        (s: { id: string }) => s.id,
      );
    expect(await listed("&projectId=proj_a")).toEqual([a.id]);
    expect(await listed("&projectId=proj_b")).toEqual([b.id]);
    const defaults = await listed("");
    expect(defaults).not.toContain(a.id);
    expect(defaults).not.toContain(b.id);
    await call("POST", `/subscriptions/${b.id}/state`, { desiredState: "removed" });
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
