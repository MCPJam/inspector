import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClientManager } from "../src/mcp-client-manager";
import { vi } from "vitest";

describe("caller cancellation during connection startup", () => {
  it.each(["http", "sse"])(
    "aborts hanging %s startup without retries or a late connection",
    async (transport) => {
      let reached!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const server: Server = createServer((_req, res) => {
        reached();
        if (transport === "sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(": waiting\n\n");
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      const address = server.address() as { port: number };
      const manager = new MCPClientManager(
        {},
        { retryPolicy: { retries: 2, retryDelayMs: 1 } }
      );
      const controller = new AbortController();
      try {
        const attempt = manager.connectToServer(
          "pending",
          {
            url: `http://127.0.0.1:${address.port}/${transport}`,
            preferSSE: transport === "sse",
            timeout: 10000,
          },
          { signal: controller.signal }
        );
        const observed = attempt.catch((error) => error);
        await requestStarted;
        controller.abort(new DOMException("cancelled by caller", "AbortError"));
        expect(await observed).toBeInstanceOf(Error);
        expect(manager.getConnectionStatus("pending")).not.toBe("connected");
      } finally {
        await manager.disconnectAllServers();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
  it("waits for a stdio child to exit and never publishes the cancelled client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-cancel-"));
    const pidFile = join(directory, "pid");
    const manager = new MCPClientManager({});
    const controller = new AbortController();
    try {
      const attempt = manager.connectToServer(
        "child",
        {
          command: process.execPath,
          args: [
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000)`,
          ],
          supportedProtocolVersions: ["2025-11-25"],
          timeout: 10000,
        },
        { signal: controller.signal }
      );
      const observed = attempt.catch((error) => error);
      let pid = 0;
      await vi.waitFor(async () => {
        pid = Number(await readFile(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
      });
      controller.abort();
      await observed;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(manager.getConnectionStatus("child")).not.toBe("connected");
    } finally {
      await manager.disconnectAllServers();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not start resources when already cancelled", async () => {
    const manager = new MCPClientManager({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.connectToServer(
        "child",
        { command: "must-not-run" },
        { signal: controller.signal }
      )
    ).rejects.toHaveProperty("name", "AbortError");
    expect(manager.getConnectionStatus("child")).not.toBe("connected");
  });
});
