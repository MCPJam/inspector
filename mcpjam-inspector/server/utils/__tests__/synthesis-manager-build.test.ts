/**
 * Tests for `synthesis-manager-build.ts`.
 *
 * We don't open real MCP sockets — vitest doesn't have a server. The
 * surface we lock down is the normalized config shape that the SDK
 * constructor receives, so the durable runner's manager is equivalent
 * to what `createAuthorizedManager` would build for the same inputs.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const constructorCalls: Array<{
  configs: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];
const disconnectAllServers = vi.fn(async () => {});

vi.mock("@mcpjam/sdk", () => ({
  MCPClientManager: class {
    constructor(
      configs: Record<string, unknown>,
      options: Record<string, unknown>,
    ) {
      constructorCalls.push({ configs, options });
    }
    disconnectAllServers = disconnectAllServers;
  },
  DEFAULT_RETRY_POLICY: {
    initial: 100,
    maxAttempts: 3,
  },
}));

import { buildSynthesisManager } from "../synthesis-manager-build";
import { INSPECTOR_MCP_RETRY_POLICY } from "../mcp-retry-policy";

beforeEach(() => {
  constructorCalls.length = 0;
  disconnectAllServers.mockClear();
});

describe("buildSynthesisManager", () => {
  it("builds an HttpServerConfig with the descriptor URL and headers", () => {
    const { manager, connectedServerIds, dispose } = buildSynthesisManager({
      descriptor: {
        selectedServerIds: ["srv-1"],
        perServer: [
          {
            serverId: "srv-1",
            transportType: "http",
            url: "https://example.test/mcp",
            headers: { "X-Custom": "value" },
          },
        ],
      },
      timeoutMs: 12_345,
    });

    expect(manager).toBeDefined();
    expect(connectedServerIds).toEqual(["srv-1"]);
    expect(typeof dispose).toBe("function");
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]!.configs).toEqual({
      "srv-1": {
        url: "https://example.test/mcp",
        requestInit: {
          headers: { "X-Custom": "value" },
        },
        timeout: 12_345,
      },
    });
    expect(constructorCalls[0]!.options).toMatchObject({
      defaultTimeout: 12_345,
      retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
    });
  });

  it("injects an Authorization Bearer header when useOAuth + token are present", () => {
    buildSynthesisManager({
      descriptor: {
        selectedServerIds: ["srv-oauth"],
        perServer: [
          {
            serverId: "srv-oauth",
            transportType: "http",
            url: "https://oauth.test/mcp",
            useOAuth: true,
            oauthAccessToken: "tok-abc",
            headers: { "X-Other": "v" },
          },
        ],
      },
      timeoutMs: 1000,
    });
    const headers = (
      (constructorCalls[0]!.configs as Record<string, any>)["srv-oauth"]
        .requestInit as { headers: Record<string, string> }
    ).headers;
    expect(headers.Authorization).toBe("Bearer tok-abc");
    expect(headers["X-Other"]).toBe("v");
  });

  it("skips entries with no URL or non-http transport", () => {
    const { connectedServerIds } = buildSynthesisManager({
      descriptor: {
        selectedServerIds: ["srv-good", "srv-no-url", "srv-stdio"],
        perServer: [
          {
            serverId: "srv-good",
            transportType: "http",
            url: "https://good.test/mcp",
          },
          { serverId: "srv-no-url", transportType: "http" },
          { serverId: "srv-stdio", transportType: "stdio" },
        ],
      },
      timeoutMs: 1000,
    });
    expect(connectedServerIds).toEqual(["srv-good"]);
    expect(Object.keys(constructorCalls[0]!.configs)).toEqual(["srv-good"]);
  });

  it("ignores perServer entries not present in selectedServerIds", () => {
    const { connectedServerIds } = buildSynthesisManager({
      descriptor: {
        selectedServerIds: ["srv-a"],
        perServer: [
          {
            serverId: "srv-a",
            transportType: "http",
            url: "https://a.test/mcp",
          },
          {
            serverId: "srv-b",
            transportType: "http",
            url: "https://b.test/mcp",
          },
        ],
      },
      timeoutMs: 1000,
    });
    expect(connectedServerIds).toEqual(["srv-a"]);
  });

  it("drops non-string header values defensively", () => {
    buildSynthesisManager({
      descriptor: {
        selectedServerIds: ["srv-x"],
        perServer: [
          {
            serverId: "srv-x",
            transportType: "http",
            url: "https://x.test/mcp",
            headers: {
              good: "yes",
              bad: 42 as unknown as string,
              "": "empty-key",
            },
          },
        ],
      },
      timeoutMs: 1000,
    });
    const headers = (
      (constructorCalls[0]!.configs as Record<string, any>)["srv-x"]
        .requestInit as { headers: Record<string, string> }
    ).headers;
    expect(headers).toEqual({ good: "yes" });
  });

  it("dispose() forwards to manager.disconnectAllServers()", async () => {
    const { dispose } = buildSynthesisManager({
      descriptor: {
        selectedServerIds: ["srv-1"],
        perServer: [
          {
            serverId: "srv-1",
            transportType: "http",
            url: "https://x.test/mcp",
          },
        ],
      },
      timeoutMs: 1000,
    });
    await dispose();
    expect(disconnectAllServers).toHaveBeenCalledTimes(1);
  });
});
