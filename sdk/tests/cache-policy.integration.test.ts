import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { CacheHitEvent } from "../src/mcp-client-manager/index.js";
import { collectConnectedServerSnapshot } from "../src/server-snapshot.js";
import {
  createCacheFixtureHandler,
  createNoTtlFixtureHandler,
  serveCountingFixtureOnPort,
  type ServedCountingFixture,
} from "./support/cache-fixture.js";

/**
 * End-to-end policy proof for the SEP-2549 response cache, driven through the
 * real `MCPClientManager` against the dual-era cache fixture over a loopback
 * port. Wire hits are counted at the server (the manager exposes no injectable
 * `fetch`), so a cache serve — which never leaves the client — is exactly the
 * case where the `tools/list` count does NOT advance.
 *
 * ## Era asymmetry (load-bearing)
 *
 * Only the 2026-07-28 wire codec emits `ttlMs`/`cacheScope`. So an invisible
 * cache serve is a MODERN-era phenomenon: on a `2026-07-28` pin the ttl fixture
 * serves a still-fresh `tools/list` with zero wire exchange, while the SAME
 * fixture on a 2025-era pin carries no `ttlMs` and refetches every time. The
 * cache engine itself is era-blind (it reads `ttlMs` off the decoded body); the
 * body only has `ttlMs` when the modern codec put it there. Both eras are
 * exercised below.
 */

const MODERN = "2026-07-28" as const;
const LEGACY = "2025-06-18" as const;
const TIMEOUT = 10_000;

function connectConfig(url: string, pin: string) {
  return { url, timeout: TIMEOUT, mcpProtocolVersion: pin };
}

// ── Modern era: the ttl fixture actually serves from cache ──────────────────

describe("cache policy · ttl fixture · modern (2026-07-28)", () => {
  let served: ServedCountingFixture;
  let manager: MCPClientManager;
  const cacheEvents: CacheHitEvent[] = [];

  beforeEach(async () => {
    served = await serveCountingFixtureOnPort(createCacheFixtureHandler());
    manager = new MCPClientManager(
      {},
      { cacheEventLogger: (e) => cacheEvents.push(e) },
    );
    await manager.connectToServer("fixture", connectConfig(served.url, MODERN));
    cacheEvents.length = 0;
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("(a) a second no-cursor listTools serves from cache: ZERO new wire + provenance event", async () => {
    // First call populates the cache (one wire tools/list).
    const first = await manager.listTools("fixture");
    expect(first.tools.map((t) => t.name)).toContain("echo");
    const afterFirst = served.count("tools/list");
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    cacheEvents.length = 0;

    // Second call is answered from cache — no new wire request.
    const second = await manager.listTools("fixture");
    expect(second.tools.map((t) => t.name)).toContain("echo");
    expect(served.count("tools/list")).toBe(afterFirst);

    // …and the invisible serve is surfaced with an age (proving it is real).
    const event = cacheEvents.find((e) => e.method === "tools/list");
    expect(event, "expected a tools/list cache-serve event").toBeDefined();
    expect(event!.serverId).toBe("fixture");
    expect(typeof event!.ageMs).toBe("number");
    expect(event!.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("(b) cacheMode 'refresh' always hits the wire", async () => {
    await manager.listTools("fixture");
    const before = served.count("tools/list");
    cacheEvents.length = 0;

    await manager.listTools("fixture", undefined, { cacheMode: "refresh" });

    expect(served.count("tools/list")).toBe(before + 1);
    // A refresh fetches; it never serves, so no serve event fired.
    expect(cacheEvents.filter((e) => e.method === "tools/list")).toHaveLength(0);
  });

  it("(c) cacheMode 'bypass' hits the wire and leaves the stored entry intact", async () => {
    await manager.listTools("fixture"); // populate a fresh entry
    const beforeBypass = served.count("tools/list");

    await manager.listTools("fixture", undefined, { cacheMode: "bypass" });
    expect(served.count("tools/list")).toBe(beforeBypass + 1); // bypass fetched

    // The bypass did NOT overwrite the cache: a subsequent default read still
    // serves the original fresh entry with zero new wire exchange.
    const afterBypass = served.count("tools/list");
    cacheEvents.length = 0;
    await manager.listTools("fixture");
    expect(served.count("tools/list")).toBe(afterBypass);
    expect(cacheEvents.some((e) => e.method === "tools/list")).toBe(true);
  });

  it("(e) snapshot list ops always hit the wire (they bypass the cache)", async () => {
    await manager.listTools("fixture"); // populate a fresh entry
    const before = served.count("tools/list");
    cacheEvents.length = 0;

    await collectConnectedServerSnapshot(manager, "fixture", null);

    // The snapshot re-fetched despite a fresh cached entry, and never served.
    expect(served.count("tools/list")).toBe(before + 1);
    expect(cacheEvents.filter((e) => e.method === "tools/list")).toHaveLength(0);
  });
});

// ── Legacy era: the SAME ttl fixture never serves (no wire ttlMs) ────────────

describe("cache policy · ttl fixture · legacy (2025-06-18)", () => {
  let served: ServedCountingFixture;
  let manager: MCPClientManager;
  const cacheEvents: CacheHitEvent[] = [];

  beforeEach(async () => {
    served = await serveCountingFixtureOnPort(createCacheFixtureHandler());
    manager = new MCPClientManager(
      {},
      { cacheEventLogger: (e) => cacheEvents.push(e) },
    );
    await manager.connectToServer("fixture", connectConfig(served.url, LEGACY));
    cacheEvents.length = 0;
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("refetches on every listTools — the 2025 wire never carries ttlMs", async () => {
    await manager.listTools("fixture");
    const before = served.count("tools/list");
    cacheEvents.length = 0;

    const second = await manager.listTools("fixture");
    expect(second.tools.map((t) => t.name)).toContain("echo");

    expect(served.count("tools/list")).toBe(before + 1);
    expect(cacheEvents).toHaveLength(0);
  });
});

// ── (d) no-ttl fixture: guards against an upstream defaultCacheTtlMs change ──

for (const era of [
  { name: "modern (2026-07-28)", pin: MODERN },
  { name: "legacy (2025-06-18)", pin: LEGACY },
]) {
  describe(`cache policy · no-ttl fixture · ${era.name}`, () => {
    let served: ServedCountingFixture;
    let manager: MCPClientManager;
    const cacheEvents: CacheHitEvent[] = [];

    beforeEach(async () => {
      served = await serveCountingFixtureOnPort(createNoTtlFixtureHandler());
      manager = new MCPClientManager(
        {},
        { cacheEventLogger: (e) => cacheEvents.push(e) },
      );
      await manager.connectToServer(
        "fixture",
        connectConfig(served.url, era.pin),
      );
      cacheEvents.length = 0;
    });

    afterEach(async () => {
      await manager.disconnectAllServers().catch(() => {});
      await served.close();
    });

    it("(d) refetches on every listTools — a hint-less result is stored but never served", async () => {
      await manager.listTools("fixture");
      const before = served.count("tools/list");
      cacheEvents.length = 0;

      await manager.listTools("fixture");

      // defaultCacheTtlMs stays 0, so even the modern era never serves here.
      expect(served.count("tools/list")).toBe(before + 1);
      expect(cacheEvents).toHaveLength(0);
    });
  });
}
