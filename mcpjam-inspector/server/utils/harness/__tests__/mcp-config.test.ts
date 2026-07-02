import { describe, it, expect } from "vitest";
import {
  buildHarnessProxyMcpJson,
  harnessServerKeyToName,
  parseHarnessToolName,
  serializeHarnessMcpJson,
  type HarnessProxyServerInput,
} from "../mcp-config.js";

const srv = (
  name: string,
  proxyUrl: string,
  proxyToken = "tok",
): HarnessProxyServerInput => ({ name, proxyUrl, proxyToken });

describe("buildHarnessProxyMcpJson", () => {
  it("points every entry at its proxy URL with ONLY the proxy token (no upstream headers)", () => {
    const out = buildHarnessProxyMcpJson([
      srv("notion", "https://abc.tunnels.mcpjam.com/api/mcp/adapter-http/notion?k=s1", "t1"),
    ]);
    expect(out.mcpServers.notion).toEqual({
      type: "http",
      url: "https://abc.tunnels.mcpjam.com/api/mcp/adapter-http/notion?k=s1",
      headers: { "X-MCPJam-Proxy-Token": "t1" },
    });
    // The win: no upstream Authorization ever reaches the sandbox file.
    expect(
      JSON.stringify(out).toLowerCase().includes("authorization"),
    ).toBe(false);
  });

  it("sanitizes and de-duplicates colliding server names into distinct keys", () => {
    const out = buildHarnessProxyMcpJson([
      srv("My Server", "https://t/api/mcp/adapter-http/a?k=1"),
      srv("My/Server", "https://t/api/mcp/adapter-http/b?k=2"),
    ]);
    const keys = Object.keys(out.mcpServers);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2); // no collision
    expect(keys.every((k) => /^[A-Za-z0-9_-]+$/.test(k))).toBe(true);
  });

  it("returns an empty object for no servers", () => {
    expect(buildHarnessProxyMcpJson([])).toEqual({ mcpServers: {} });
  });

  it("omits the proxy-token header when no token is supplied (local plane)", () => {
    const out = buildHarnessProxyMcpJson([
      { name: "local", proxyUrl: "https://t/api/mcp/adapter-http/local?k=1" },
    ]);
    expect(out.mcpServers.local).toEqual({
      type: "http",
      url: "https://t/api/mcp/adapter-http/local?k=1",
    });
    expect(out.mcpServers.local.headers).toBeUndefined();
  });
});

describe("serializeHarnessMcpJson", () => {
  it("pretty-prints the .mcp.json", () => {
    const json = buildHarnessProxyMcpJson([
      srv("a", "https://t/api/mcp/adapter-http/a?k=1", "t1"),
    ]);
    const text = serializeHarnessMcpJson(json);
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"X-MCPJam-Proxy-Token": "t1"');
    expect(text).toBe(JSON.stringify(json, null, 2));
  });
});

describe("harnessServerKeyToName", () => {
  it("maps the SAME keys buildHarnessProxyMcpJson produces back to serverIds", () => {
    const servers = [
      srv("weather", "https://t/api/mcp/adapter-http/weather?k=1"),
      srv("My Server 2", "https://t/api/mcp/adapter-http/srv2?k=2"),
    ];
    const keyToName = harnessServerKeyToName(servers);
    expect(Object.keys(keyToName).sort()).toEqual(
      Object.keys(buildHarnessProxyMcpJson(servers).mcpServers).sort(),
    );
    expect(Object.values(keyToName).sort()).toEqual(
      ["My Server 2", "weather"].sort(),
    );
  });
});

describe("parseHarnessToolName", () => {
  const map = { weather: "srv_weather", My_Server_2: "srv-id-2" };

  it("splits mcp__<server>__<tool> into serverId + un-namespaced tool", () => {
    expect(parseHarnessToolName("mcp__weather__get_forecast", map)).toEqual({
      serverId: "srv_weather",
      toolName: "get_forecast",
    });
  });

  it("delimits on the first '__' (sanitized keys never contain one)", () => {
    expect(parseHarnessToolName("mcp__My_Server_2__do__thing", map)).toEqual({
      serverId: "srv-id-2",
      toolName: "do__thing",
    });
  });

  it("returns native (un-prefixed) tool names unchanged, no serverId", () => {
    expect(parseHarnessToolName("Bash", map)).toEqual({ toolName: "Bash" });
  });

  it("returns the raw name when the server key is unknown", () => {
    expect(parseHarnessToolName("mcp__unknown__tool", map)).toEqual({
      toolName: "mcp__unknown__tool",
    });
  });
});
