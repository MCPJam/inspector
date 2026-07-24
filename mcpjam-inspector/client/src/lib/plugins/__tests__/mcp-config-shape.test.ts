import { describe, it, expect } from "vitest";
import { unwrapMcpServerMap } from "../mcp-config-shape.js";

describe("unwrapMcpServerMap", () => {
  it("unwraps the mcpServers wrapper (MCPJam/Claude style)", () => {
    const result = unwrapMcpServerMap({
      mcpServers: { svr: { command: "node" } },
    });
    expect(result).toEqual({
      ok: true,
      wrapper: "mcpServers",
      servers: { svr: { command: "node" } },
    });
  });

  it("unwraps the mcp_servers wrapper (OpenAI plugin docs)", () => {
    const result = unwrapMcpServerMap({
      mcp_servers: { svr: { url: "https://x/mcp" } },
    });
    expect(result).toEqual({
      ok: true,
      wrapper: "mcp_servers",
      servers: { svr: { url: "https://x/mcp" } },
    });
  });

  it("accepts a direct server map (OpenAI direct)", () => {
    const result = unwrapMcpServerMap({
      svr: { command: "node", args: ["x.js"] },
    });
    expect(result).toEqual({
      ok: true,
      wrapper: "direct",
      servers: { svr: { command: "node", args: ["x.js"] } },
    });
  });

  it("rejects declaring both wrappers", () => {
    const result = unwrapMcpServerMap({
      mcp_servers: { a: { command: "x" } },
      mcpServers: { b: { command: "y" } },
    });
    expect(result).toEqual({ ok: false, reason: "both-wrappers" });
  });

  it("rejects a wrapper whose value is not an object", () => {
    expect(unwrapMcpServerMap({ mcpServers: "nope" })).toEqual({
      ok: false,
      reason: "wrapper-not-object",
    });
  });

  it("rejects a non-object top-level value", () => {
    expect(unwrapMcpServerMap([1, 2, 3])).toEqual({
      ok: false,
      reason: "not-object",
    });
    expect(unwrapMcpServerMap("string")).toEqual({
      ok: false,
      reason: "not-object",
    });
  });

  it("rejects a bare single server config (not a map)", () => {
    // Top-level string command means one server config, not a server MAP.
    expect(unwrapMcpServerMap({ command: "node", args: ["x"] })).toEqual({
      ok: false,
      reason: "no-server-map",
    });
    expect(unwrapMcpServerMap({ url: "https://x/mcp" })).toEqual({
      ok: false,
      reason: "no-server-map",
    });
  });

  it("does not misread arbitrary JSON as a direct server map", () => {
    // `{ servers: {} }` — the value has no command/url/type, so it is not a
    // server entry and the object is not a server map (preserves the legacy
    // 'missing mcpServers' error for such input).
    expect(unwrapMcpServerMap({ servers: {} })).toEqual({
      ok: false,
      reason: "no-server-map",
    });
    expect(unwrapMcpServerMap({})).toEqual({
      ok: false,
      reason: "no-server-map",
    });
  });

  it("treats a direct map with a type-only entry as a server map", () => {
    // No `url`/`command` — proves the `type`-only branch of server detection.
    const result = unwrapMcpServerMap({ svr: { type: "sse" } });
    expect(result.ok).toBe(true);
  });

  it("tolerates non-object sibling keys in a direct map", () => {
    // A top-level `version` alongside real servers must not defeat direct-map
    // detection (parity with the wrapped shapes).
    const result = unwrapMcpServerMap({
      version: "1.0",
      svr: { command: "node" },
    });
    expect(result).toEqual({
      ok: true,
      wrapper: "direct",
      servers: { version: "1.0", svr: { command: "node" } },
    });
  });
});
