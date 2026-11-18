/**
 * MCP Events end to end through the REAL `MCPClientManager` against the
 * official-server-SDK fixture (`support/events-fixture.ts`), with webhook
 * deliveries landing on a real HTTPS receiver (`support/events-tls.ts`).
 *
 * Phase-1 exit gates proven here:
 *   - raw capability capture sees `capabilities.events` that the official
 *     client strips (both eras);
 *   - a sentinel secret never appears in any captured RPC frame across
 *     subscribe, refresh and failed requests — while the server receives the
 *     exact secret;
 *   - registration survives the challenge arriving inside subscribe, the first
 *     event beating the subscribe response, and a lost subscribe response.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { RpcLogEvent } from "../src/mcp-client-manager/types.js";
import { MCPEventsWireError } from "../src/mcp-client-manager/events-ext-guards.js";
import {
  EventsCoordinator,
  applySubscriptionPatch,
} from "../src/events/coordinator.js";
import type {
  EventsRpcPort,
  SubscriptionRecord,
} from "../src/events/types.js";
import { computeBindingKey } from "../src/events/identity.js";
import { DRAFT_PROFILE_ID } from "../src/events/profiles.js";
import { startEventsFixture, type EventsFixtureHandle } from "./support/events-fixture.js";
import {
  startHttpsInbox,
  trustingFetch,
  mintTestCertificate,
  type HttpsInboxHandle,
} from "./support/events-tls.js";

const SERVER_ID = "events-fixture";
const opened: {
  fixtures: EventsFixtureHandle[];
  inboxes: HttpsInboxHandle[];
  managers: MCPClientManager[];
} = { fixtures: [], inboxes: [], managers: [] };

afterEach(async () => {
  await Promise.all(opened.managers.map((m) => m.disconnectAllServers().catch(() => {})));
  await Promise.all(opened.fixtures.map((f) => f.close()));
  await Promise.all(opened.inboxes.map((i) => i.close()));
  opened.fixtures = [];
  opened.inboxes = [];
  opened.managers = [];
});

async function fixture(
  options: Parameters<typeof startEventsFixture>[0] = {}
): Promise<EventsFixtureHandle> {
  const handle = await startEventsFixture({
    deliveryFetch: trustingFetch(mintTestCertificate()),
    ...options,
  });
  opened.fixtures.push(handle);
  return handle;
}

async function httpsInbox(): Promise<HttpsInboxHandle> {
  const handle = await startHttpsInbox();
  opened.inboxes.push(handle);
  return handle;
}

async function connect(
  url: string,
  options: { protocolVersion?: "2025-11-25" | "2026-07-28" } = {}
): Promise<{ manager: MCPClientManager; frames: RpcLogEvent[] }> {
  const frames: RpcLogEvent[] = [];
  const manager = new MCPClientManager(
    {},
    { rpcLogger: (event) => frames.push(structuredClone(event)) }
  );
  opened.managers.push(manager);
  await manager.connectToServer(SERVER_ID, {
    url,
    timeout: 10_000,
    ...(options.protocolVersion
      ? { mcpProtocolVersion: options.protocolVersion as never }
      : {}),
  });
  return { manager, frames };
}

function rpcPort(manager: MCPClientManager): EventsRpcPort {
  return {
    list: (params) => manager.listServerEvents(SERVER_ID, params),
    poll: (params) => manager.pollServerEvents(SERVER_ID, params),
    subscribe: (params) => manager.subscribeServerEvents(SERVER_ID, params),
    unsubscribe: (params) => manager.unsubscribeServerEvents(SERVER_ID, params),
  };
}

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: "esub_test",
    projectId: "proj_1",
    environmentId: null,
    bindingKey: computeBindingKey({
      serverId: SERVER_ID,
      credentialOwnerUserId: "user_1",
      credentialFingerprint: null,
    }),
    serverId: SERVER_ID,
    profile: DRAFT_PROFILE_ID,
    eventName: "comment.created",
    arguments: { document_id: "doc_1" },
    mode: "webhook",
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

describe("capability capture (C10)", () => {
  for (const protocolVersion of ["2025-11-25", "2026-07-28"] as const) {
    it(`reads top-level capabilities.events the official client strips (${protocolVersion})`, async () => {
      const server = await fixture();
      const { manager } = await connect(server.url, { protocolVersion });
      // The official client's parsed capabilities have no `events` …
      expect(
        (manager.getServerCapabilities(SERVER_ID) as Record<string, unknown>)?.events
      ).toBeUndefined();
      // … but the raw handshake did carry it.
      const support = manager.getEventsSupport(SERVER_ID);
      expect(support).toMatchObject({
        handshakeObserved: true,
        declared: true,
        listChanged: true,
      });
    });
  }

  it("resets the capture on disconnect", async () => {
    const server = await fixture();
    const { manager } = await connect(server.url);
    expect(manager.getEventsSupport(SERVER_ID).declared).toBe(true);
    await manager.disconnectServer(SERVER_ID);
    expect(manager.getEventsSupport(SERVER_ID)).toMatchObject({
      handshakeObserved: false,
      declared: false,
    });
  });
});

describe("events/list and events/poll", () => {
  it("lists descriptors and polls with cursor semantics", async () => {
    const server = await fixture();
    const { manager } = await connect(server.url);
    const listing = await manager.listServerEvents(SERVER_ID);
    expect(listing.events.map((event) => event.name)).toEqual([
      "comment.created",
      "build.failed",
    ]);

    // `cursor: null` starts from now: no history replayed.
    await server.emit("comment.created", { document_id: "doc_1", comment_id: "c0", text: "old" });
    const first = await manager.pollServerEvents(SERVER_ID, {
      name: "comment.created",
      arguments: { document_id: "doc_1" },
      cursor: null,
    });
    expect(first.events).toEqual([]);
    expect(first.cursor).toBe("c1");

    await server.emit("comment.created", { document_id: "doc_1", comment_id: "c1", text: "hi" });
    await server.emit("comment.created", { document_id: "doc_2", comment_id: "c2", text: "other doc" });
    const second = await manager.pollServerEvents(SERVER_ID, {
      name: "comment.created",
      arguments: { document_id: "doc_1" },
      cursor: first.cursor ?? null,
    });
    expect(second.events.map((event) => event.data.comment_id)).toEqual(["c1"]);
  });

  it("refuses events/* before the wire when the capability is undeclared", async () => {
    const server = await fixture();
    const { manager } = await connect(server.url);
    // Simulate a server that did not declare: disconnect wipes the capture,
    // and a manager with no observed handshake must refuse rather than probe.
    (manager as unknown as { eventsCapabilityCapture: { clear(id: string): void } })
      .eventsCapabilityCapture.clear(SERVER_ID);
    const before = server.received.length;
    await expect(manager.listServerEvents(SERVER_ID)).rejects.toBeInstanceOf(
      MCPEventsWireError
    );
    expect(server.received.length).toBe(before);
    // The explicit conformance escape hatch still reaches the wire.
    await expect(
      manager.listServerEvents(SERVER_ID, undefined, { allowUndeclared: true })
    ).resolves.toMatchObject({ events: expect.any(Array) });
  });
});

describe("webhook lifecycle through the coordinator (C3/C4)", () => {
  it("subscribes with the challenge inside subscribe, delivers, refreshes and removes", async () => {
    const server = await fixture();
    const inbox = await httpsInbox();
    const { manager } = await connect(server.url);
    let now = Date.now();
    const coordinator = new EventsCoordinator({
      clock: { now: () => now },
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });

    let sub = record();
    const subscribed = await coordinator.step(sub);
    expect(subscribed.action).toBe("subscribed");
    sub = applySubscriptionPatch(sub, subscribed);
    expect(sub.observedState).toBe("active");
    expect(sub.serverSubscriptionId).toMatch(/^sub_/);
    expect(sub.callbackUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/i\//);
    // The verification challenge reached the (then still pending) slot.
    expect(server.deliveries.filter((d) => d.kind === "verification")).toHaveLength(1);
    expect(server.deliveries[0]!.status).toBe(200);
    expect(inbox.inbox.slotState(sub.slotId!)?.state).toBe("active");
    // Refresh is scheduled before the grant expires.
    expect(sub.nextActionAt).toBeLessThan(sub.refreshBefore!);

    await server.emit("comment.created", { document_id: "doc_1", comment_id: "c1", text: "hi" });
    const { entries } = inbox.inbox.read(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "event",
      eventId: "evt_1",
      logicalSubscriptionId: "esub_test",
      dispatch: "pending",
      serverSubscriptionId: sub.serverSubscriptionId,
    });

    now = sub.nextActionAt;
    const refreshed = await coordinator.step(sub);
    expect(refreshed.action).toBe("refreshed");
    sub = applySubscriptionPatch(sub, refreshed);
    expect(server.subscriptions()).toHaveLength(1);
    // Consent is cached per (principal, url): no second challenge.
    expect(server.deliveries.filter((d) => d.kind === "verification")).toHaveLength(1);

    sub = { ...sub, desiredState: "removed", generation: sub.generation + 1 };
    const unsubscribed = await coordinator.step(sub);
    expect(unsubscribed.action).toBe("unsubscribed");
    sub = applySubscriptionPatch(sub, unsubscribed);
    expect(server.subscriptions()).toHaveLength(0);
    expect(inbox.inbox.slotState(sub.slotId!)?.state).toBe("removed");

    // The second unsubscribe after the late-refresh window answers NotFound,
    // which is "already gone" — and settles the removal.
    now = sub.nextActionAt;
    const settled = await coordinator.step(sub);
    expect(settled.action).toBe("removal_settled");
    expect(applySubscriptionPatch(sub, settled).observedState).toBe("removed");
  });

  it("accepts an event that arrives before the subscribe response", async () => {
    const server = await fixture({ misbehavior: { eventBeforeResponse: true } });
    const inbox = await httpsInbox();
    const { manager } = await connect(server.url);
    const coordinator = new EventsCoordinator({
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });
    const outcome = await coordinator.step(record());
    expect(outcome.action).toBe("subscribed");
    const eventDelivery = server.deliveries.find((d) => d.kind === "event");
    expect(eventDelivery?.status).toBe(200);
    const [entry] = inbox.inbox.read(0).entries;
    expect(entry).toMatchObject({ kind: "event", dispatch: "pending" });
  });

  it("retries a lost subscribe response with the same key and converges", async () => {
    const server = await fixture({ misbehavior: { dropSubscribeResponses: 1 } });
    const inbox = await httpsInbox();
    const { manager } = await connect(server.url);
    let now = 1_000_000;
    const coordinator = new EventsCoordinator({
      clock: { now: () => now },
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });
    let sub = record();
    const lost = await coordinator.step(sub);
    expect(lost.action).toBe("failed");
    expect(lost.failure?.retryable).toBe(true);
    sub = applySubscriptionPatch(sub, lost);
    // The slot exists and stays pending until an id is reconciled.
    expect(inbox.inbox.slotState(sub.slotId!)?.state).toBe("pending");
    expect(server.subscriptions()).toHaveLength(1);

    now = sub.nextActionAt;
    const retried = await coordinator.step(sub);
    expect(retried.action).toBe("subscribed");
    sub = applySubscriptionPatch(sub, retried);
    expect(server.subscriptions()).toHaveLength(1);
    expect(inbox.inbox.slotState(sub.slotId!)?.state).toBe("active");
  });

  it("records a conflicting server id instead of merging it", async () => {
    const server = await fixture();
    const inbox = await httpsInbox();
    const { manager } = await connect(server.url);
    const coordinator = new EventsCoordinator({
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });
    let sub = applySubscriptionPatch(record(), await coordinator.step(record()));
    const original = sub.serverSubscriptionId;
    server.misbehave({ conflictingId: true });
    sub = applySubscriptionPatch(sub, await coordinator.step(sub));
    expect(sub.serverSubscriptionId).toBe(original);
    expect(sub.conflictingServerSubscriptionId).toMatch(/^sub_conflict_/);
    expect(sub.lastError?.kind).toBe("subscription_id_conflict");
  });

  it("rejects forged deliveries and never lets them change a binding", async () => {
    const server = await fixture();
    const inbox = await httpsInbox();
    const { manager } = await connect(server.url);
    const coordinator = new EventsCoordinator({
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });
    const sub = applySubscriptionPatch(record(), await coordinator.step(record()));
    server.misbehave({ badSignature: true });
    await server.emit("comment.created", { document_id: "doc_1", comment_id: "x", text: "forged" });
    expect(server.deliveries.at(-1)?.status).toBe(401);
    expect(inbox.inbox.read(0).entries).toHaveLength(0);
    expect(inbox.inbox.slotState(sub.slotId!)?.serverSubscriptionId).toBe(
      sub.serverSubscriptionId
    );
    const rejection = inbox.inbox.rejections.at(-1)!;
    expect(rejection.reason).toBe("bad_signature");
    // Bounded metadata only: no body, no signature value.
    expect(JSON.stringify(rejection)).not.toContain("forged");
    expect(JSON.stringify(rejection)).not.toContain("v1,");
  });

  it("rotates: new secret first, overlap, retire after a successful refresh", async () => {
    const server = await fixture();
    const inbox = await httpsInbox();
    const { manager } = await connect(server.url);
    const coordinator = new EventsCoordinator({
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });
    let sub = applySubscriptionPatch(record(), await coordinator.step(record()));
    const before = await inbox.inbox.getSecret(sub.slotId!);
    sub = { ...sub, rotation: { phase: "requested", at: 0 } };
    // Refresh response lost mid-rotation: the old secret must stay valid.
    server.misbehave({ dropSubscribeResponses: 1 });
    sub = applySubscriptionPatch(sub, await coordinator.step(sub));
    expect(sub.rotation?.phase).toBe("rotated");
    expect(inbox.inbox.slotState(sub.slotId!)?.hasPreviousSecret).toBe(true);
    // The server holds the new secret and dual-signs; deliveries verify.
    await server.emit("comment.created", { document_id: "doc_1", comment_id: "r1", text: "mid-rotation" });
    expect(server.deliveries.at(-1)?.status).toBe(200);
    const outcome = await coordinator.step(sub);
    sub = applySubscriptionPatch(sub, outcome);
    expect(sub.rotation).toBeUndefined();
    expect(inbox.inbox.slotState(sub.slotId!)?.hasPreviousSecret).toBe(false);
    const after = await inbox.inbox.getSecret(sub.slotId!);
    expect(after.secret).not.toBe(before.secret);
  });

  it("journals gap and terminated control envelopes", async () => {
    const server = await fixture();
    const inbox = await httpsInbox();
    const { manager } = await connect(server.url);
    const coordinator = new EventsCoordinator({
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });
    const sub = applySubscriptionPatch(record(), await coordinator.step(record()));
    await server.sendControl(sub.serverSubscriptionId!, { type: "gap", cursor: "c9" });
    await server.sendControl(sub.serverSubscriptionId!, {
      type: "terminated",
      error: { code: -32012, message: "Forbidden", data: { reason: "Access revoked" } },
    });
    const kinds = inbox.inbox.read(0).entries.map((entry) => [entry.kind, entry.cursor]);
    expect(kinds).toEqual([
      ["gap", "c9"],
      ["terminated", null],
    ]);
  });
});

describe("secret redaction at the capture boundary (C8)", () => {
  it("never captures the secret across subscribe, refresh and failures", async () => {
    const server = await fixture();
    const inbox = await httpsInbox();
    const { manager, frames } = await connect(server.url);
    const coordinator = new EventsCoordinator({
      rpc: async () => rpcPort(manager),
      inbox: async () => inbox.inbox,
    });
    let sub = applySubscriptionPatch(record(), await coordinator.step(record()));
    sub = applySubscriptionPatch(sub, await coordinator.step(sub)); // refresh
    const { secret } = await inbox.inbox.getSecret(sub.slotId!);

    // A failing subscribe whose error message quotes the secret back.
    server.misbehave({ echoSecretInError: true });
    await expect(
      manager.subscribeServerEvents(SERVER_ID, {
        name: "comment.created",
        arguments: { document_id: "doc_1" },
        delivery: { url: sub.callbackUrl!, secret },
        cursor: null,
      })
    ).rejects.toThrow();

    // The server got the exact secret on every subscribe …
    const subscribes = server.received.filter((r) => r.method === "events/subscribe");
    expect(subscribes).toHaveLength(3);
    for (const request of subscribes) {
      expect((request.params as any).delivery.secret).toBe(secret);
    }
    // … and no captured frame, in either direction, contains it.
    const captured = JSON.stringify(frames);
    expect(frames.some((f) => (f.message as any).method === "events/subscribe")).toBe(true);
    expect(captured).not.toContain(secret);
    expect(captured).toContain("whsec_<redacted>");
  });
});
