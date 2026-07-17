import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  hasDebuggerHeaderServers,
  isOAuthDebuggerHeaderServer,
  isXaaDebuggerHeaderServer,
} from "../debugger-header-servers";

const hasOAuthConfig = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/oauth/mcp-oauth", () => ({ hasOAuthConfig }));

const server = (overrides: Partial<ServerWithName> = {}): ServerWithName =>
  ({
    name: "server",
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    lastConnectionTime: new Date(0),
    config: { url: "https://example.com/mcp" },
    ...overrides,
  } as ServerWithName);

describe("debugger header server filters", () => {
  beforeEach(() => hasOAuthConfig.mockReset().mockReturnValue(false));

  it("matches the OAuth header's supported server states", () => {
    expect(isOAuthDebuggerHeaderServer(server({ useOAuth: true }))).toBe(true);
    expect(
      isOAuthDebuggerHeaderServer(server({ connectionStatus: "oauth-flow" }))
    ).toBe(true);
    // useOAuth: false with no OAuth history is a never-touched server, not
    // an opt-out — it must be shown so it can be configured (#1109).
    expect(isOAuthDebuggerHeaderServer(server({ useOAuth: false }))).toBe(
      true
    );
  });

  it("hides useOAuth: false only when there is real OAuth history to opt out of", () => {
    const optedOutWithHistory = server({
      useOAuth: false,
      oauthTokens: {
        client_id: "client-id",
        client_secret: "client-secret",
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "read",
      },
    });
    expect(isOAuthDebuggerHeaderServer(optedOutWithHistory)).toBe(false);

    const neverTouched = server({});
    expect(isOAuthDebuggerHeaderServer(neverTouched)).toBe(true);
  });

  it("never admits a stdio server, even with useOAuth: true", () => {
    const stdioServer = server({
      useOAuth: true,
      config: {
        command: "node",
        args: ["server.js"],
      },
    });
    expect(isOAuthDebuggerHeaderServer(stdioServer)).toBe(false);
  });

  it("admits XAA-only servers only for the XAA header", () => {
    const xaaServer = server({ useOAuth: false, useXaa: true });
    expect(isOAuthDebuggerHeaderServer(xaaServer)).toBe(false);
    expect(isXaaDebuggerHeaderServer(xaaServer)).toBe(true);
    expect(
      hasDebuggerHeaderServers({ serverConfigs: { xaa: xaaServer } })
    ).toBe(false);
    expect(
      hasDebuggerHeaderServers({
        serverConfigs: { xaa: xaaServer },
        includeXaaServers: true,
      })
    ).toBe(true);
  });

  it("does not count servers hidden from the debugger header", () => {
    expect(
      hasDebuggerHeaderServers({
        serverConfigs: { oauth: server({ useOAuth: true }) },
        hiddenServers: new Set(["oauth"]),
      })
    ).toBe(false);
  });
});
