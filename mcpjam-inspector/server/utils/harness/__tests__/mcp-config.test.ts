import { describe, it, expect } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk";
import {
  buildHarnessMcpJson,
  harnessServerInputFromConfig,
  harnessServerKeyToName,
  parseHarnessToolName,
  serializeHarnessMcpJson,
  HarnessMcpConfigError,
} from "../mcp-config.js";

describe("buildHarnessMcpJson", () => {
  it("maps a remote http server to a direct http entry", () => {
    const out = buildHarnessMcpJson([
      {
        name: "weather",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer t" },
      },
    ]);
    expect(out.mcpServers.weather).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("maps a local stdio server to its tunnel url as an http entry", () => {
    const tunnelUrl =
      "https://slug.tunnels.mcpjam.com/api/mcp/adapter-http/srv?k=secret";
    const out = buildHarnessMcpJson([
      { name: "files", transport: "stdio", tunnelUrl },
    ]);
    expect(out.mcpServers.files).toEqual({ type: "http", url: tunnelUrl });
  });

  it("omits empty headers", () => {
    const out = buildHarnessMcpJson([
      { name: "x", transport: "http", url: "https://x", headers: {} },
    ]);
    expect(out.mcpServers.x.headers).toBeUndefined();
  });

  it("sanitizes names and de-duplicates collisions", () => {
    const out = buildHarnessMcpJson([
      { name: "My Server!", transport: "http", url: "https://a" },
      { name: "My/Server?", transport: "http", url: "https://b" },
    ]);
    const keys = Object.keys(out.mcpServers);
    expect(keys).toContain("My_Server");
    expect(keys).toContain("My_Server_2");
    expect(keys).toHaveLength(2);
  });

  it("falls back to 'server' for an all-symbol name", () => {
    const out = buildHarnessMcpJson([
      { name: "!!!", transport: "http", url: "https://a" },
    ]);
    expect(Object.keys(out.mcpServers)).toEqual(["server"]);
  });

  it("returns an empty mcpServers map for no servers", () => {
    expect(buildHarnessMcpJson([])).toEqual({ mcpServers: {} });
  });
});

describe("harnessServerInputFromConfig", () => {
  it("normalizes an http config (url + headers)", () => {
    const cfg = {
      url: "https://api/mcp",
      requestInit: { headers: { "X-Foo": "bar" } },
    } as unknown as MCPServerConfig;
    expect(harnessServerInputFromConfig("remote", cfg)).toEqual({
      name: "remote",
      transport: "http",
      url: "https://api/mcp",
      headers: { "X-Foo": "bar" },
    });
  });

  it("adds Authorization from a bare accessToken", () => {
    const cfg = {
      url: "https://api/mcp",
      accessToken: "tok",
    } as unknown as MCPServerConfig;
    const input = harnessServerInputFromConfig("remote", cfg);
    expect(input.transport).toBe("http");
    expect(input.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("does not clobber an existing Authorization header", () => {
    const cfg = {
      url: "https://api/mcp",
      accessToken: "tok",
      requestInit: { headers: { Authorization: "Bearer existing" } },
    } as unknown as MCPServerConfig;
    const input = harnessServerInputFromConfig("remote", cfg);
    expect(input.headers).toEqual({ Authorization: "Bearer existing" });
  });

  it("treats Authorization header keys case-insensitively", () => {
    const cfg = {
      url: "https://api/mcp",
      accessToken: "tok",
      requestInit: { headers: { AUTHORIZATION: "Bearer existing" } },
    } as unknown as MCPServerConfig;
    const input = harnessServerInputFromConfig("remote", cfg);
    expect(input.headers).toEqual({ AUTHORIZATION: "Bearer existing" });
  });

  it("normalizes a stdio config to its tunnel url", () => {
    const cfg = {
      command: "node",
      args: ["x.js"],
    } as unknown as MCPServerConfig;
    expect(
      harnessServerInputFromConfig("local", cfg, {
        tunnelUrl: "https://t/u?k=s",
      }),
    ).toEqual({
      name: "local",
      transport: "stdio",
      tunnelUrl: "https://t/u?k=s",
    });
  });

  it("throws for a stdio config without a tunnel url", () => {
    const cfg = { command: "node" } as unknown as MCPServerConfig;
    expect(() => harnessServerInputFromConfig("local", cfg)).toThrow(
      HarnessMcpConfigError,
    );
  });
});

describe("serializeHarnessMcpJson", () => {
  it("produces parseable JSON round-tripping the object", () => {
    const json = buildHarnessMcpJson([
      { name: "w", transport: "http", url: "https://x" },
    ]);
    expect(JSON.parse(serializeHarnessMcpJson(json))).toEqual(json);
  });
});

describe("harnessServerKeyToName", () => {
  it("maps sanitized keys back to original input names (deduped)", () => {
    const map = harnessServerKeyToName([
      { name: "My Server!", transport: "http", url: "https://a" },
      { name: "My/Server?", transport: "http", url: "https://b" },
    ]);
    expect(map).toEqual({
      My_Server: "My Server!",
      My_Server_2: "My/Server?",
    });
  });

  it("uses the same keys buildHarnessMcpJson produces", () => {
    const servers = [
      { name: "alpha", transport: "http" as const, url: "https://a" },
      { name: "beta", transport: "http" as const, url: "https://b" },
    ];
    expect(Object.keys(harnessServerKeyToName(servers)).sort()).toEqual(
      Object.keys(buildHarnessMcpJson(servers).mcpServers).sort(),
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
