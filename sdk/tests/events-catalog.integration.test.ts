import { afterEach, expect, it, vi } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { startEventsFixture } from "./support/events-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(acknowledge = true) {
  const fixture = await startEventsFixture({
    beta: true,
    misbehavior: { omitCatalogAcknowledgement: !acknowledge },
  });
  cleanups.push(fixture.close);
  const manager = new MCPClientManager();
  cleanups.push(() => manager.disconnectAllServers());
  await manager.connectToServer("events", { url: fixture.url, mcpProtocolVersion: "2026-07-28" });
  return { fixture, manager };
}

it("opts in, accepts only correlated notifications, and closes when the connection changes", async () => {
  const { fixture, manager } = await connect();
  const ready = vi.fn();
  const refreshed = vi.fn();
  const signal = new AbortController().signal;
  const watch = manager.watchEventsCatalog("events", {
    signal,
    onReady: ready,
    onChange: () => {
      void manager.listServerEvents("events").then((result) => refreshed(result.events));
    },
  });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(fixture.received.find((entry) => entry.method === "subscriptions/listen")?.params)
    .toMatchObject({ notifications: { eventsListChanged: true } });

  fixture.replaceCatalog("unrelated", false);
  expect(refreshed).not.toHaveBeenCalled();
  fixture.replaceCatalog("new.event");
  await vi.waitFor(() => expect(refreshed).toHaveBeenCalledExactlyOnceWith([{ name: "new.event", delivery: ["poll"] }]));

  await manager.disconnectServer("events");
  await watch;
  await vi.waitFor(() => expect(fixture.openCatalogStreams()).toBe(0));

  const legacy = await startEventsFixture();
  cleanups.unshift(legacy.close);
  await manager.connectToServer("events", { url: legacy.url, mcpProtocolVersion: "2025-11-25" });
  await manager.watchEventsCatalog("events", { signal, onChange: refreshed });
  expect(legacy.received.some((entry) => entry.method === "subscriptions/listen")).toBe(false);
});

it("closes a listen whose acknowledged filter drops the Events interest", async () => {
  const { fixture, manager } = await connect(false);
  const ready = vi.fn();
  const signal = new AbortController().signal;
  await manager.watchEventsCatalog("events", { signal, onReady: ready, onChange: ready });
  expect(ready).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(fixture.openCatalogStreams()).toBe(0));
});
