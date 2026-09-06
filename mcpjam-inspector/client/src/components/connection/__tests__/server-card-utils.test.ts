import { describe, it, expect } from "vitest";
import {
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
    expect(meta.indicatorClassName).toBe("bg-success");
    expect(meta.iconClassName).toContain("text-success");
  });

  it("returns connecting status meta with spinner", () => {
    const meta = getConnectionStatusMeta("connecting");
    expect(meta.label).toBe("Finishing setup...");
    expect(meta.indicatorClassName).toBe("bg-info");
    expect(meta.iconClassName).toContain("animate-spin");
  });

  it("returns oauth-flow status meta", () => {
    const meta = getConnectionStatusMeta("oauth-flow");
    expect(meta.label).toBe("Authorizing in browser...");
    expect(meta.indicatorClassName).toBe("bg-pending");
    expect(meta.iconClassName).toContain("text-pending");
  });

  it("returns failed status meta", () => {
    const meta = getConnectionStatusMeta("failed");
    expect(meta.label).toBe("Failed");
    expect(meta.indicatorClassName).toBe("bg-destructive");
    expect(meta.iconClassName).toContain("text-destructive");
  });

  it("returns disconnected status meta", () => {
    const meta = getConnectionStatusMeta("disconnected");
    expect(meta.label).toBe("Disconnected");
    expect(meta.indicatorClassName).toBe("bg-muted-foreground");
    expect(meta.iconClassName).toContain("text-muted-foreground");
  });

  /**
   * The dot is painted in both themes, so its colour has to come from a role
   * token. This is the guard on that: a literal shade (`bg-green-500`) or a
   * hex passed through `style` reads the same in dark mode as in light, which
   * is the bug three separate copies of this vocabulary used to carry.
   */
  it("paints every status from a role token, never a fixed colour", () => {
    const statuses: ConnectionStatus[] = [
      "connected",
      "connecting",
      "oauth-flow",
      "failed",
      "disconnected",
    ];
    for (const status of statuses) {
      const { indicatorClassName, iconClassName } =
        getConnectionStatusMeta(status);
      expect(indicatorClassName).toMatch(/^bg-[a-z-]+$/);
      expect(indicatorClassName).not.toMatch(/#|\d/);
      // The ICON too. It kept `text-green-500` and friends after the dot beside
      // it moved to a token, so one status was painted from the theme and from
      // a fixed shade at once. Any `text-<name>-<number>` fails here.
      const colour = iconClassName
        .split(" ")
        .find((cls) => cls.startsWith("text-"));
      expect(colour, `${status} icon colour`).toBeDefined();
      expect(colour).toMatch(/^text-[a-z-]+$/);
    }
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
