import { createServer, type Server } from "node:http";
import { setImmediate as setImmediateAsync } from "node:timers/promises";

import { MCPClientManager } from "../src/mcp-client-manager";

// The constructor kicks off eager connects and discards the promise; a
// failed connect must be re-surfaced to the first caller that uses the
// server, NOT escape as a process-level unhandledRejection. In production
// every transient hosted-connect failure emitted a paired
// process.unhandled_rejection event because of this.
describe("MCPClientManager connect rejection handling", () => {
  let server: Server;
  let url: string;

  // A server we own that destroys every connection: a deterministic
  // connection-class failure, with no dependence on which ports happen to
  // be free on the host.
  beforeAll(async () => {
    server = createServer();
    server.on("connection", (socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected an AddressInfo from the test server");
    }
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("does not leak an unhandledRejection when an eager connect fails", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    // Resolves when the manager reports the eager attempt as settled, so
    // the assertion never races the connect.
    let signalAttemptSettled: () => void;
    const attemptSettled = new Promise<void>((resolve) => {
      signalAttemptSettled = resolve;
    });

    const manager = new MCPClientManager(
      { failing: { url } },
      {
        negotiationOutcomeLogger: (event) => {
          if (event.serverId === "failing" && event.outcome === "failed") {
            signalAttemptSettled();
          }
        },
      }
    );

    try {
      await attemptSettled;
      // unhandledRejection is emitted after the microtask queue drains;
      // yield the macrotask turn so any unobserved rejection has fired.
      await setImmediateAsync();
      await setImmediateAsync();
      expect(rejections).toEqual([]);

      // The failure is still observable: the failed attempt cleared its
      // live state, so an explicit connect re-attempts and rejects to the
      // caller.
      await expect(
        manager.connectToServer("failing", { url })
      ).rejects.toThrow();
    } finally {
      process.off("unhandledRejection", onRejection);
      await manager.disconnectAllServers();
    }
  }, 15000);
});
