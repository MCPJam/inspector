import { MCPClientManager } from "@mcpjam/sdk";

describe("test oauth token handling", () => {
  test("valid oauth token successfully connects to server", async () => {
    console.log("ASANA_TOKEN", process.env.ASANA_TOKEN);
    const clientManager = new MCPClientManager({
      asana: {
        url: new URL("https://mcp.asana.com/sse"),
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
          },
        },
      },
    });
    console.log(await clientManager.listTools("asana"));
    expect(clientManager.getConnectionStatus("asana")).toBe("connected");
  });
});
