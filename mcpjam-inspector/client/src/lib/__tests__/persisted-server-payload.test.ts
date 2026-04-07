import { describe, expect, it } from "vitest";
import {
  buildCarryForwardServerPayload,
  buildPersistedPayloadFromCarryForwardComparableServer,
  buildPersistedPayloadFromRemoteServer,
  buildPersistedServerPayload,
  isCarryForwardRemoteServerEquivalent,
  persistedServerPayloadsEqual,
} from "../persisted-server-payload";

describe("persisted-server-payload", () => {
  it("strips Authorization while preserving non-secret headers", () => {
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

  it("treats matching sanitized local and remote servers as equivalent", () => {
    const localPayload = buildPersistedServerPayload("linear", {
      config: {
        url: "https://mcp.linear.app/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer secret",
            "X-Custom": "1",
          },
        },
      } as any,
      enabled: true,
      useOAuth: true,
      oauthFlowProfile: {
        scopes: "read,write",
        clientId: "linear-client",
      } as any,
    });
    const remotePayload = buildPersistedPayloadFromRemoteServer({
      name: "linear",
      enabled: true,
      transportType: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {
        "X-Custom": "1",
      },
      timeout: undefined,
      useOAuth: true,
      oauthScopes: ["read", "write"],
      clientId: "linear-client",
    });

    expect(persistedServerPayloadsEqual(localPayload, remotePayload)).toBe(
      true,
    );
    expect(
      isCarryForwardRemoteServerEquivalent(
        {
          config: {
            url: "https://mcp.linear.app/mcp",
            requestInit: {
              headers: {
                Authorization: "Bearer secret",
                "X-Custom": "1",
              },
            },
          } as any,
          enabled: true,
          useOAuth: true,
          oauthFlowProfile: {
            scopes: "read,write",
            clientId: "linear-client",
          } as any,
        },
        {
          name: "linear",
          enabled: true,
          transportType: "http",
          url: "https://mcp.linear.app/mcp",
          headers: {
            "X-Custom": "1",
          },
          timeout: undefined,
          useOAuth: true,
          oauthScopes: ["read", "write"],
          clientId: "linear-client",
        } as any,
      ),
    ).toBe(true);
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

  it("header-only differences are equivalent in carry-forward", () => {
    const result = isCarryForwardRemoteServerEquivalent(
      {
        config: {
          url: "https://mcp.linear.app/mcp",
          requestInit: {
            headers: {
              Authorization: "Bearer secret",
              "X-Custom": "1",
            },
          },
        } as any,
        enabled: true,
        useOAuth: true,
        oauthFlowProfile: {
          scopes: "read,write",
          clientId: "linear-client",
        } as any,
      },
      {
        name: "linear",
        enabled: true,
        transportType: "http",
        url: "https://mcp.linear.app/mcp",
        headers: undefined,
        timeout: undefined,
        useOAuth: true,
        oauthScopes: ["read", "write"],
        clientId: "linear-client",
      } as any,
    );

    expect(result).toBe(true);
  });

  it("normalizes comparable workspace snapshot servers for carry-forward checks", () => {
    const payload = buildPersistedPayloadFromCarryForwardComparableServer({
      name: "linear",
      enabled: true,
      transportType: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {
        Authorization: "Bearer secret",
        "X-Custom": "1",
      },
      timeout: 30_000,
      useOAuth: true,
      oauthScopes: "read,write",
      clientId: "linear-client",
    });

    expect(payload).toEqual({
      name: "linear",
      enabled: true,
      transportType: "http",
      command: undefined,
      args: undefined,
      url: "https://mcp.linear.app/mcp",
      headers: {
        "X-Custom": "1",
      },
      timeout: 30_000,
      useOAuth: true,
      oauthScopes: ["read", "write"],
      clientId: "linear-client",
    });
  });

  it("same URL but different OAuth config is not equivalent in carry-forward", () => {
    const result = isCarryForwardRemoteServerEquivalent(
      {
        config: { url: "https://mcp.linear.app/mcp" } as any,
        enabled: true,
        useOAuth: true,
        oauthFlowProfile: {
          scopes: "read,write",
          clientId: "linear-client",
        } as any,
      },
      {
        name: "linear",
        enabled: true,
        transportType: "http",
        url: "https://mcp.linear.app/mcp",
        headers: undefined,
        timeout: undefined,
        useOAuth: false,
        oauthScopes: undefined,
        clientId: undefined,
      } as any,
    );

    expect(result).toBe(false);
  });
});
