/**
 * Client rules for the MCP Events extension, as MCPJam's events client
 * (MCPClientManager's events methods, the subscription coordinator, the push
 * runtime, and the webhook inbox that receives deliveries) follows them.
 *
 * Wire tests run the real client against the official-SDK events fixture over
 * a real socket and read what the fixture received, in both eras MCPJam speaks
 * Events on: the pre-Beta profile on 2025-11-25 (a top-level `events`
 * capability) and the Beta extension on 2026-07-28. Receiver tests drive the
 * webhook inbox directly with signed deliveries.
 */

import { afterEach, describe, expect } from "vitest";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  decodeWebhookSecret,
  generateWebhookSecret,
} from "../../src/mcp-client-manager/events-ext.js";
import {
  EventsCoordinator,
  applySubscriptionPatch,
} from "../../src/events/coordinator.js";
import { computeBindingKey } from "../../src/events/identity.js";
import { MemoryEventInbox } from "../../src/events/memory-inbox.js";
import { DRAFT_PROFILE_ID } from "../../src/events/profiles.js";
import { EventsPushRuntime, createManagerPushPort } from "../../src/events/push.js";
import {
  buildWebhookHeaders,
  verifyWebhookDelivery,
} from "../../src/events/standard-webhooks.js";
import type { SubscriptionRecord } from "../../src/events/types.js";
import {
  startEventsFixture,
  type EventsFixtureHandle,
} from "../support/events-fixture.js";
import { exercised, ruleTest } from "./harness.js";

const SERVER_ID = "events-fixture";
const ERAS = [
  ["2025-11-25", false],
  ["2026-07-28", true],
] as const;

const opened: {
  fixtures: EventsFixtureHandle[];
  managers: MCPClientManager[];
  runtimes: EventsPushRuntime[];
} = { fixtures: [], managers: [], runtimes: [] };

afterEach(async () => {
  for (const runtime of opened.runtimes) runtime.close();
  await Promise.all(opened.managers.map((m) => m.disconnectAllServers().catch(() => {})));
  await Promise.all(opened.fixtures.map((f) => f.close()));
  opened.fixtures = [];
  opened.managers = [];
  opened.runtimes = [];
});

async function connected(
  fixtureOptions: Parameters<typeof startEventsFixture>[0],
  protocolVersion: "2025-11-25" | "2026-07-28",
): Promise<{ server: EventsFixtureHandle; manager: MCPClientManager }> {
  const server = await startEventsFixture(fixtureOptions);
  opened.fixtures.push(server);
  const manager = new MCPClientManager();
  opened.managers.push(manager);
  await manager.connectToServer(SERVER_ID, {
    url: server.url,
    timeout: 10_000,
    mcpProtocolVersion: protocolVersion as never,
  });
  return { server, manager };
}

function subscriptionRecord(
  id: string,
  mode: SubscriptionRecord["mode"],
  documentId = "doc_1",
): SubscriptionRecord {
  return {
    id,
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
    arguments: { document_id: documentId },
    mode,
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
  };
}

function coordinatorFor(manager: MCPClientManager, inbox: MemoryEventInbox): EventsCoordinator {
  return new EventsCoordinator({
    rpc: async () => ({
      list: (params) => manager.listServerEvents(SERVER_ID, params),
      poll: (params) => manager.pollServerEvents(SERVER_ID, params),
      subscribe: (params) => manager.subscribeServerEvents(SERVER_ID, params),
      unsubscribe: (params) => manager.unsubscribeServerEvents(SERVER_ID, params),
    }),
    inbox: async () => inbox,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Events client rules", () => {
  for (const [protocolVersion, beta] of ERAS) {
    ruleTest("C201", `${protocolVersion}: listing the available event types sends events/list`, async () => {
      const { server, manager } = await connected({ beta }, protocolVersion);
      await manager.listServerEvents(SERVER_ID);
      expect(server.received.some((request) => request.method === "events/list")).toBe(true);
    });

    ruleTest(
      "C202",
      `${protocolVersion}: against a server that does not advertise Events, no events/* request goes out`,
      async (ctx) => {
        const { server, manager } = await connected({ beta, declareEvents: false }, protocolVersion);
        exercised(
          ctx,
          !manager.getEventsSupport(SERVER_ID).declared,
          "the fixture advertised Events anyway",
        );
        const request = { name: "comment.created", arguments: { document_id: "doc_1" } };
        const controller = new AbortController();
        await Promise.allSettled([
          manager.listServerEvents(SERVER_ID),
          manager.pollServerEvents(SERVER_ID, { ...request, cursor: null }),
          manager.subscribeServerEvents(SERVER_ID, {
            ...request,
            delivery: { url: "https://inbox.example/hook", secret: generateWebhookSecret() },
            cursor: null,
          }),
          manager.unsubscribeServerEvents(SERVER_ID, {
            ...request,
            delivery: { url: "https://inbox.example/hook" },
          }),
          manager.openEventsStream(
            SERVER_ID,
            { ...request, cursor: null },
            {
              signal: controller.signal,
              timeout: 1_000,
              onRequestId: () => {},
              onRequestStreamEnd: () => {},
            },
          ),
        ]);
        controller.abort();
        expect(server.received.filter((r) => r.method.startsWith("events/"))).toEqual([]);
      },
    );

    ruleTest(
      "C202",
      `(control) ${protocolVersion}: the same client does send events/list to a server that advertises Events`,
      async () => {
        const { server, manager } = await connected({ beta }, protocolVersion);
        await manager.listServerEvents(SERVER_ID);
        expect(server.received.some((r) => r.method === "events/list")).toBe(true);
      },
    );

    ruleTest(
      "C203",
      `${protocolVersion}: a new poll subscription asks to start from now with cursor: null on its first events/poll`,
      async (ctx) => {
        const { server, manager } = await connected({ beta }, protocolVersion);
        const inbox = new MemoryEventInbox({ publicOrigin: "https://inbox.example" });
        const record = subscriptionRecord("esub_poll", "poll");
        applySubscriptionPatch(record, await coordinatorFor(manager, inbox).step(record));
        const polls = server.received.filter((r) => r.method === "events/poll");
        exercised(ctx, polls.length > 0, "the coordinator sent no events/poll");
        const first = polls[0]!.params as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(first, "cursor")).toBe(true);
        expect(first.cursor).toBeNull();
      },
    );

    ruleTest(
      "C204",
      `${protocolVersion}: a webhook subscription's events/subscribe carries the client's signing secret`,
      async (ctx) => {
        const { server, manager } = await connected({ beta }, protocolVersion);
        const inbox = new MemoryEventInbox({ publicOrigin: "https://inbox.example" });
        const record = subscriptionRecord("esub_hook", "webhook");
        await coordinatorFor(manager, inbox).step(record).catch(() => {});
        const subscribes = server.received.filter((r) => r.method === "events/subscribe");
        exercised(ctx, subscribes.length > 0, "the coordinator sent no events/subscribe");
        for (const subscribe of subscribes) {
          const secret = (subscribe.params as { delivery?: { secret?: unknown } }).delivery?.secret;
          expect(typeof secret === "string" && secret.length > 0).toBe(true);
        }
      },
    );

    ruleTest(
      "C207",
      `${protocolVersion}: two push streams with the same event and arguments each get only their own notifications`,
      async (ctx) => {
        const server = await startEventsFixture({ beta });
        opened.fixtures.push(server);
        const manager = new MCPClientManager();
        opened.managers.push(manager);
        await manager.connectToServer(SERVER_ID, {
          url: server.url,
          timeout: 10_000,
          mcpProtocolVersion: protocolVersion as never,
        });
        const inbox = new MemoryEventInbox({ publicOrigin: "https://hooks.test" });
        const runtime = new EventsPushRuntime({
          port: createManagerPushPort(manager as never, SERVER_ID),
          inbox,
          maxBackoffMs: 200,
        });
        opened.runtimes.push(runtime);
        const eventIds = (logicalId: string) =>
          inbox
            .read(0, 1000)
            .entries.filter((entry) => entry.logicalSubscriptionId === logicalId && entry.kind === "event")
            .map((entry) => entry.eventId);

        // Same event name, same arguments: only the subscription id on each
        // notification tells the streams apart. Stream B opens after the
        // first event, so only stream A ever carries it.
        runtime.start(subscriptionRecord("esub_a", "push", "doc_same"));
        await waitFor(() => server.openStreams() === 1);
        await server.emit("comment.created", { document_id: "doc_same", comment_id: "1", text: "one" });
        await waitFor(() => eventIds("esub_a").length === 1);
        runtime.start(subscriptionRecord("esub_b", "push", "doc_same"));
        await waitFor(() => server.openStreams() === 2);
        await server.emit("comment.created", { document_id: "doc_same", comment_id: "2", text: "two" });
        await waitFor(() => eventIds("esub_a").length === 2 && eventIds("esub_b").length >= 1);
        // Let any misrouted copy land before reading.
        await new Promise((resolve) => setTimeout(resolve, 100));
        exercised(ctx, eventIds("esub_a").length === 2, "stream A did not get both events");
        expect(eventIds("esub_a")).toEqual(["evt_1", "evt_2"]);
        expect(eventIds("esub_b")).toEqual(["evt_2"]);
      },
      15_000,
    );
  }

  ruleTest(
    "C205",
    "every secret MCPJam generates is whsec_ plus 24 to 64 random bytes in Base64",
    () => {
      const shape = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
      const secrets = [
        ...[24, 32, 64].map((bytes) => generateWebhookSecret(bytes)),
        ...Array.from({ length: 50 }, () => generateWebhookSecret()),
      ];
      for (const secret of secrets) {
        expect(secret).toMatch(shape);
        // Decoded independently of MCPJam's own decoder.
        const length = Buffer.from(secret.slice("whsec_".length), "base64").length;
        expect(length).toBeGreaterThanOrEqual(24);
        expect(length).toBeLessThanOrEqual(64);
      }
      // Random: no two default secrets alike.
      expect(new Set(secrets.slice(3)).size).toBe(50);
    },
  );

  ruleTest(
    "C205",
    "the inbox gives each subscription its own in-range secret",
    async () => {
      const inbox = new MemoryEventInbox({ publicOrigin: "https://inbox.example" });
      const allocate = (key: string) =>
        inbox.allocateSlot({
          logicalSubscriptionId: key,
          projectId: "proj_1",
          environmentId: null,
          bindingKey: "binding",
          dispatch: false,
          idempotencyKey: key,
        });
      const [a, b] = [await allocate("a"), await allocate("b")];
      for (const { secret } of [a, b]) {
        const length = decodeWebhookSecret(secret)?.length ?? 0;
        expect(length).toBeGreaterThanOrEqual(24);
        expect(length).toBeLessThanOrEqual(64);
      }
      expect(a.secret).not.toBe(b.secret);
    },
  );

  describe("the webhook receiver (MemoryEventInbox)", () => {
    const signedAt = 1_800_000_000;

    async function inboxAndSlot() {
      const inbox = new MemoryEventInbox({
        publicOrigin: "https://inbox.example",
        clock: { now: () => signedAt * 1000 },
      });
      const slot = await inbox.allocateSlot({
        logicalSubscriptionId: "s",
        projectId: "proj_1",
        environmentId: null,
        bindingKey: "binding",
        dispatch: false,
        idempotencyKey: "s",
      });
      const events = () =>
        inbox.read(0, 100).entries.filter((entry) => entry.kind === "event");
      return { inbox, slot, events };
    }

    // The raw bytes a server sent, with whitespace a re-serializer would drop.
    const rawBody =
      '{ "eventId": "evt_1",  "name": "comment.created", "timestamp": "2027-01-15T08:00:00Z", "data": { "document_id": "doc_1" }, "cursor": "c1" }';

    ruleTest(
      "C206",
      "a delivery signed over its raw bytes is verified against those bytes and accepted",
      async () => {
        const { inbox, slot, events } = await inboxAndSlot();
        const headers = await buildWebhookHeaders({
          secrets: [slot.secret],
          webhookId: "msg_1",
          timestampSeconds: signedAt,
          body: rawBody,
          subscriptionId: "sub_1",
        });
        const result = await inbox.receive({ slotId: slot.slotId, headers, body: rawBody });
        expect(result.status).toBeLessThan(300);
        expect(events().map((entry) => entry.eventId)).toEqual(["evt_1"]);
      },
    );

    ruleTest(
      "C206",
      "a delivery whose signature does not cover its raw bytes is not accepted",
      async () => {
        const { inbox, slot, events } = await inboxAndSlot();
        // Signed over the re-serialized JSON, sent as the raw bytes.
        const headers = await buildWebhookHeaders({
          secrets: [slot.secret],
          webhookId: "msg_1",
          timestampSeconds: signedAt,
          body: JSON.stringify(JSON.parse(rawBody)),
          subscriptionId: "sub_1",
        });
        const result = await inbox.receive({ slotId: slot.slotId, headers, body: rawBody });
        expect(result.status).toBeGreaterThanOrEqual(300);
        expect(events()).toEqual([]);
      },
    );

    const secret = generateWebhookSecret();
    const body = JSON.stringify({ hello: "world" });
    const verifyAt = async (nowSeconds: number) =>
      verifyWebhookDelivery({
        secrets: [secret],
        headers: await buildWebhookHeaders({
          secrets: [secret],
          webhookId: "msg_1",
          timestampSeconds: signedAt,
          body,
          subscriptionId: "sub_1",
        }),
        body,
        nowSeconds,
      });

    ruleTest("C400", "a delivery more than five minutes old is refused", async () => {
      await expect(verifyAt(signedAt + 301)).resolves.toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    });

    ruleTest("C400", "(control) the same delivery, checked as it arrives, is not refused for its age", async () => {
      await expect(verifyAt(signedAt)).resolves.toMatchObject({ ok: true });
    });

    ruleTest("C400", "the webhook inbox refuses a delivery more than five minutes old", async () => {
      const { inbox, slot, events } = await inboxAndSlot();
      const headers = await buildWebhookHeaders({
        secrets: [slot.secret],
        webhookId: "msg_1",
        timestampSeconds: signedAt - 3_600,
        body: rawBody,
        subscriptionId: "sub_1",
      });
      const result = await inbox.receive({ slotId: slot.slotId, headers, body: rawBody });
      expect(result.status).toBeGreaterThanOrEqual(300);
      expect(events()).toEqual([]);
    });
  });
});
