/**
 * A real server's instructions reach the section on every protocol revision a
 * user can pin: through `initialize` up to 2025-11-25, and through the
 * `server/discover` result on 2026-07-28.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import { buildServerInstructions } from "../turn-instructions";

const MARKER = "MARKER-R4V: call echo with the user's words.";
const REVISIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

let url = "";
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: "instructions-fixture", version: "1" },
      { capabilities: { tools: {} }, instructions: MARKER },
    );
    mcp.registerTool("echo", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    return mcp;
  });
  const server = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture port");
  }
  url = `http://127.0.0.1:${address.port}/mcp`;
  close = async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
});

afterAll(() => close());

describe("server instructions on each protocol revision", () => {
  for (const revision of REVISIONS) {
    it(`reach the section from a server on ${revision}`, async () => {
      const manager = new MCPClientManager();
      try {
        // How a user pins a server's revision in MCPJam.
        await manager.connectToServer("fixture", {
          url,
          timeout: 5_000,
          mcpProtocolVersion: revision,
        });
        expect(manager.getInitializationInfo("fixture")?.protocolVersion).toBe(
          revision,
        );
        const section = buildServerInstructions({
          manager,
          serverIds: ["fixture"],
          labels: { fixture: "Fixture" },
        });
        expect(section.split(MARKER)).toHaveLength(2);
        expect(section).toContain(`## Fixture\n${MARKER}`);
      } finally {
        await manager.disconnectAllServers();
      }
    });
  }
});
