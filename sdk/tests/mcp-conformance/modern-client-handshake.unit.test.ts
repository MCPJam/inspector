/**
 * `modern-client-handshake` fails only on what the specification requires.
 *
 * Server identity is a SHOULD in 2026-07-28: "Servers SHOULD include
 * `io.modelcontextprotocol/serverInfo` in every result's `_meta`"
 * (basic/index#meta) and, for the discovery result, "Servers SHOULD include
 * this field" (server/discover#discoverresult). A server that omits it is
 * conformant, so the handshake check must not fail on it.
 */

import { describe, expect, it } from "vitest";
import { CORE_CHECKS } from "../../src/mcp-conformance/checks/core.js";
import type { MCPClientCheckContext } from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const MODERN = "2026-07-28" as const;

const handshake = CORE_CHECKS.find(
  (check) => check.id === "modern-client-handshake"
)!;

function context(
  initializationInfo: Record<string, unknown> | undefined
): MCPClientCheckContext {
  return {
    manager: {} as MCPClientCheckContext["manager"],
    client: {} as MCPClientCheckContext["client"],
    serverId: "server-1",
    config: normalizeMCPConformanceConfig({
      serverUrl: "https://example.com/mcp",
      protocolVersion: MODERN,
    }),
    initializationInfo:
      initializationInfo as MCPClientCheckContext["initializationInfo"],
    availableTools: [],
    availablePrompts: [],
    availableResources: [],
    availableResourceTemplates: [],
  };
}

describe("modern-client-handshake", () => {
  it("passes a server that sends no serverInfo", async () => {
    const result = await handshake.run(
      context({
        protocolVersion: MODERN,
        transport: "streamable-http",
        serverCapabilities: { tools: {} },
      })
    );
    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({ serverIdentityPresent: false });
  });

  it("passes a server whose serverInfo carries no name", async () => {
    const result = await handshake.run(
      context({
        protocolVersion: MODERN,
        transport: "streamable-http",
        serverCapabilities: {},
        serverVersion: { version: "1.0.0" },
      })
    );
    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({ serverIdentityPresent: false });
  });

  it("passes and reports identity when the server sends it", async () => {
    const result = await handshake.run(
      context({
        protocolVersion: MODERN,
        transport: "streamable-http",
        serverCapabilities: {},
        serverVersion: { name: "fixture", version: "1.0.0" },
      })
    );
    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({ serverIdentityPresent: true });
  });

  it("still fails when the negotiated revision is not the pinned one", async () => {
    const result = await handshake.run(
      context({
        protocolVersion: "2025-11-25",
        transport: "streamable-http",
        serverCapabilities: {},
        serverVersion: { name: "fixture", version: "1.0.0" },
      })
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain(
      "negotiated protocol version 2025-11-25 does not match the pinned 2026-07-28"
    );
  });

  it("still fails when the server capabilities are missing", async () => {
    const result = await handshake.run(
      context({
        protocolVersion: MODERN,
        transport: "streamable-http",
        serverVersion: { name: "fixture", version: "1.0.0" },
      })
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("server capabilities are missing");
  });
});
