import { MCPClientManager } from "@mcpjam/sdk";

describe("test oauth token handling", () => {
  test("valid oauth token successfully connects to server", async () => {
    const clientManager = new MCPClientManager();
    await clientManager.connectToServer("asana", {
      url: new URL("https://mcp.asana.com/sse"),
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
        },
      },
    });
    expect(await clientManager.getConnectionStatus("asana")).toBe("connected");
    await clientManager.disconnectServer("asana");
  });

  test("invalid oauth token fails to connect to server", async () => {
    const config = {
      url: new URL("https://mcp.asana.com/sse"),
      requestInit: {
        headers: {
          Authorization: `Bearer abcxyz`,
        },
      },
    };
    const clientManager = new MCPClientManager();
    await expect(
      clientManager.connectToServer("asana", config)
    ).rejects.toThrow();
  });
});
