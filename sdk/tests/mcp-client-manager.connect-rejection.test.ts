import { MCPClientManager } from "../src/mcp-client-manager";

// The constructor kicks off eager connects and discards the promise; a
// failed connect must be re-surfaced to the first caller that uses the
// server, NOT escape as a process-level unhandledRejection. In production
// every transient hosted-connect failure emitted a paired
// process.unhandled_rejection event because of this.
describe("MCPClientManager connect rejection handling", () => {
  it("does not leak an unhandledRejection when an eager connect fails", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    const manager = new MCPClientManager({
      // TCP port 1 on localhost is never listening — the connect fails
      // fast with a connection-class error.
      failing: { url: "http://127.0.0.1:1/mcp" },
    });

    try {
      // Let the eager connect fail and give Node a macrotask turn to emit
      // unhandledRejection for any unobserved promise.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rejections).toEqual([]);

      // The failure is still observable: the failed attempt cleared its
      // live state, so an explicit connect re-attempts and rejects to the
      // caller.
      await expect(
        manager.connectToServer("failing", { url: "http://127.0.0.1:1/mcp" })
      ).rejects.toThrow();
    } finally {
      process.off("unhandledRejection", onRejection);
      await manager.disconnectAllServers();
    }
  }, 15000);
});
