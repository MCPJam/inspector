import { describe, expect, it } from "vitest";
import type { MCPClientManager } from "../../mcp-client-manager/index.js";
import { CHATGPT_PROFILE_ID } from "../../events/profiles.js";
import { runEventsConformance } from "../runner.js";

/** A connected server as the runner sees it, over `transport`. */
function connected(
  transport: string,
  protocolVersion: string
): MCPClientManager {
  return {
    ensureEventsSupport: async () => ({
      declared: true,
      source: "capabilities.events",
      handshakeObserved: true,
    }),
    getNegotiatedProtocolVersion: () => protocolVersion,
    getInitializationInfo: () => ({ protocolVersion, transport }),
    listServerEvents: async () => ({
      events: [
        { name: "comment.created", delivery: ["webhook"], inputSchema: {} },
      ],
    }),
  } as unknown as MCPClientManager;
}

async function readiness(transport: string, protocolVersion: string) {
  const result = await runEventsConformance({
    manager: connected(transport, protocolVersion),
    serverId: "srv",
    profile: CHATGPT_PROFILE_ID,
    checkIds: [
      "chatgpt-readiness-protocol-version",
      "chatgpt-readiness-transport",
      "chatgpt-readiness-webhook-listed",
    ],
  });
  return Object.fromEntries(result.checks.map((check) => [check.id, check]));
}

describe("ChatGPT readiness", () => {
  it("fails a stdio server whatever version it negotiates, and titles the real negotiation", async () => {
    const checks = await readiness("stdio", "2025-11-25");
    expect(checks["chatgpt-readiness-transport"]).toMatchObject({
      status: "failed",
      title: "The connection uses stdio",
    });
    expect(checks["chatgpt-readiness-protocol-version"]).toMatchObject({
      status: "passed",
      title: "The connection negotiated 2025-11-25",
    });
  });

  it("fails a legacy SSE connection", async () => {
    const checks = await readiness("sse", "2025-03-26");
    expect(checks["chatgpt-readiness-transport"]?.status).toBe("failed");
  });

  it("passes Streamable HTTP", async () => {
    const checks = await readiness("streamable-http", "2025-11-25");
    expect(checks["chatgpt-readiness-transport"]?.status).toBe("passed");
    expect(checks["chatgpt-readiness-webhook-listed"]?.status).toBe("passed");
  });
});
