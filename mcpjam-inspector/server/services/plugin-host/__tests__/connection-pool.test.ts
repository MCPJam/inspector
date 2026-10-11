import { describe, expect, it } from "vitest";
import {
  PluginConnectionPool,
  type PooledPluginConnection,
} from "../connection-pool.js";

function connection(key = "key") {
  let connected = true;
  return {
    key,
    serverId: "server",
    hooks: {},
    target: { url: "https://fixture.invalid/mcp" },
    bindingId: "binding",
    transport: "http",
    manager: {
      getConnectionStatus: () => (connected ? "connected" : "disconnected"),
      disconnectAllServers: async () => {
        connected = false;
      },
    },
  } as unknown as Omit<
    PooledPluginConnection,
    "lessee" | "closed" | "idleTimer" | "authorizedAt"
  >;
}
const signal = () => new AbortController().signal;

describe("waiting briefly for a connection another request holds", () => {
  it("takes the connection the other request hands back", async () => {
    const pool = new PluginConnectionPool();
    const first = {};
    const held = pool.adopt(connection(), first);
    const waiting = pool.acquireWithin("key", {}, 1_000, signal());
    setTimeout(() => void pool.release(held, first, true), 20);
    expect(await waiting).toBe(held);
  });

  it("gives up after its bound, so the caller authorizes its own", async () => {
    const pool = new PluginConnectionPool();
    pool.adopt(connection(), {});
    const started = performance.now();
    expect(await pool.acquireWithin("key", {}, 30, signal())).toBeUndefined();
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("stops waiting when the connection it waited for closes", async () => {
    const pool = new PluginConnectionPool();
    const first = {};
    const held = pool.adopt(connection(), first);
    const started = performance.now();
    const waiting = pool.acquireWithin("key", {}, 5_000, signal());
    setTimeout(() => void pool.release(held, first, false), 10);
    expect(await waiting).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("never waits when nobody holds the key, and stops when cancelled", async () => {
    const pool = new PluginConnectionPool();
    const started = performance.now();
    expect(
      await pool.acquireWithin("key", {}, 5_000, signal()),
    ).toBeUndefined();
    pool.adopt(connection(), {});
    const controller = new AbortController();
    const waiting = pool.acquireWithin("key", {}, 5_000, controller.signal);
    controller.abort();
    expect(await waiting).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("hands one released connection to one waiter; the other keeps waiting", async () => {
    const pool = new PluginConnectionPool();
    const first = {};
    const held = pool.adopt(connection(), first);
    const a = pool.acquireWithin("key", {}, 60, signal());
    const b = pool.acquireWithin("key", {}, 60, signal());
    await pool.release(held, first, true);
    const results = await Promise.all([a, b]);
    expect(results.filter((entry) => entry === held)).toHaveLength(1);
    expect(results.filter((entry) => entry === undefined)).toHaveLength(1);
  });
});

describe("re-authorizing a connection in active use ahead of its window", () => {
  const authorization = {
    target: { url: "https://fixture.invalid/mcp" },
    bindingId: "binding",
    transport: "http",
  };
  function fixture() {
    let now = 1_000_000;
    const pool = new PluginConnectionPool(() => now);
    const entry = pool.adopt(connection(), {});
    return {
      pool,
      entry,
      at: (ms: number) => {
        now = 1_000_000 + ms;
      },
    };
  }

  it("is due once half the window has passed, and once at a time", () => {
    const f = fixture();
    f.at(29_999);
    expect(f.pool.beginRefresh(f.entry)).toBeUndefined();
    f.at(30_000);
    expect(f.pool.beginRefresh(f.entry)).toBe(1_030_000);
    expect(f.pool.beginRefresh(f.entry)).toBeUndefined();
    // Never for an expired authorization: that one is renewed inline.
    const expired = fixture();
    expired.at(60_000);
    expect(expired.pool.beginRefresh(expired.entry)).toBeUndefined();
  });

  it("extends the window from when an unchanged authorization started", () => {
    const f = fixture();
    f.at(30_000);
    const started = f.pool.beginRefresh(f.entry)!;
    f.at(31_000);
    f.pool.endRefresh(f.entry, started, structuredClone(authorization));
    f.at(89_999);
    expect(f.pool.authorized(f.entry)).toBe(true);
    f.at(90_000);
    expect(f.pool.authorized(f.entry)).toBe(false);
  });

  it.each([
    [
      "a changed target",
      { ...authorization, target: { url: "https://moved.invalid" } },
    ],
    ["a changed binding", { ...authorization, bindingId: "rotated" }],
    ["a changed transport", { ...authorization, transport: "stdio" }],
    ["a refusal or failure", undefined],
  ])("ends the window at once on %s", (_case, outcome) => {
    const f = fixture();
    f.at(30_000);
    const started = f.pool.beginRefresh(f.entry)!;
    f.pool.endRefresh(f.entry, started, outcome);
    expect(f.pool.authorized(f.entry)).toBe(false);
    // The next request authorizes in full; refresh is possible again.
    expect(f.entry.refreshing).toBe(false);
  });

  it("never overrides a newer full authorization", () => {
    const f = fixture();
    f.at(30_000);
    const started = f.pool.beginRefresh(f.entry)!;
    f.at(30_500);
    f.pool.reauthorized(f.entry, authorization.target, "binding", "http");
    f.pool.endRefresh(f.entry, started, undefined);
    expect(f.pool.authorized(f.entry)).toBe(true);
  });
});
