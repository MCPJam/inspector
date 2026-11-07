/**
 * The hosted inbox adapter (`HttpInboxClient`) passes the SAME coordinator
 * lifecycle suite the SDK runs against `MemoryEventInbox` (contract C9: "a
 * lifecycle suite written once and run against every adapter"), over a real
 * socket to a stub of the Worker's C5 admin API.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isAuthError } from "@mcpjam/sdk";
import { InboxBackpressureError } from "@mcpjam/sdk/events";
import { runEventsLifecycleSuite } from "../../../../../sdk/tests/support/events-lifecycle-suite.js";
import {
  HttpInboxClient,
  InboxHttpError,
  parseRetryAfterMs,
} from "../inbox-client.js";
import {
  STUB_ADMIN_TOKEN,
  startInboxAdminStub,
  type InboxAdminStub,
} from "./support/inbox-admin-stub.js";

runEventsLifecycleSuite({
  name: "hosted adapter (HttpInboxClient over the C5 admin API)",
  async makeInbox(clock) {
    const stub = await startInboxAdminStub({ clock });
    const inbox = new HttpInboxClient({
      inboxId: stub.memory.inboxId,
      baseUrl: stub.url,
      adminToken: STUB_ADMIN_TOKEN,
    });
    return {
      inbox,
      applyBackpressure: (times) => stub.applyBackpressure(times),
      async entries(logicalSubscriptionId) {
        return stub.memory
          .read(0, 1000)
          .entries.filter((entry) => entry.logicalSubscriptionId === logicalSubscriptionId)
          .map((entry) => ({
            kind: entry.kind,
            ...(entry.eventId !== undefined ? { eventId: entry.eventId } : {}),
            cursor: entry.cursor,
          }));
      },
      close: () => stub.close(),
    };
  },
});

describe("HttpInboxClient", () => {
  let stub: InboxAdminStub | undefined;
  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  async function client(overrides: { adminToken?: string } = {}) {
    stub = await startInboxAdminStub();
    return new HttpInboxClient({
      inboxId: stub.memory.inboxId,
      baseUrl: stub.url,
      adminToken: overrides.adminToken ?? STUB_ADMIN_TOKEN,
    });
  }

  it("maps 503 to InboxBackpressureError with Retry-After", async () => {
    const inbox = await client();
    stub!.applyBackpressure(1, 30);
    const error = await inbox
      .append({
        logicalSubscriptionId: "esub_1",
        projectId: "proj_1",
        environmentId: null,
        bindingKey: "b".repeat(64),
        batchId: "batch_1",
        origin: "poll",
        entries: [],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InboxBackpressureError);
    expect((error as InboxBackpressureError).retryAfterMs).toBe(30_000);
  });

  it("sends the admin token and the tenant on every append", async () => {
    const inbox = await client();
    await inbox.append({
      logicalSubscriptionId: "esub_1",
      projectId: "proj_1",
      environmentId: null,
      bindingKey: "b".repeat(64),
      batchId: "batch_1",
      origin: "poll",
      entries: [
        { eventId: "e1", name: "x.y", timestamp: "2026-09-30T00:00:00Z", data: {} } as never,
      ],
    });
    expect(stub!.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/admin/i/${stub!.memory.inboxId}/append`,
      adminToken: STUB_ADMIN_TOKEN,
    });
    expect(stub!.memory.read(0).entries).toEqual([
      expect.objectContaining({ eventId: "e1", origin: "poll" }),
    ]);
  });

  it("refuses without an admin token, and never phrases it as the user's auth failing", async () => {
    const inbox = await client({ adminToken: "wrong-token-wrong-token-wrong-token" });
    const error = await inbox.getSecret("slot").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InboxHttpError);
    expect((error as InboxHttpError).httpStatus).toBe(401);
    // A refused ADMIN token is our misconfiguration: the coordinator must back
    // off, never park the subscription in paused_auth.
    expect(isAuthError(error).isAuth).toBe(false);
    expect((error as Error).message).not.toMatch(/401|unauthor/i);
  });

  it("keeps slot secrets out of error messages", async () => {
    const inbox = await client();
    const allocation = await inbox.allocateSlot({
      logicalSubscriptionId: "esub_1",
      projectId: "proj_1",
      environmentId: null,
      bindingKey: "b".repeat(64),
      dispatch: true,
      idempotencyKey: "alloc_1",
    });
    expect(allocation.secret).toMatch(/^whsec_/);
    expect(allocation.inboxId).toBe(stub!.memory.inboxId);
    const error = await inbox.reconcile("missing-slot", "sub_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InboxHttpError);
    expect((error as Error).message).not.toContain(allocation.secret);
    expect((error as InboxHttpError).inboxError).toBe("unknown_slot");
  });

  it("replays an allocation by its key and finds it without allocating", async () => {
    const inbox = await client();
    const args = {
      logicalSubscriptionId: "esub_1",
      projectId: "proj_1",
      environmentId: null,
      bindingKey: "b".repeat(64),
      dispatch: true,
      idempotencyKey: "alloc_1",
    };
    expect(await inbox.findAllocation("alloc_1")).toBeNull();
    const first = await inbox.allocateSlot(args);
    expect(first.state).toBe("pending");
    const replay = await inbox.allocateSlot(args);
    expect(replay).toEqual(first);
    expect(await inbox.findAllocation("alloc_1")).toEqual(first);
    expect(stub!.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/admin/i/${stub!.memory.inboxId}/slots`,
    });
  });

  it("reads the slot state with its secret, and unbinds a paused slot", async () => {
    const inbox = await client();
    const { slotId, secret } = await inbox.allocateSlot({
      logicalSubscriptionId: "esub_1",
      projectId: "proj_1",
      environmentId: null,
      bindingKey: "b".repeat(64),
      dispatch: true,
      idempotencyKey: "alloc_1",
    });
    expect(await inbox.getSecret(slotId)).toEqual({ secret, state: "pending" });
    await inbox.reconcile(slotId, "sub_1");
    await inbox.unbind(slotId);
    expect(stub!.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/admin/i/${stub!.memory.inboxId}/slots/${slotId}/unbind`,
    });
    // Resume's new id binds; it is not a conflict with the unsubscribed one.
    expect(await inbox.reconcile(slotId, "sub_2")).toEqual({ state: "active" });
  });

  it("reads and bumps the viewer epoch", async () => {
    const inbox = await client();
    expect(await inbox.getViewerEpoch()).toBe(1);
    expect(await inbox.bumpViewerEpoch()).toBe(2);
    expect(await inbox.getViewerEpoch()).toBe(2);
  });

  it("simulates into the simulation namespace", async () => {
    const inbox = await client();
    const result = await inbox.simulate({
      logicalSubscriptionId: "esub_1",
      projectId: "proj_1",
      environmentId: null,
      bindingKey: "b".repeat(64),
      event: {
        eventId: "sim_1",
        name: "comment.created",
        timestamp: "2026-09-30T00:00:00Z",
        data: { text: "hi" },
      },
    });
    expect(result).toEqual({ accepted: 1, duplicates: 0 });
    expect(stub!.memory.read(0).entries).toEqual([
      expect.objectContaining({
        origin: "simulation",
        namespace: "simulation",
        eventId: "sim_1",
      }),
    ]);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs(null)).toBe(5_000);
    const now = Date.UTC(2026, 8, 30, 12, 0, 0);
    expect(parseRetryAfterMs(new Date(now + 7_000).toUTCString(), now)).toBe(7_000);
  });
});
