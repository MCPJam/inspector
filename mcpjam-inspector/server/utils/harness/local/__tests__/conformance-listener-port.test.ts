import net from "node:net";
import { describe, expect, it } from "vitest";
import { availableListenerPort } from "../conformance/listener-port.js";

async function listen(server: net.Server, host: string, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing TCP address"));
      resolve(address.port);
    });
  });
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("conformance listener port selection", () => {
  it.each(["127.0.0.1", "0.0.0.0"] as const)("selects a bindable %s port alongside an occupied loopback listener", async (host) => {
    const occupied = net.createServer();
    const child = net.createServer();
    try {
      const busy = await listen(occupied, "127.0.0.1");
      const port = await availableListenerPort(host);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(busy);
      expect(await listen(child, host, port)).toBe(port);
    } finally {
      await close(child);
      await close(occupied);
    }
  });
});
