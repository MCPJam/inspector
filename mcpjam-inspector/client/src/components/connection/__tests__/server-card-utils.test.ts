import { describe, it, expect } from "vitest";
import {
  formatConnectionStatusLabel,
  getConnectionStatusMeta,
  getServerCommandDisplay,
  getServerTransportLabel,
  getServerUrl,
} from "../server-card-utils.js";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
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
    expect(meta.label).toBe("Finishing setup...");
    expect(meta.indicatorColor).toBe("#3b82f6");
    expect(meta.iconClassName).toContain("animate-spin");
  });

  it("returns oauth-flow status meta", () => {
    const meta = getConnectionStatusMeta("oauth-flow");
    expect(meta.label).toBe("Authorizing in browser...");
    expect(meta.indicatorColor).toBe("#a855f7");
    expect(meta.iconClassName).toContain("text-purple-500");
  });

  it("returns failed status meta", () => {
    const meta = getConnectionStatusMeta("failed");
    expect(meta.label).toBe("Failed");
    expect(meta.indicatorColor).toBe("#ef4444");
    expect(meta.iconClassName).toContain("text-red-500");
  });

  it("returns needs-auth status meta in amber, not red", () => {
    const meta = getConnectionStatusMeta("needs-auth");
    expect(meta.label).toBe("Sign in");
    // Amber (#f59e0b), deliberately NOT the failure red (#ef4444): this
    // server is working, it just has nobody signed in.
    expect(meta.indicatorColor).toBe("#f59e0b");
    expect(meta.indicatorColor).not.toBe("#ef4444");
    expect(meta.iconClassName).toContain("text-amber-500");
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
      url: "http://localhost:3000/mcp",
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
    const config = {} as MCPServerConfig;
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

describe("getServerUrl", () => {
  it("returns URL string for HTTP config", () => {
    const config: MCPServerConfig = {
      url: "http://localhost:3000/mcp",
    };
    expect(getServerUrl(config)).toBe("http://localhost:3000/mcp");
  });

  it("returns joined command for stdio config", () => {
    const config: MCPServerConfig = {
      command: "node",
      args: ["server.js"],
    };
    expect(getServerUrl(config)).toBe("node server.js");
  });

  it("returns undefined for empty config", () => {
    expect(getServerUrl({} as MCPServerConfig)).toBeUndefined();
  });
});

describe("getServerTransportLabel", () => {
  it('returns "HTTP/SSE" for URL config', () => {
    const config: MCPServerConfig = {
      url: "http://localhost:3000",
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
    const config = {} as MCPServerConfig;
    expect(getServerTransportLabel(config)).toBe("STDIO");
  });
});

describe("formatConnectionStatusLabel", () => {
  it("appends the retry count to a failure that was retried", () => {
    expect(formatConnectionStatusLabel("failed", 3)).toBe("Failed (3)");
  });

  it("omits the suffix when nothing was retried", () => {
    // The old unconditional suffix always rendered "(0)", because nothing
    // incremented the counter. A failure with no retries behind it — a
    // protocol pin the server does not offer, say — must show no number
    // rather than a zero dressed up as a diagnostic.
    expect(formatConnectionStatusLabel("failed", 0)).toBe("Failed");
  });

  it("omits the suffix when the count is absent", () => {
    expect(formatConnectionStatusLabel("failed", undefined)).toBe("Failed");
  });

  it("never adds a count to a non-failed status", () => {
    // `retryCount` is only cleared on CONNECT_SUCCESS, so a server that
    // recovered on its third attempt still carries a 3 while connected.
    // "Connected (3)" would read as a warning about a server that is fine.
    expect(formatConnectionStatusLabel("connected", 3)).toBe("Connected");
    expect(formatConnectionStatusLabel("needs-auth", 3)).toBe(
      getConnectionStatusMeta("needs-auth").label
    );
  });

  it("agrees with the raw status label for every status when un-retried", () => {
    // Pins the card, the detail modal and the eval picker to one source:
    // whatever this returns is what all three render.
    const statuses: ConnectionStatus[] = [
      "connected",
      "connecting",
      "oauth-flow",
      "needs-auth",
      "failed",
      "disconnected",
    ];
    for (const status of statuses) {
      expect(formatConnectionStatusLabel(status, 0)).toBe(
        getConnectionStatusMeta(status).label
      );
    }
  });
});
