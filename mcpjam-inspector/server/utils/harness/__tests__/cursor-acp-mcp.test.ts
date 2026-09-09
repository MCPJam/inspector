import { describe, expect, it } from "vitest";
import {
  attributeCursorToolCall,
  buildHarnessProxyMcpJson,
  harnessServerKeyToName,
  toAcpMcpServers,
} from "../mcp-config";

/**
 * The two Cursor-specific seams in `mcp-config`: the `.mcp.json` → ACP
 * `session/new` shape conversion, and tool-call attribution from the call's
 * INPUT (Cursor's stream name carries no identity at all).
 */
describe("toAcpMcpServers", () => {
  it("ALWAYS emits headers as an array, even when there are none", () => {
    // The load-bearing assertion. Omitting the key makes cursor-agent fail
    // `session/new` with an opaque JSON-RPC -32603 that names neither the field
    // nor the server, so "no headers" must be `[]` and never absent or an
    // object. Verified against cursor-agent 2026.08.31.
    const acp = toAcpMcpServers({
      mcpServers: {
        weather: { type: "http", url: "https://proxy.example/weather" },
      },
    });
    expect(acp.weather).toEqual({
      type: "http",
      url: "https://proxy.example/weather",
      headers: [],
    });
    expect(Array.isArray(acp.weather!.headers)).toBe(true);
  });

  it("converts the header OBJECT into name/value pairs", () => {
    const acp = toAcpMcpServers({
      mcpServers: {
        weather: {
          type: "http",
          url: "https://proxy.example/weather",
          headers: {
            "X-MCPJam-Proxy-Token": "tok-1",
            "X-MCPJam-Harness-Turn": "turn-1",
          },
        },
      },
    });
    expect(acp.weather!.headers).toEqual([
      { name: "X-MCPJam-Proxy-Token", value: "tok-1" },
      { name: "X-MCPJam-Harness-Turn", value: "turn-1" },
    ]);
  });

  it("carries the per-server proxy token built by the real generator", () => {
    // End to end through `buildHarnessProxyMcpJson` rather than a hand-written
    // entry: the token header is the credential the whole proxy design rests
    // on, and a conversion that dropped it would produce a turn whose MCP calls
    // are simply unauthenticated.
    const json = buildHarnessProxyMcpJson([
      {
        name: "srv-weather",
        proxyUrl: "https://inspector.example/api/mcp/adapter-http/srv-weather",
        proxyToken: "mcpjpt-abc",
        evidenceTurnId: "turn-9",
      },
    ]);
    const acp = toAcpMcpServers(json);
    const headers = acp["srv-weather"]!.headers;
    expect(headers).toContainEqual({
      name: "X-MCPJam-Proxy-Token",
      value: "mcpjpt-abc",
    });
    expect(headers).toContainEqual({
      name: "X-MCPJam-Harness-Turn",
      value: "turn-9",
    });
  });

  it("preserves the keys verbatim, so attribution still resolves", () => {
    // Renaming a key here would orphan every tool call from that server:
    // `harnessServerKeyToName` is built from the same assignment pass, and
    // nothing reconciles the two afterwards.
    const servers = [{ name: "srv a" }, { name: "srv a" }];
    const json = buildHarnessProxyMcpJson(
      servers.map((s) => ({ name: s.name, proxyUrl: "https://p.example/x" })),
    );
    const acp = toAcpMcpServers(json);
    expect(Object.keys(acp)).toEqual(Object.keys(json.mcpServers));
    expect(Object.keys(acp).sort()).toEqual(
      Object.keys(harnessServerKeyToName(servers)).sort(),
    );
  });

  it("refuses the name ACP reserves for its own tool channel", () => {
    // `createACPV1` throws on this outright. Failing here instead names MCPJam
    // and the server; re-keying would "work" and silently break attribution.
    expect(() =>
      toAcpMcpServers({
        mcpServers: {
          "ai-sdk-harness-tools": { type: "http", url: "https://p.example/x" },
        },
      }),
    ).toThrow(/reserved/i);
  });

  it("passes an empty server set through as an empty map", () => {
    expect(toAcpMcpServers({ mcpServers: {} })).toEqual({});
  });
});

describe("attributeCursorToolCall", () => {
  const keyToServerId = { weather: "srv-weather", "user-notes": "srv-notes" };

  it("reads identity out of the INPUT, not the opaque stream name", () => {
    expect(
      attributeCursorToolCall({
        rawToolName: "acp_tool_01H8XYZ",
        input: {
          providerIdentifier: "weather",
          toolName: "get_forecast",
          args: { city: "SF" },
        },
        keyToServerId,
      }),
    ).toEqual({ serverId: "srv-weather", toolName: "get_forecast" });
  });

  it("falls back to the user- prefixed form ONLY after the exact key misses", () => {
    // Cursor prefixes user-configured providers with `user-`, but not
    // universally.
    expect(
      attributeCursorToolCall({
        rawToolName: "acp_tool_2",
        input: {
          providerIdentifier: "user-weather",
          toolName: "get_forecast",
          args: {},
        },
        keyToServerId,
      }),
    ).toEqual({ serverId: "srv-weather", toolName: "get_forecast" });
  });

  it("prefers the EXACT key when a server's own name starts with user-", () => {
    // The reason the order is not "strip, then look up": `user-notes` is a real
    // key here, and stripping blindly would attribute its calls to `notes` —
    // a different server, or none.
    expect(
      attributeCursorToolCall({
        rawToolName: "acp_tool_3",
        input: {
          providerIdentifier: "user-notes",
          toolName: "search",
          args: {},
        },
        keyToServerId,
      }),
    ).toEqual({ serverId: "srv-notes", toolName: "search" });
  });

  it("keeps a native tool under its raw name with no server attribution", () => {
    // Cursor's own built-ins carry no provider identity in their input.
    expect(
      attributeCursorToolCall({
        rawToolName: "bash",
        input: { command: "ls" },
        keyToServerId,
      }),
    ).toEqual({ toolName: "bash" });
  });

  it("returns the tool name but no serverId when the key is unresolvable", () => {
    // The tool name is firsthand from the input; only the server mapping is
    // unknown, so only that is withheld. Returning the opaque `acp_tool_…` id
    // would discard a fact we actually have.
    expect(
      attributeCursorToolCall({
        rawToolName: "acp_tool_4",
        input: {
          providerIdentifier: "ghost",
          toolName: "do_thing",
          args: {},
        },
        keyToServerId,
      }),
    ).toEqual({ toolName: "do_thing" });
  });

  it("never fabricates identity from a malformed input", () => {
    for (const input of [
      undefined,
      null,
      "not-an-object",
      {},
      { providerIdentifier: "weather" },
      { toolName: "get_forecast" },
      { providerIdentifier: 7, toolName: "get_forecast" },
      { providerIdentifier: "weather", toolName: "" },
    ]) {
      expect(
        attributeCursorToolCall({
          rawToolName: "acp_tool_x",
          input,
          keyToServerId,
        }),
      ).toEqual({ toolName: "acp_tool_x" });
    }
  });
});
