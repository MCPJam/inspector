import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import {
  BridgeExposureError,
  assertBridgeBindingIsLoopback,
  assertBridgeIsLoopbackOnly,
  assertBridgeLoopbackOnly,
  assertBridgePortUnclaimed,
  isLoopbackBoundAddress,
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

  it("probes every address concurrently rather than one at a time", async () => {
    // Sequentially this cost 11 s on a laptop with ten link-local addresses,
    // inside a 1.5 s session-start budget. The addresses are independent, so
    // the only thing serializing them was the shape of the loop.
    let inFlight = 0;
    let peak = 0;
    await assertBridgeIsLoopbackOnly({
      port: 1234,
      addresses: ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
      connect: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return false;
      },
    });
    expect(peak).toBe(4);
  });

  it("still fails closed when any address answers", async () => {
    await expect(
      assertBridgeIsLoopbackOnly({
        port: 1234,
        addresses: ["10.0.0.1", "10.0.0.2"],
        connect: async (host) => host === "10.0.0.2",
      }),
    ).rejects.toThrow(BridgeExposureError);
  });

  it("caps the per-address timeout at the whole-probe budget", async () => {
    const timeouts: number[] = [];
    await assertBridgeIsLoopbackOnly({
      port: 1234,
      addresses: ["10.0.0.1"],
      timeoutMs: 30_000,
      connect: async (_host, _port, timeoutMs) => {
        timeouts.push(timeoutMs);
        return false;
      },
    });
    expect(timeouts).toEqual([1_000]);
  });

  it("ignores internal interfaces when enumerating", () => {
    expect(
      nonLoopbackLocalAddresses({
        lo: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
        eth0: [{ address: "10.1.2.3", internal: false, family: "IPv4" }],
      }),
    ).toEqual(["10.1.2.3"]);
  });

  it("scopes link-local addresses, which are unconnectable without one", () => {
    // An unscoped fe80:: address cannot be connected at all — the kernel has
    // no interface to pick — so each one used to sit out the full timeout and
    // answer "not reachable" for a reason unrelated to the bridge's binding.
    expect(
      nonLoopbackLocalAddresses({
        en0: [
          { address: "fe80::1", internal: false, family: "IPv6" },
          { address: "192.168.1.5", internal: false, family: "IPv4" },
        ],
        awdl0: [{ address: "fe80::abcd", internal: false, family: "IPv6" }],
      }),
    ).toEqual(["fe80::1%en0", "192.168.1.5", "fe80::abcd%awdl0"]);
  });

  it("keeps a scope that is already present", () => {
    expect(
      nonLoopbackLocalAddresses({
        en0: [{ address: "fe80::1%en0", internal: false, family: "IPv6" }],
      }),
    ).toEqual(["fe80::1%en0"]);
  });
});

describe("the OS-level binding check", () => {
  it("accepts every spelling of a loopback binding", () => {
    for (const address of [
      "127.0.0.1",
      "127.53.1.9",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "[::1]",
      // What `/proc/net/tcp6` actually writes: every group padded to four hex
      // digits. Reading these as exposed would REFUSE a bridge bound exactly
      // where it was told to bind — a false positive in the check whose whole
      // job is to be trusted.
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "0000:0000:0000:0000:0000:ffff:7f00:0001",
    ]) {
      expect(isLoopbackBoundAddress(address)).toBe(true);
    }
  });

  it("still reads a padded non-loopback IPv6 address as off-box", () => {
    // Zero-stripping must not turn into "anything with lots of zeroes is
    // loopback".
    for (const address of [
      "0000:0000:0000:0000:0000:0000:0000:0000",
      "fe80:0000:0000:0000:0000:0000:0000:0001",
      "0000:0000:0000:0000:0000:ffff:c0a8:0105",
    ]) {
      expect(isLoopbackBoundAddress(address)).toBe(false);
    }
  });

  it("passes a bridge the kernel reports on padded IPv6 loopback", async () => {
    await expect(
      assertBridgeBindingIsLoopback({
        pid: 4242,
        platform: "linux",
        read: async () => ["0000:0000:0000:0000:0000:0000:0000:0001"],
      }),
    ).resolves.toBeUndefined();
  });

  it("treats a wildcard binding as off-box, because it is", () => {
    for (const address of ["0.0.0.0", "::", "*", "192.168.1.5", ""]) {
      expect(isLoopbackBoundAddress(address)).toBe(false);
    }
  });

  it("fails a bridge the kernel reports bound to a LAN address", async () => {
    await expect(
      assertBridgeBindingIsLoopback({
        pid: 4242,
        platform: "linux",
        read: async () => ["127.0.0.1", "192.168.1.5"],
      }),
    ).rejects.toThrow(BridgeExposureError);
  });

  it("passes a bridge bound only to loopback", async () => {
    await expect(
      assertBridgeBindingIsLoopback({
        pid: 4242,
        platform: "linux",
        read: async () => ["127.0.0.1", "::1"],
      }),
    ).resolves.toBeUndefined();
  });

  it("stays silent when the platform cannot be asked", async () => {
    // The connect probe is the enforcing check. Refusing a session because
    // `lsof` is missing would trade a real capability for no extra safety.
    await expect(
      assertBridgeBindingIsLoopback({
        pid: 4242,
        platform: "win32",
        read: async () => null,
      }),
    ).resolves.toBeUndefined();
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

  it("probes every address at once, not one after another", async () => {
    // D7's regression, made deterministic. The conformance scenario measures
    // this against a real machine's interfaces, but a CI runner usually has
    // one or two addresses that refuse instantly — so a probe that went back
    // to being serial would still land inside that scenario's 3 s budget and
    // the job would stay green.
    //
    // Here the address list and the connect are both injected: eight addresses
    // at 120 ms each is 960 ms serially and about 120 ms in parallel. The
    // threshold sits between the two, far enough from both that a loaded
    // machine cannot flip it.
    const SLOW_MS = 120;
    const addresses = Array.from({ length: 8 }, (_, i) => `10.0.0.${i + 1}`);
    const started = Date.now();
    await expect(
      assertBridgeLoopbackOnly({
        port: 1234,
        readinessTimeoutMs: 100,
        addresses,
        connect: async (host) => {
          if (host === "127.0.0.1") return true;
          await new Promise((r) => setTimeout(r, SLOW_MS));
          return false;
        },
      }),
    ).resolves.toBeUndefined();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(SLOW_MS * addresses.length * 0.5);
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
