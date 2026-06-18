import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useXaaTestTarget } from "../useXaaTestTarget";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { XaaResourceApp } from "@/lib/xaa/types";

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

let remoteServers: Array<{ _id: string; name: string; projectId: string }> = [];
vi.mock("../useProjects", () => ({
  useProjectServers: () => ({
    servers: remoteServers,
    serversRecord: {},
    isLoading: false,
    hasServers: remoteServers.length > 0,
  }),
}));

const runSettings = {
  userId: "user-1",
  email: "u@example.com",
  negativeTestMode: "valid" as const,
};

function httpServer(overrides: Partial<ServerWithName> = {}): ServerWithName {
  return {
    name: "staging-mcp",
    config: { url: "https://staging.mcp.example.com" },
    useOAuth: true,
    hasClientSecret: false,
    oauthFlowProfile: {
      serverUrl: "https://staging.mcp.example.com",
      clientId: "staging-client",
      clientSecret: "",
      scopes: "read write",
      customHeaders: [],
    },
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    retryCount: 0,
    ...overrides,
  } as unknown as ServerWithName;
}

describe("useXaaTestTarget", () => {
  it("resolves a testable bar server with its primitive config", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({ xaaAuthzIssuer: "https://auth.example.com" }),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        projectId: "proj_1",
      }),
    );

    expect(result.current.targetSource).toBe("bar_server");
    expect(result.current.isTestable).toBe(true);
    expect(result.current.targetKey).toBe("bar_server:staging-mcp");
    expect(result.current.runInput).toMatchObject({
      mode: "local-profile",
      serverUrl: "https://staging.mcp.example.com",
      clientId: "staging-client",
      scope: "read write",
      authzServerIssuer: "https://auth.example.com",
      clientSecret: "",
    });
    expect(result.current.usesServerSideSecret).toBe(false);
  });

  it("flags usesServerSideSecret for a confidential server with a resolved id", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({ hasClientSecret: true }),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        projectId: "proj_1",
      }),
    );

    expect(result.current.usesServerSideSecret).toBe(true);
    expect(result.current.serverId).toBe("srv_1");
    expect(result.current.projectId).toBe("proj_1");
    expect(result.current.secretUnavailable).toBe(false);
    // The secret is never in the browser-facing run input.
    expect(result.current.runInput.clientSecret).toBe("");
  });

  it("marks the secret unavailable for a confidential server whose id can't resolve", () => {
    // The server has a stored secret, but it isn't in the project's Convex
    // server list — so its id (and vault secret) can't be resolved.
    remoteServers = [];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({ hasClientSecret: true }),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        projectId: "proj_1",
      }),
    );

    // Still confidential — must NOT degrade to a public run with an empty
    // secret — but the secret can't be sent, so the run is blocked.
    expect(result.current.usesServerSideSecret).toBe(true);
    expect(result.current.serverId).toBeUndefined();
    expect(result.current.secretUnavailable).toBe(true);
    expect(result.current.runInput.clientSecret).toBe("");
  });

  it("prefers a selected registration over the bar server", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const registration: XaaResourceApp = {
      id: "app_1",
      name: "AcmeApp",
      resourceType: "mcp",
      resourceUrl: "https://acme.example.com/mcp",
      authServerMode: "own",
      issuer: "https://acme-as.example.com",
      targetClientId: "acme-client",
      scopes: ["read"],
      hasSecret: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer(),
        selectedServerName: "staging-mcp",
        selectedRegistration: registration,
        runSettings,
        projectId: "proj_1",
      }),
    );

    expect(result.current.targetSource).toBe("registration");
    expect(result.current.targetKey).toBe("registration:app_1");
    expect(result.current.runInput.registrationId).toBe("app_1");
    expect(result.current.usesServerSideSecret).toBe(false);
  });

  it("marks a STDIO server not testable", () => {
    remoteServers = [];
    const stdio = {
      name: "local-stdio",
      config: { command: "node", args: ["server.js"] },
      useOAuth: false,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    } as unknown as ServerWithName;

    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: stdio,
        selectedServerName: "local-stdio",
        selectedRegistration: null,
        runSettings,
        projectId: "proj_1",
      }),
    );

    expect(result.current.isTestable).toBe(false);
    expect(result.current.notTestableReason).toMatch(/HTTP URL and OAuth/);
  });

  it("marks an HTTP server without OAuth not testable", () => {
    remoteServers = [];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({ useOAuth: false }),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        projectId: "proj_1",
      }),
    );
    expect(result.current.isTestable).toBe(false);
  });

  it("returns the none source when nothing is selected", () => {
    remoteServers = [];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: undefined,
        selectedServerName: "none",
        selectedRegistration: null,
        runSettings,
        projectId: "proj_1",
      }),
    );
    expect(result.current.targetSource).toBe("none");
    expect(result.current.isTestable).toBe(false);
  });
});
