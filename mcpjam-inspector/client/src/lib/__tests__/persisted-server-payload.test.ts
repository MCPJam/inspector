import { describe, expect, it } from "vitest";
import {
  buildCarryForwardServerPayload,
  buildPersistedServerPayload,
} from "../persisted-server-payload";

describe("persisted-server-payload", () => {
  it("preserves Authorization and custom headers for normal persistence", () => {
    const payload = buildPersistedServerPayload("linear", {
      config: {
        url: "https://mcp.linear.app/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer secret",
            "X-Custom": "1",
          },
        },
        timeout: 30_000,
      } as any,
      enabled: true,
      useOAuth: true,
      oauthFlowProfile: {
        scopes: "read,write",
        clientId: "linear-client",
      } as any,
    });

    expect(payload).toEqual({
      name: "linear",
      enabled: true,
      transportType: "http",
      command: undefined,
      args: undefined,
      url: "https://mcp.linear.app/mcp",
      headers: {
        Authorization: "Bearer secret",
        "X-Custom": "1",
      },
      timeout: 30_000,
      useOAuth: true,
      oauthScopes: ["read", "write"],
      clientId: "linear-client",
    });
  });

  it("excludes runtime-only state from the persisted payload", () => {
    const payload = buildPersistedServerPayload("demo", {
      config: { url: "https://example.com/mcp" } as any,
      enabled: false,
      useOAuth: false,
      oauthFlowProfile: undefined,
    });

    expect(payload).not.toHaveProperty("oauthTokens");
    expect(payload).toEqual({
      name: "demo",
      enabled: false,
      transportType: "http",
      command: undefined,
      args: undefined,
      url: "https://example.com/mcp",
      headers: undefined,
      timeout: undefined,
      useOAuth: false,
      oauthScopes: undefined,
      clientId: undefined,
    });
  });

  it("carry-forward payload omits all headers including sensitive ones", () => {
    const payload = buildCarryForwardServerPayload("linear", {
      config: {
        url: "https://mcp.linear.app/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer secret",
            "X-API-Key": "key-123",
            Cookie: "session=abc",
            "X-Custom": "1",
          },
        },
        timeout: 30_000,
      } as any,
      enabled: true,
      useOAuth: true,
      oauthFlowProfile: {
        scopes: "read,write",
        clientId: "linear-client",
      } as any,
    });

    expect(payload.headers).toBeUndefined();
    expect(payload.useOAuth).toBe(true);
    expect(payload.oauthScopes).toEqual(["read", "write"]);
    expect(payload.clientId).toBe("linear-client");
  });
});
