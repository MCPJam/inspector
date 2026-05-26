import { MCPClientManager } from "../src/mcp-client-manager";
import { startMockHttpServer, MOCK_TOOLS } from "./mock-servers";

describe("MCPClientManager", () => {
  describe("multiple servers", () => {
    let manager: MCPClientManager;
    let serverUrl: string;
    let stopServer: () => Promise<void>;

    beforeAll(async () => {
      const result = await startMockHttpServer();
      serverUrl = result.url;
      stopServer = result.stop;
    });

    afterAll(async () => {
      await stopServer();
    });

    beforeEach(() => {
      manager = new MCPClientManager();
    });

    afterEach(async () => {
      await manager.disconnectAllServers();
    });

    it("should manage multiple servers simultaneously", async () => {
      await Promise.all([
        manager.connectToServer("stdio-server", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        }),
        manager.connectToServer("http-server", {
          url: serverUrl,
          preferSSE: true,
        }),
      ]);

      expect(manager.listServers()).toHaveLength(2);
      expect(manager.getConnectionStatus("stdio-server")).toBe("connected");
      expect(manager.getConnectionStatus("http-server")).toBe("connected");

      const [stdioResult, httpResult] = await Promise.all([
        manager.executeTool("stdio-server", "echo", { message: "from stdio" }),
        manager.executeTool("http-server", "echo", { message: "from http" }),
      ]);

      expect((stdioResult as any).content[0].text).toBe("Echo: from stdio");
      expect((httpResult as any).content[0].text).toBe("Echo: from http");
    }, 60000);

    it("should get tools from all servers", async () => {
      await Promise.all([
        manager.connectToServer("server-a", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        }),
        manager.connectToServer("server-b", {
          url: serverUrl,
          preferSSE: true,
        }),
      ]);

      const result = await manager.getTools();
      expect(result.length).toBeGreaterThan(MOCK_TOOLS.length);
    }, 30000);

    it("should disconnect all servers", async () => {
      await Promise.all([
        manager.connectToServer("disc-a", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        }),
        manager.connectToServer("disc-b", {
          url: serverUrl,
          preferSSE: true,
        }),
      ]);

      await manager.disconnectAllServers();

      expect(manager.getConnectionStatus("disc-a")).toBe("disconnected");
      expect(manager.getConnectionStatus("disc-b")).toBe("disconnected");
      expect(manager.hasServer("disc-a")).toBe(true);
      expect(manager.hasServer("disc-b")).toBe(true);
      expect(manager.listServers()).toEqual(
        expect.arrayContaining(["disc-a", "disc-b"])
      );
    }, 30000);
  });
});
