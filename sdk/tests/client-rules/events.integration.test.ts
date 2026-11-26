/**
 * Client rules for the MCP Events extension, as MCPJam's events client
 * (MCPClientManager's events methods, the subscription coordinator, and the
 * webhook inbox that receives deliveries) follows them.
 *
 * Wire tests run the real client against the official-SDK events fixture over
 * a real socket and read what the fixture received. Rules an existing test
 * already proves exactly are pointed to with `coveredBy`.
 */

import { afterEach, describe, expect } from "vitest";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { MCPEventsWireError } from "../../src/mcp-client-manager/events-ext-guards.js";
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
import {
  buildWebhookHeaders,
  verifyWebhookDelivery,
} from "../../src/events/standard-webhooks.js";
import type { SubscriptionRecord } from "../../src/events/types.js";
import {
  startEventsFixture,
  type EventsFixtureHandle,
} from "../support/events-fixture.js";
import { coveredBy, ruleTest } from "./harness.js";

const SERVER_ID = "events-fixture";
const opened: { fixtures: EventsFixtureHandle[]; managers: MCPClientManager[] } = {
  fixtures: [],
  managers: [],
};

afterEach(async () => {
  await Promise.all(opened.managers.map((m) => m.disconnectAllServers().catch(() => {})));
  await Promise.all(opened.fixtures.map((f) => f.close()));
  opened.fixtures = [];
  opened.managers = [];
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

function pollRecord(): SubscriptionRecord {
  return {
    id: "esub_poll",
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
    mode: "poll",
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
  };
}

describe("Events client rules", () => {
  coveredBy(
    "C201",
    "tests/events-wire.integration.test.ts",
    "lists descriptors and polls with cursor semantics",
  );

  // The two eras declare Events differently: a top-level `capabilities.events`
  // in the 2025 handshake, an `extensions` entry (Beta) on 2026-07-28.
  for (const [protocolVersion, beta] of [
    ["2025-11-25", false],
    ["2026-07-28", true],
  ] as const) {
    ruleTest(
      "C202",
      `${protocolVersion}: against a server that does not advertise Events, list, poll and subscribe send nothing`,
      async () => {
        const { server, manager } = await connected(
          { beta, declareEvents: false },
          protocolVersion,
        );
        expect(manager.getEventsSupport(SERVER_ID).declared).toBe(false);
        await expect(manager.listServerEvents(SERVER_ID)).rejects.toBeInstanceOf(
          MCPEventsWireError,
        );
        await expect(
          manager.pollServerEvents(SERVER_ID, {
            name: "comment.created",
            arguments: { document_id: "doc_1" },
            cursor: null,
          }),
        ).rejects.toBeInstanceOf(MCPEventsWireError);
        await expect(
          manager.subscribeServerEvents(SERVER_ID, {
            name: "comment.created",
            arguments: { document_id: "doc_1" },
            delivery: {
              url: "https://inbox.example/hook",
              secret: generateWebhookSecret(),
            },
            cursor: null,
          }),
        ).rejects.toBeInstanceOf(MCPEventsWireError);
        expect(server.received.filter((r) => r.method.startsWith("events/"))).toEqual([]);
      },
    );

    ruleTest(
      "C202",
      `(control) ${protocolVersion}: the same calls reach a server that advertises Events`,
      async () => {
        const { server, manager } = await connected({ beta }, protocolVersion);
        expect(manager.getEventsSupport(SERVER_ID).declared).toBe(true);
        await manager.listServerEvents(SERVER_ID);
        expect(server.received.some((r) => r.method === "events/list")).toBe(true);
      },
    );
  }

  coveredBy(
    "C203",
    "tests/support/events-lifecycle-suite.ts",
    "starts from now with a null cursor and advances on an empty batch",
  );

  ruleTest(
    "C203",
    "a new poll subscription's first events/poll carries cursor: null on the wire",
    async () => {
      const { server, manager } = await connected({}, "2025-11-25");
      const coordinator = new EventsCoordinator({
        rpc: async () => ({
          list: (params) => manager.listServerEvents(SERVER_ID, params),
          poll: (params) => manager.pollServerEvents(SERVER_ID, params),
          subscribe: (params) => manager.subscribeServerEvents(SERVER_ID, params),
          unsubscribe: (params) => manager.unsubscribeServerEvents(SERVER_ID, params),
        }),
        inbox: async () => new MemoryEventInbox({ publicOrigin: "https://inbox.example" }),
      });
      const record = pollRecord();
      applySubscriptionPatch(record, await coordinator.step(record));
      const polls = server.received.filter((r) => r.method === "events/poll");
      expect(polls.length).toBeGreaterThan(0);
      const first = polls[0]!.params as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(first, "cursor")).toBe(true);
      expect(first.cursor).toBeNull();
    },
  );

  coveredBy(
    "C204",
    "tests/events-wire.integration.test.ts",
    "never captures the secret across subscribe, refresh and failures",
  );

  ruleTest(
    "C205",
    "the secret MCPJam supplies is whsec_ plus 24 to 64 random bytes in Base64",
    () => {
      const shape = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
      for (const bytes of [24, 32, 64]) {
        const secret = generateWebhookSecret(bytes);
        expect(secret).toMatch(shape);
        // Decoded independently of MCPJam's own decoder.
        expect(Buffer.from(secret.slice("whsec_".length), "base64")).toHaveLength(bytes);
      }
      // The default, which the inbox uses for every slot, is in range too.
      const fallback = generateWebhookSecret();
      expect(fallback).toMatch(shape);
      const length = Buffer.from(fallback.slice("whsec_".length), "base64").length;
      expect(length).toBeGreaterThanOrEqual(24);
      expect(length).toBeLessThanOrEqual(64);
      expect(() => generateWebhookSecret(23)).toThrow(RangeError);
      expect(() => generateWebhookSecret(65)).toThrow(RangeError);
      // Random: no two secrets alike.
      const many = new Set(Array.from({ length: 50 }, () => generateWebhookSecret()));
      expect(many.size).toBe(50);
    },
  );

  ruleTest(
    "C205",
    "the inbox allocates each subscription its own in-range secret",
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
        expect(decodeWebhookSecret(secret)?.length).toBeGreaterThanOrEqual(24);
      }
      expect(a.secret).not.toBe(b.secret);
    },
  );

  coveredBy(
    "C206",
    "src/events/__tests__/standard-webhooks.test.ts",
    "verifies the published vector and rejects a tampered body",
  );
  coveredBy(
    "C206",
    "tests/events-wire.integration.test.ts",
    "rejects forged deliveries and never lets them change a binding",
  );

  coveredBy(
    "C207",
    "tests/events-push.integration.test.ts",
    "demuxes two concurrent streams on one connection",
  );

  describe("C400: deliveries older than five minutes are refused", () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ hello: "world" });
    const signedAt = 1_800_000_000;
    const headers = () =>
      buildWebhookHeaders({
        secrets: [secret],
        webhookId: "msg_1",
        timestampSeconds: signedAt,
        body,
        subscriptionId: "sub_1",
      });
    const verifyAt = async (nowSeconds: number) =>
      verifyWebhookDelivery({ secrets: [secret], headers: await headers(), body, nowSeconds });

    ruleTest("C400", "a delivery exactly five minutes old is still accepted", async () => {
      await expect(verifyAt(signedAt + 300)).resolves.toMatchObject({ ok: true });
    });

    ruleTest("C400", "a delivery five minutes and one second old is refused", async () => {
      await expect(verifyAt(signedAt + 301)).resolves.toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    });

    ruleTest("C400", "a timestamp more than five minutes in the future is refused too", async () => {
      await expect(verifyAt(signedAt - 301)).resolves.toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    });

    ruleTest("C400", "the webhook inbox answers a stale delivery with 401", async () => {
      const now = signedAt * 1000;
      const inbox = new MemoryEventInbox({
        publicOrigin: "https://inbox.example",
        clock: { now: () => now },
      });
      const slot = await inbox.allocateSlot({
        logicalSubscriptionId: "s",
        projectId: "proj_1",
        environmentId: null,
        bindingKey: "binding",
        dispatch: false,
        idempotencyKey: "s",
      });
      const signed = await buildWebhookHeaders({
        secrets: [slot.secret],
        webhookId: "msg_1",
        timestampSeconds: signedAt - 3_600,
        body,
        subscriptionId: "sub_1",
      });
      const result = await inbox.receive({ slotId: slot.slotId, headers: signed, body });
      expect(result.status).toBe(401);
      expect(inbox.rejections.at(-1)?.reason).toBe("stale_timestamp");
      // Control: the same delivery signed now is not refused for its age.
      const fresh = await inbox.receive({
        slotId: slot.slotId,
        headers: await buildWebhookHeaders({
          secrets: [slot.secret],
          webhookId: "msg_2",
          timestampSeconds: signedAt,
          body,
          subscriptionId: "sub_1",
        }),
        body,
      });
      expect(fresh.status).toBeDefined();
      expect(
        inbox.rejections.filter((rejection) => rejection.reason === "stale_timestamp"),
      ).toHaveLength(1);
    });
  });
});
