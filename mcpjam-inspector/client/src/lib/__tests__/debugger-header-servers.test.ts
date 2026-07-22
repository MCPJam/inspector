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
    expect(isOAuthDebuggerHeaderServer(server({ useOAuth: false }))).toBe(
      false
    );
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

  it("excludes XAA-configured servers from the OAuth header even when useOAuth is also set", () => {
    // useOAuth and useXaa are mutually exclusive by construction elsewhere in
    // the app, but the header filter shouldn't rely on that invariant — an
    // explicit guard keeps the OAuth header XAA-free regardless.
    const xaaServer = server({ useOAuth: true, useXaa: true });
    expect(isOAuthDebuggerHeaderServer(xaaServer)).toBe(false);
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
