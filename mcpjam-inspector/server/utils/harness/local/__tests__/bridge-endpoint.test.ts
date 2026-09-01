import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import {
  BridgeExposureError,
  assertBridgeIsLoopbackOnly,
  localBridgeUrl,
  nonLoopbackLocalAddresses,
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
      "ws://127.0.0.1:39271"
    );
    expect(localBridgeUrl({ port: 39271 })).toBe("http://127.0.0.1:39271");
    expect(localBridgeUrl({ port: 39271, protocol: "https" })).toBe(
      "http://127.0.0.1:39271"
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
    const addresses = nonLoopbackLocalAddresses().filter((a) => !a.includes(":"));
    try {
      await expect(
        assertBridgeIsLoopbackOnly({ port, addresses, timeoutMs: 1_000 })
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
    const addresses = nonLoopbackLocalAddresses().filter((a) => !a.includes(":"));
    if (addresses.length === 0) {
      server.close();
      return; // no non-loopback interface here; nothing could be exposed
    }
    try {
      await expect(
        assertBridgeIsLoopbackOnly({ port, addresses, timeoutMs: 1_000 })
      ).rejects.toThrow(/reachable from the local network/);
    } finally {
      server.close();
    }
  });

  it("passes trivially on a machine with no non-loopback interface", async () => {
    await expect(
      assertBridgeIsLoopbackOnly({ port: 1, addresses: [] })
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
      })
    ).rejects.toThrow(BridgeExposureError);
    expect(probed).toEqual(["10.0.0.1"]);
  });

  it("ignores internal interfaces when enumerating", () => {
    expect(
      nonLoopbackLocalAddresses({
        lo: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
        eth0: [{ address: "10.1.2.3", internal: false, family: "IPv4" }],
      })
    ).toEqual(["10.1.2.3"]);
  });
});
