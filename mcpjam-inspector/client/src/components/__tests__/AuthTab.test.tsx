import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import { AuthTab } from "../AuthTab";

const httpConfig = (overrides: Record<string, unknown> = {}): MCPServerConfig =>
  ({
    transportType: "streamableHttp",
    url: "https://example.com/mcp",
    ...overrides,
  } as unknown as MCPServerConfig);

const createServer = (
  overrides: Partial<ServerWithName> = {}
): ServerWithName => ({
  name: "test-server",
  config: httpConfig(),
  lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
  connectionStatus: "connected",
  retryCount: 0,
  enabled: true,
  useOAuth: false,
  ...overrides,
});

describe("AuthTab", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("shows bearer token authentication when redacted metadata is present", () => {
    const serverConfig = httpConfig({ hasBearerToken: true });

    render(
      <AuthTab
        serverConfig={serverConfig}
        serverEntry={createServer({ config: serverConfig })}
        serverName="test-server"
      />
    );

    expect(
      screen.getByText("Authentication: Bearer Token")
    ).toBeInTheDocument();
    expect(screen.getByText("Bearer Token Authentication")).toBeInTheDocument();
    expect(screen.queryByText("OAuth Authentication")).not.toBeInTheDocument();
  });

  it("shows bearer token authentication for a visible bearer header", () => {
    const serverConfig = httpConfig({
      requestInit: {
        headers: {
          authorization: "bearer visible-token",
        },
      },
    });

    render(
      <AuthTab
        serverConfig={serverConfig}
        serverEntry={createServer({ config: serverConfig })}
        serverName="test-server"
      />
    );

    expect(
      screen.getByText("Authentication: Bearer Token")
    ).toBeInTheDocument();
    expect(screen.getByText("Bearer Token Authentication")).toBeInTheDocument();
  });

  it("keeps OAuth selected ahead of bearer-looking Authorization headers", () => {
    const serverConfig = httpConfig({
      requestInit: {
        headers: {
          Authorization: "Bearer oauth-access-token",
        },
      },
    });

    render(
      <AuthTab
        serverConfig={serverConfig}
        serverEntry={createServer({
          config: serverConfig,
          useOAuth: true,
        })}
        serverName="test-server"
      />
    );

    expect(screen.getByText("Authentication: OAuth")).toBeInTheDocument();
    expect(screen.getByText("OAuth Authentication")).toBeInTheDocument();
    expect(
      screen.queryByText("Bearer Token Authentication")
    ).not.toBeInTheDocument();
  });

  it("lets explicit bearer auth win over stale local OAuth tokens", () => {
    localStorage.setItem(
      "mcp-tokens-test-server",
      JSON.stringify({
        access_token: "stale-oauth-token",
        refresh_token: "stale-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      })
    );

    const serverConfig = httpConfig({ hasBearerToken: true });

    render(
      <AuthTab
        serverConfig={serverConfig}
        serverEntry={createServer({
          config: serverConfig,
          useOAuth: undefined,
          hasBearerToken: true,
        })}
        serverName="test-server"
      />
    );

    expect(
      screen.getByText("Authentication: Bearer Token")
    ).toBeInTheDocument();
    expect(screen.getByText("Bearer Token Authentication")).toBeInTheDocument();
    expect(screen.queryByText("OAuth Authentication")).not.toBeInTheDocument();
  });
});
