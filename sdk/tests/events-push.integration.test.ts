/**
 * Push delivery (`events/stream`) through the real `MCPClientManager` and the
 * official-server fixture — the phase-1 push spike's exit gate, carried into
 * the phase-6 runtime:
 *   - two concurrent streams on one connection, demuxed by request id;
 *   - heartbeat-only periods keep a stream alive;
 *   - the server closing the stream without a result ⇒ reconnect with cursor;
 *   - cancelling one stream leaves the connection and the other stream up;
 *   - the finite request timer is rolled over deliberately;
 * and every pushed event goes through the same inbox ingestion path.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { EventsPushRuntime, createManagerPushPort } from "../src/events/push.js";
import { MemoryEventInbox } from "../src/events/memory-inbox.js";
import type { SubscriptionRecord } from "../src/events/types.js";
import { DRAFT_PROFILE_ID } from "../src/events/profiles.js";
import { startEventsFixture, type EventsFixtureHandle } from "./support/events-fixture.js";

const SERVER_ID = "events-push";
const opened: { fixtures: EventsFixtureHandle[]; managers: MCPClientManager[]; runtimes: EventsPushRuntime[] } = {
  fixtures: [],
  managers: [],
  runtimes: [],
};

afterEach(async () => {
  for (const runtime of opened.runtimes) runtime.close();
  await Promise.all(opened.managers.map((m) => m.disconnectAllServers().catch(() => {})));
  await Promise.all(opened.fixtures.map((f) => f.close()));
  opened.fixtures = [];
  opened.managers = [];
  opened.runtimes = [];
});

function record(id: string, documentId: string, cursor: string | null = null): SubscriptionRecord {
  return {
    id,
    projectId: "proj_1",
    environmentId: null,
    bindingKey: "binding_1",
    serverId: SERVER_ID,
    profile: DRAFT_PROFILE_ID,
    eventName: "comment.created",
    arguments: { document_id: documentId },
    mode: "push",
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
    lastCursor: cursor,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(
  fixtureOptions: Parameters<typeof startEventsFixture>[0] = {},
  runtimeOptions: { heartbeatIntervalMs?: number; rolloverMs?: number; protocolVersion?: "2025-11-25" | "2026-07-28" } = {}
) {
  const fixture = await startEventsFixture(fixtureOptions);
  opened.fixtures.push(fixture);
  const manager = new MCPClientManager();
  opened.managers.push(manager);
  await manager.connectToServer(SERVER_ID, {
    url: fixture.url,
    timeout: 10_000,
    ...(runtimeOptions.protocolVersion
      ? { mcpProtocolVersion: runtimeOptions.protocolVersion as never }
      : {}),
  });
  const inbox = new MemoryEventInbox({ publicOrigin: "https://hooks.test" });
  const runtime = new EventsPushRuntime({
    port: createManagerPushPort(manager as never, SERVER_ID),
    inbox,
    ...(runtimeOptions.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: runtimeOptions.heartbeatIntervalMs }
      : {}),
    ...(runtimeOptions.rolloverMs !== undefined ? { rolloverMs: runtimeOptions.rolloverMs } : {}),
    maxBackoffMs: 200,
  });
  opened.runtimes.push(runtime);
  const eventIds = (logicalId: string) =>
    inbox
      .read(0, 1000)
      .entries.filter((entry) => entry.logicalSubscriptionId === logicalId && entry.kind === "event")
      .map((entry) => entry.eventId);
  return { fixture, manager, inbox, runtime, eventIds };
}

describe("events/stream push runtime", () => {
  for (const protocolVersion of ["2025-11-25", "2026-07-28"] as const) {
    it(`demuxes two concurrent streams on one connection (${protocolVersion})`, async () => {
      const { fixture, runtime, eventIds } = await setup({}, { protocolVersion });
      const cursors: Record<string, Array<string | null>> = { a: [], b: [] };
      runtime.start(record("esub_a", "doc_a"), { onCursor: (c) => cursors.a!.push(c) });
      runtime.start(record("esub_b", "doc_b"), { onCursor: (c) => cursors.b!.push(c) });
      await waitFor(() => fixture.openStreams() === 2);
      await fixture.emit("comment.created", { document_id: "doc_a", comment_id: "1", text: "a" });
      await fixture.emit("comment.created", { document_id: "doc_b", comment_id: "2", text: "b" });
      await fixture.emit("comment.created", { document_id: "doc_a", comment_id: "3", text: "a2" });
      await waitFor(() => eventIds("esub_a").length === 2 && eventIds("esub_b").length === 1);
      expect(eventIds("esub_a")).toEqual(["evt_1", "evt_3"]);
      expect(eventIds("esub_b")).toEqual(["evt_2"]);
      expect(cursors.a!.at(-1)).toBe("c3");
    });
  }

  it("stays alive on heartbeats alone and advances the cursor from them", async () => {
    const { fixture, runtime } = await setup({ heartbeatMs: 40 }, { heartbeatIntervalMs: 60 });
    const opens: string[] = [];
    const cursors: Array<string | null> = [];
    runtime.start(record("esub_hb", "doc_x"), {
      onOpen: ({ reason }) => opens.push(reason),
      onCursor: (cursor) => cursors.push(cursor),
    });
    await waitFor(() => fixture.openStreams() === 1);
    await fixture.emit("comment.created", { document_id: "other", comment_id: "9", text: "not ours" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // No reconnect: heartbeats (every 40 ms) beat the 120 ms liveness window.
    expect(opens).toEqual(["start"]);
    expect(cursors.at(-1)).toBe("c1");
  });

  it("reconnects with the cursor when the server drops the stream without a result", async () => {
    const { fixture, runtime, eventIds } = await setup();
    const opens: Array<{ reason: string; cursor: string | null }> = [];
    runtime.start(record("esub_drop", "doc_1"), {
      onOpen: ({ reason, cursor }) => opens.push({ reason, cursor }),
    });
    await waitFor(() => fixture.openStreams() === 1);
    await fixture.emit("comment.created", { document_id: "doc_1", comment_id: "1", text: "one" });
    await waitFor(() => eventIds("esub_drop").length === 1);
    fixture.dropStreams();
    // Emitted while the stream is down: recovered by cursor replay.
    await fixture.emit("comment.created", { document_id: "doc_1", comment_id: "2", text: "two" });
    await waitFor(() => eventIds("esub_drop").length === 2);
    expect(eventIds("esub_drop")).toEqual(["evt_1", "evt_2"]);
    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(opens[1]!.cursor).toBe("c1");
  });

  it("cancels one stream without closing the connection or the other stream", async () => {
    const { fixture, runtime, manager, eventIds } = await setup();
    const first = runtime.start(record("esub_1", "doc_1"));
    runtime.start(record("esub_2", "doc_2"));
    await waitFor(() => fixture.openStreams() === 2);
    first.stop();
    await waitFor(() => fixture.openStreams() === 1);
    await fixture.emit("comment.created", { document_id: "doc_2", comment_id: "x", text: "still here" });
    await waitFor(() => eventIds("esub_2").length === 1);
    // The connection itself is untouched: an ordinary request still works.
    await expect(manager.listServerEvents(SERVER_ID)).resolves.toMatchObject({
      events: expect.any(Array),
    });
    expect(eventIds("esub_1")).toEqual([]);
  });

  it("rolls the finite request timer over deliberately, losing nothing", async () => {
    const { fixture, runtime, eventIds } = await setup({}, { rolloverMs: 150 });
    const opens: string[] = [];
    runtime.start(record("esub_roll", "doc_1"), { onOpen: ({ reason }) => opens.push(reason) });
    await waitFor(() => opens.includes("rollover"));
    await waitFor(() => fixture.openStreams() >= 1);
    await fixture.emit("comment.created", { document_id: "doc_1", comment_id: "r", text: "after rollover" });
    await waitFor(() => eventIds("esub_roll").length === 1);
    expect(opens[0]).toBe("start");
  });
});
