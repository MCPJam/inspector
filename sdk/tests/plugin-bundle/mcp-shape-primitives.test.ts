/**
 * The two pure MCP-config shape primitives exported for consumers whose
 * POLICY differs from the plugin import path (the inspector's MCP-JSON
 * import). They must classify shapes and transports identically to the strict
 * normalizer while applying none of its rules.
 */

import { describe, expect, it } from "vitest";
import {
  detectPluginMcpTransport,
  selectPluginMcpServerMap,
} from "../../src/plugin-bundle/index.js";

describe("selectPluginMcpServerMap", () => {
  const entry = { url: "https://mcp.example.com/mcp" };

  it.each([
    ["direct map", { crm: entry }, null],
    ["mcp_servers wrapper", { mcp_servers: { crm: entry } }, "mcp_servers"],
    ["mcpServers wrapper", { mcpServers: { crm: entry } }, "mcpServers"],
  ])("selects the %s shape", (_label, raw, wrapperKey) => {
    const result = selectPluginMcpServerMap(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wrapperKey).toBe(wrapperKey);
    expect(result.servers).toEqual([{ key: "crm", config: entry }]);
  });

  it("preserves declaration order", () => {
    const result = selectPluginMcpServerMap({ b: entry, a: entry, c: entry });
    expect(result.ok && result.servers.map((s) => s.key)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("hands back configuration values verbatim", () => {
    // The selector is shape-only: it must NOT strip the values the strict
    // normalizer drops, because the inspector's JSON import needs them.
    const withValues = {
      crm: { command: "npx", env: { API_KEY: "sk-live-abc" } },
    };
    const result = selectPluginMcpServerMap(withValues);
    expect(result.ok && result.servers[0].config).toEqual(withValues.crm);
  });

  it("applies no server-name or URL policy", () => {
    // Both entries would be rejected by the strict plugin path (illegal key,
    // plain-HTTP remote URL); the selector keeps them for the caller to judge.
    const result = selectPluginMcpServerMap({
      "my server": { url: "http://192.168.1.10:3000/mcp" },
    });
    expect(result.ok && result.servers).toHaveLength(1);
  });

  it.each([
    ["a non-object", 42, "MCP_INVALID_CONFIG"],
    ["an array", [], "MCP_INVALID_CONFIG"],
    ["null", null, "MCP_INVALID_CONFIG"],
    [
      "both wrappers",
      { mcp_servers: {}, mcpServers: {} },
      "MCP_DUPLICATE_WRAPPER",
    ],
    ["a bare stdio server", { command: "npx" }, "MCP_INVALID_CONFIG"],
    [
      "a bare http server",
      { url: "https://x.example.com" },
      "MCP_INVALID_CONFIG",
    ],
    ["a non-object wrapper", { mcpServers: [] }, "MCP_INVALID_CONFIG"],
  ])("rejects %s", (_label, raw, code) => {
    const result = selectPluginMcpServerMap(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
  });

  it("keeps a server legitimately NAMED url or command", () => {
    // Only STRING command/url values indicate the bare-server shape.
    const result = selectPluginMcpServerMap({
      url: { command: "npx", args: ["serve"] },
    });
    expect(result.ok && result.servers[0].key).toBe("url");
  });
});

describe("detectPluginMcpTransport", () => {
  it.each([
    ["stdio", { type: "stdio", command: "npx" }, "stdio"],
    ["explicit http", { type: "http", url: "https://x.example.com" }, "http"],
    ["sse", { type: "sse", url: "https://x.example.com" }, "http"],
    ["streamable_http", { type: "streamable_http", url: "https://x.com" }, "http"],
    ["STREAMABLE-HTTP", { type: "STREAMABLE-HTTP", url: "https://x.com" }, "http"],
    // The spec fixes the transport's NAME, not its config spelling; all three
    // conventions appear across MCP implementations.
    ["streamableHttp", { type: "streamableHttp", url: "https://x.com" }, "http"],
    ["the transport alias", { transport: "stdio", command: "npx" }, "stdio"],
  ])("classifies %s from the discriminator", (_label, config, transport) => {
    expect(detectPluginMcpTransport(config)).toEqual({ ok: true, transport });
  });

  it("infers stdio from command and http from url", () => {
    expect(detectPluginMcpTransport({ command: "npx" })).toEqual({
      ok: true,
      transport: "stdio",
    });
    expect(detectPluginMcpTransport({ url: "https://x.example.com" })).toEqual({
      ok: true,
      transport: "http",
    });
  });

  it.each([
    ["both command and url", { command: "npx", url: "u" }, "MCP_AMBIGUOUS_TRANSPORT"],
    ["neither", {}, "MCP_UNKNOWN_TRANSPORT"],
    ["an unknown transport", { type: "carrier-pigeon" }, "MCP_UNKNOWN_TRANSPORT"],
    ["a non-string transport", { type: 7 }, "MCP_UNKNOWN_TRANSPORT"],
    ["a non-object config", "npx", "MCP_INVALID_SERVER"],
    ["an array config", [], "MCP_INVALID_SERVER"],
    ["null", null, "MCP_INVALID_SERVER"],
  ])("rejects %s", (_label, config, code) => {
    const result = detectPluginMcpTransport(config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
  });

  it("names the server in its message when given a key", () => {
    const result = detectPluginMcpTransport({}, "crm");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"crm"');
  });
});
