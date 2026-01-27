import { describe, it, expect } from "vitest";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
  getServerTransportLabel,
} from "../server-card-utils.js";
import type { MCPServerConfig } from "@mcpjam/sdk";
import type { ConnectionStatus } from "@/state/app-types";

describe("getConnectionStatusMeta", () => {
  it("returns connected status meta", () => {
    const meta = getConnectionStatusMeta("connected");
    expect(meta.label).toBe("Connected");
    expect(meta.indicatorColor).toBe("#10b981");
    expect(meta.iconClassName).toContain("text-green-500");
  });

  it("returns connecting status meta with spinner", () => {
    const meta = getConnectionStatusMeta("connecting");
    expect(meta.label).toBe("Connecting...");
    expect(meta.indicatorColor).toBe("#3b82f6");
    expect(meta.iconClassName).toContain("animate-spin");
  });

  it("returns oauth-flow status meta", () => {
    const meta = getConnectionStatusMeta("oauth-flow");
    expect(meta.label).toBe("Authorizing...");
    expect(meta.indicatorColor).toBe("#a855f7");
    expect(meta.iconClassName).toContain("text-purple-500");
  });

  it("returns failed status meta", () => {
    const meta = getConnectionStatusMeta("failed");
    expect(meta.label).toBe("Failed");
    expect(meta.indicatorColor).toBe("#ef4444");
    expect(meta.iconClassName).toContain("text-red-500");
  });

  it("returns disconnected status meta", () => {
    const meta = getConnectionStatusMeta("disconnected");
    expect(meta.label).toBe("Disconnected");
    expect(meta.indicatorColor).toBe("#9ca3af");
    expect(meta.iconClassName).toContain("text-gray-500");
  });

  it("falls back to disconnected for unknown status", () => {
    // @ts-expect-error - testing runtime fallback
    const meta = getConnectionStatusMeta("unknown-status");
    expect(meta.label).toBe("Disconnected");
  });
});

describe("getServerCommandDisplay", () => {
  it("returns URL for HTTP/SSE config", () => {
    const config: MCPServerConfig = {
      url: new URL("http://localhost:3000/mcp"),
    };
    expect(getServerCommandDisplay(config)).toBe("http://localhost:3000/mcp");
  });

  it("returns command for STDIO config", () => {
    const config: MCPServerConfig = {
      command: "node",
      args: ["server.js"],
    };
    expect(getServerCommandDisplay(config)).toBe("node server.js");
  });

  it("returns command with multiple args", () => {
    const config: MCPServerConfig = {
      command: "python",
      args: ["-m", "mcp_server", "--port", "3000"],
    };
    expect(getServerCommandDisplay(config)).toBe(
      "python -m mcp_server --port 3000",
    );
  });

  it("handles command without args", () => {
    const config: MCPServerConfig = {
      command: "my-server",
    };
    expect(getServerCommandDisplay(config)).toBe("my-server");
  });

  it("handles empty config gracefully", () => {
    const config: MCPServerConfig = {};
    expect(getServerCommandDisplay(config)).toBe("");
  });

  it("handles config with empty args array", () => {
    const config: MCPServerConfig = {
      command: "server",
      args: [],
    };
    expect(getServerCommandDisplay(config)).toBe("server");
  });
});

describe("getServerTransportLabel", () => {
  it('returns "HTTP/SSE" for URL config', () => {
    const config: MCPServerConfig = {
      url: new URL("http://localhost:3000"),
    };
    expect(getServerTransportLabel(config)).toBe("HTTP/SSE");
  });

  it('returns "STDIO" for command config', () => {
    const config: MCPServerConfig = {
      command: "node",
      args: ["server.js"],
    };
    expect(getServerTransportLabel(config)).toBe("STDIO");
  });

  it('returns "STDIO" for empty config', () => {
    const config: MCPServerConfig = {};
    expect(getServerTransportLabel(config)).toBe("STDIO");
  });
});
