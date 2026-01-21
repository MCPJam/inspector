import { MCPClientManager } from "../src/mcp-client-manager";

describe("MCPClientManager", () => {
  describe("constructor", () => {
    it("Should be able to connect to an MCP server with node", async () => {
      const manager = new MCPClientManager(
        {
          everything: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
          },
        },
        {
          defaultClientName: "mcpjam-inspector",
          defaultClientVersion: "1.0.0",
        }
      );
      expect(manager).toBeInstanceOf(MCPClientManager);
      const result = await manager.executeTool("everything", "echo", {
        message: "Hello, world!",
      });
      expect((result as any).content[0].text).toBe("Echo: Hello, world!");
      await manager.disconnectServer("everything");
    });

    // it("should support HTTP server config", () => {
    //   const manager = new MCPClientManager(
    //     {
    //       httpServer: {
    //         url: new URL("https://example.com/mcp"),
    //         accessToken: "test-token",
    //       },
    //     },
    //     {
    //       defaultClientName: "test-client",
    //       defaultClientVersion: "1.0.0",
    //     }
    //   );

    //   expect(manager).toBeInstanceOf(MCPClientManager);
    //   expect(manager.hasServer("httpServer")).toBe(true);
    // });

    // it("should support HTTP server config with requestInit", () => {
    //   const manager = new MCPClientManager({
    //     httpServer: {
    //       url: new URL("https://example.com/mcp"),
    //       requestInit: {
    //         headers: {
    //           Authorization: "Bearer token",
    //         },
    //       },
    //     },
    //   });

    //   expect(manager).toBeInstanceOf(MCPClientManager);
    // });
  });

  // describe("server management", () => {
  //   it("should list registered servers", () => {
  //     const manager = new MCPClientManager({
  //       server1: { command: "node", args: ["server1.js"] },
  //       server2: { command: "node", args: ["server2.js"] },
  //     });

  //     const servers = manager.listServers();
  //     expect(servers).toContain("server1");
  //     expect(servers).toContain("server2");
  //     expect(servers).toHaveLength(2);
  //   });

  //   it("should report connection status", () => {
  //     const manager = new MCPClientManager({
  //       testServer: { command: "node", args: ["test.js"] },
  //     });

  //     // Server starts connecting immediately, so status should be "connecting"
  //     const status = manager.getConnectionStatus("testServer");
  //     expect(["connecting", "disconnected"]).toContain(status);
  //   });

  //   it("should return undefined for unknown server config", () => {
  //     const manager = new MCPClientManager();
  //     expect(manager.getServerConfig("unknown")).toBeUndefined();
  //   });

  //   it("should return server config for registered server", () => {
  //     const manager = new MCPClientManager({
  //       testServer: {
  //         command: "node",
  //         args: ["test.js"],
  //         env: { TEST: "value" },
  //       },
  //     });

  //     const config = manager.getServerConfig("testServer");
  //     expect(config).toBeDefined();
  //     expect((config as any).command).toBe("node");
  //   });
  // });

  // describe("error handling", () => {
  //   it("should throw when accessing unknown server", async () => {
  //     const manager = new MCPClientManager();

  //     await expect(manager.listTools("unknown")).rejects.toThrow(
  //       'Unknown MCP server "unknown"'
  //     );
  //   });

  //   it("should throw when getting client for unknown server", () => {
  //     const manager = new MCPClientManager();
  //     expect(manager.getClient("unknown")).toBeUndefined();
  //   });
  // });

  // describe("server summaries", () => {
  //   it("should return server summaries", () => {
  //     const manager = new MCPClientManager({
  //       server1: { command: "node", args: ["server1.js"] },
  //     });

  //     const summaries = manager.getServerSummaries();
  //     expect(summaries).toHaveLength(1);
  //     expect(summaries[0].id).toBe("server1");
  //     expect(summaries[0].config).toBeDefined();
  //   });
  // });
});
