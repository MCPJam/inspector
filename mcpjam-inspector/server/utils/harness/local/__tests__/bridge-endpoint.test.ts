import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import {
  BridgeExposureError,
  assertBridgeIsLoopbackOnly,
  assertBridgeLoopbackOnly,
  assertBridgePortUnclaimed,
  localBridgeUrl,
  nonLoopbackLocalAddresses,
  waitForLoopbackListener,
} from "../bridge-endpoint.js";

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

describe("the URL handed to an adapter", () => {
  it("is always loopback, whatever the caller asks for", () => {
    expect(localBridgeUrl({ port: 39271, protocol: "ws" })).toBe(
      "ws://127.0.0.1:39271",
    );
    expect(localBridgeUrl({ port: 39271 })).toBe("http://127.0.0.1:39271");
    expect(localBridgeUrl({ port: 39271, protocol: "https" })).toBe(
      "http://127.0.0.1:39271",
    );
  });

  it("rejects an implausible port", () => {
    expect(() => localBridgeUrl({ port: 0 })).toThrow(BridgeExposureError);
    expect(() => localBridgeUrl({ port: 70_000 })).toThrow(BridgeExposureError);
  });
});

describe("the loopback-only probe", () => {
  it("passes for a listener genuinely bound to loopback", async () => {
    const { server, port } = await listen("127.0.0.1");
    // Probe this machine's REAL non-loopback addresses: a loopback-bound
    // listener must not answer on any of them.
    const addresses = nonLoopbackLocalAddresses().filter(
      (a) => !a.includes(":"),
    );
    try {
      await expect(
        assertBridgeIsLoopbackOnly({ port, addresses, timeoutMs: 1_000 }),
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("fails closed when the bridge is reachable on a non-loopback address", async () => {
    // This is the pinned adapters' actual behaviour: their bridges bind
    // 0.0.0.0, which on a user's machine publishes an agent control channel to
    // the LAN. The probe is what turns that from a code-review hope into an
    // enforced property.
    const { server, port } = await listen("0.0.0.0");
    const addresses = nonLoopbackLocalAddresses().filter(
      (a) => !a.includes(":"),
    );
    if (addresses.length === 0) {
      server.close();
      return; // no non-loopback interface here; nothing could be exposed
    }
    try {
      await expect(
        assertBridgeIsLoopbackOnly({ port, addresses, timeoutMs: 1_000 }),
      ).rejects.toThrow(/reachable from the local network/);
    } finally {
      server.close();
    }
  });

  it("passes trivially on a machine with no non-loopback interface", async () => {
    await expect(
      assertBridgeIsLoopbackOnly({ port: 1, addresses: [] }),
    ).resolves.toBeUndefined();
  });

  it("stops at the first exposed address rather than probing them all", async () => {
    const probed: string[] = [];
    await expect(
      assertBridgeIsLoopbackOnly({
        port: 1234,
        addresses: ["10.0.0.1", "10.0.0.2"],
        connect: async (host) => {
          probed.push(host);
          return true;
        },
      }),
    ).rejects.toThrow(BridgeExposureError);
    expect(probed).toEqual(["10.0.0.1"]);
  });

  it("ignores internal interfaces when enumerating", () => {
    expect(
      nonLoopbackLocalAddresses({
        lo: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
        eth0: [{ address: "10.1.2.3", internal: false, family: "IPv4" }],
      }),
    ).toEqual(["10.1.2.3"]);
  });
});

describe("the readiness-then-exposure sequence", () => {
  it("waits for a bridge that is not listening yet", async () => {
    // The order is the whole point: probing before the bridge binds would see
    // every connection refused, pass, and then admit a LAN listener that
    // appeared a moment later.
    let attempts = 0;
    const ready = await waitForLoopbackListener({
      port: 1234,
      pollMs: 1,
      timeoutMs: 2_000,
      connect: async () => ++attempts >= 3,
    });
    expect(ready).toBe(true);
    expect(attempts).toBe(3);
  });

  it("gives up on a bridge that never listens", async () => {
    const ready = await waitForLoopbackListener({
      port: 1234,
      pollMs: 1,
      timeoutMs: 30,
      connect: async () => false,
    });
    expect(ready).toBe(false);
  });

  it("fails the session when the bridge never comes up", async () => {
    await expect(
      assertBridgeLoopbackOnly({
        port: 1234,
        readinessTimeoutMs: 30,
        connect: async () => false,
      }),
    ).rejects.toThrow(/never started listening/);
  });

  it("still rejects a LAN-reachable bridge once it is ready", async () => {
    await expect(
      assertBridgeLoopbackOnly({
        port: 1234,
        readinessTimeoutMs: 100,
        addresses: ["10.0.0.1"],
        // Everything answers: loopback (ready) and the LAN address (exposed).
        connect: async () => true,
      }),
    ).rejects.toThrow(/reachable from the local network/);
  });

  it("passes for a ready, loopback-only bridge", async () => {
    await expect(
      assertBridgeLoopbackOnly({
        port: 1234,
        readinessTimeoutMs: 100,
        addresses: ["10.0.0.1"],
        connect: async (host) => host === "127.0.0.1",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses to attribute a listener to a bridge that has died", async () => {
    await expect(
      assertBridgeLoopbackOnly({
        port: 1234,
        readinessTimeoutMs: 100,
        addresses: [],
        connect: async () => true,
        isBridgeAlive: async () => false,
      }),
    ).rejects.toThrow(/no longer running/);
  });

  it("catches a bridge that dies between readiness and use", async () => {
    let alive = true;
    await expect(
      assertBridgeLoopbackOnly({
        port: 1234,
        readinessTimeoutMs: 100,
        addresses: [],
        connect: async () => {
          alive = false; // exits while we are probing
          return true;
        },
        isBridgeAlive: async () => alive,
      }),
    ).rejects.toThrow(/after its binding was verified/);
  });
});

describe("the pre-launch port check", () => {
  it("passes when nothing holds the leased port", async () => {
    await expect(
      assertBridgePortUnclaimed({ port: 39999, connect: async () => false }),
    ).resolves.toBeUndefined();
  });

  it("refuses a port something is already listening on", async () => {
    // A real listener, so this is not just a stubbed predicate: without the
    // check, the readiness probe would accept THIS socket as the bridge.
    const { server, port } = await listen("127.0.0.1");
    try {
      await expect(assertBridgePortUnclaimed({ port })).rejects.toThrow(
        BridgeExposureError,
      );
    } finally {
      server.close();
    }
  });

  it("looks at the v6 loopback too, not only 127.0.0.1", async () => {
    const probed: string[] = [];
    await expect(
      assertBridgePortUnclaimed({
        port: 39998,
        connect: async (host) => {
          probed.push(host);
          // Free on v4, squatted on v6 — the case a v4-only check misses.
          return host === "::1";
        },
      }),
    ).rejects.toThrow(/already accepting connections on ::1/);
    expect(probed).toEqual(["127.0.0.1", "::1"]);
  });
});
