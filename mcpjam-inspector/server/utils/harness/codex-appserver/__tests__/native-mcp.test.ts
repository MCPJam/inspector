import { describe, expect, it } from "vitest";
import {
  codexNativeMcpServers,
  refreshNativeMcpServers,
  renderCodexNativeMcpServers,
} from "../shared/native-mcp.js";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";

describe("Codex per-server MCP configuration", () => {
  const current = {
    a: {
      type: "http" as const,
      url: "https://proxy.example/a",
      timeout: 60000,
      headers: { Connection: "close", "X-MCPJam-Forwarding-Context": "old" },
    },
  };
  it("refreshes only the connection context on the existing route", () => {
    const result = refreshNativeMcpServers(current, {
      a: {
        ...current.a,
        timeout: 1,
        headers: { ...current.a.headers, "X-MCPJam-Forwarding-Context": "new" },
      },
    });
    expect(result.a.timeout).toBe(60000);
    expect(result.a.headers["X-MCPJam-Forwarding-Context"]).toBe("new");
    expect(current.a.headers["X-MCPJam-Forwarding-Context"]).toBe("old");
  });
  it("rejects changing the account route or server selection during a pause", () => {
    expect(() => refreshNativeMcpServers(current, {})).toThrow(
      "selection changed",
    );
    expect(() =>
      refreshNativeMcpServers(current, {
        a: { ...current.a, url: "https://other.example" },
      }),
    ).toThrow("cannot be replaced");
    expect(() =>
      refreshNativeMcpServers(current, {
        a: {
          ...current.a,
          headers: { ...current.a.headers, Authorization: "untrusted" },
        },
      }),
    ).toThrow("cannot be replaced");
  });
  it("quotes server keys and writes explicit runtime approval policy", () => {
    const config = renderCodexNativeMcpServers({ mcpServers: current }).join(
      "\n",
    );
    expect(config).toContain('[mcp_servers."a"]');
    expect(config).toContain('default_tools_approval_mode = "approve"');
    expect(config).toContain('"X-MCPJam-Forwarding-Context" = "old"');
  });
  it("preserves exact route headers and keeps approval at the shared gate", () => {
    const first = {
      type: "http" as const,
      url: "https://proxy.example/a?native=1",
      headers: {
        "X-MCPJam-Forwarding-Context": "sealed-a",
        Connection: "close",
      },
      timeout: 1234,
    };
    const second = {
      ...first,
      url: "https://proxy.example/b?native=1",
      headers: { "X-MCPJam-Forwarding-Context": "sealed-b" },
    };
    const result = codexNativeMcpServers({
      mcpServers: { a: first, b: second },
    });
    expect(result.a).toMatchObject({
      url: first.url,
      http_headers: first.headers,
      tool_timeout_sec: 2,
      default_tools_approval_mode: "approve",
    });
    expect(result.b.http_headers).toEqual(second.headers);
    expect(result.a.http_headers).not.toBe(first.headers);
    expect(result.b.url).toBe(second.url);
  });

  it("cannot shadow the existing host-tool relay", () => {
    expect(() =>
      codexNativeMcpServers({
        mcpServers: {
          [RELAY_MCP_SERVER_NAME]: {
            type: "http",
            url: "https://proxy.example",
          },
        },
      }),
    ).toThrow("host-tool relay");
  });

  it.each(["file:///tmp/server", "https://user:password@proxy.example"])(
    "refuses %s",
    (url) => {
      expect(() =>
        codexNativeMcpServers({ mcpServers: { a: { type: "http", url } } }),
      ).toThrow("HTTP endpoint");
    },
  );
});
