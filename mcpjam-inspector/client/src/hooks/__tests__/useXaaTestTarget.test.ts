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
        selectedPerson: null,
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
        selectedPerson: null,
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
        selectedPerson: null,
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
        selectedPerson: null,
        projectId: "proj_1",
      }),
    );

    expect(result.current.targetSource).toBe("registration");
    expect(result.current.targetKey).toBe("registration:app_1");
    expect(result.current.runInput.registrationId).toBe("app_1");
    expect(result.current.usesServerSideSecret).toBe(false);
    expect(result.current.serverId).toBeUndefined();
    expect(result.current.barServerId).toBe("srv_1");
    expect(result.current.barServerProjectId).toBe("proj_1");
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
        selectedPerson: null,
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
        selectedPerson: null,
        projectId: "proj_1",
      }),
    );
    expect(result.current.isTestable).toBe(false);
  });

  it("uses the per-server xaaSubject/xaaEmail override with no person selected", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({
          xaaSubject: "server-sub",
          xaaEmail: "server@example.com",
        } as Partial<ServerWithName>),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
      }),
    );
    expect(result.current.runInput.userId).toBe("server-sub");
    expect(result.current.runInput.email).toBe("server@example.com");
  });

  it("a selected person beats the server override ATOMICALLY (both fields)", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({
          xaaSubject: "server-sub",
          xaaEmail: "server@example.com",
        } as Partial<ServerWithName>),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: {
          _id: "person_1",
          subject: "bob-001",
          email: "bob@tables.test",
        },
        projectId: "proj_1",
      }),
    );
    // Both fields come from the person — the server's email must NOT be
    // borrowed alongside the person's subject (identities are atomic).
    expect(result.current.runInput.userId).toBe("bob-001");
    expect(result.current.runInput.email).toBe("bob@tables.test");
    // The person changes the identity, never the target.
    expect(result.current.targetKey).toBe("bar_server:staging-mcp");
  });

  it("applies the selected person to a registration run too", () => {
    remoteServers = [];
    const registration: XaaResourceApp = {
      id: "app_1",
      name: "AcmeApp",
      resourceType: "mcp",
      resourceUrl: "https://acme.example.com/mcp",
      authServerMode: "own",
      issuer: "https://acme-as.example.com",
      targetClientId: "acme-client",
      scopes: ["read"],
      hasSecret: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: undefined,
        selectedServerName: "none",
        selectedRegistration: registration,
        runSettings,
        selectedPerson: {
          _id: "person_1",
          subject: "amara-002",
          email: "amara@tables.test",
        },
        projectId: "proj_1",
      }),
    );
    expect(result.current.runInput.userId).toBe("amara-002");
    expect(result.current.runInput.email).toBe("amara@tables.test");
    expect(result.current.targetKey).toBe("registration:app_1");
  });

  it("returns the none source when nothing is selected", () => {
    remoteServers = [];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: undefined,
        selectedServerName: "none",
        selectedRegistration: null,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
      }),
    );
    expect(result.current.targetSource).toBe("none");
    expect(result.current.isTestable).toBe(false);
  });

  // ── Project default precedence ────────────────────────────────────────

  const projectDefault = { subject: "proj-sub-1", email: "proj@example.com" };

  it("uses the project default when the server has no override", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer(),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
        projectDefault,
      }),
    );
    expect(result.current.runInput.userId).toBe("proj-sub-1");
    expect(result.current.runInput.email).toBe("proj@example.com");
    expect(result.current.identityError).toBeUndefined();
  });

  it("a complete server override beats the project default", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({
          xaaSubject: "server-sub",
          xaaEmail: "server@example.com",
        } as Partial<ServerWithName>),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
        projectDefault,
      }),
    );
    expect(result.current.runInput.userId).toBe("server-sub");
    expect(result.current.runInput.email).toBe("server@example.com");
  });

  it("a selected person beats server override AND project default (highest precedence)", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({
          xaaSubject: "server-sub",
          xaaEmail: "server@example.com",
        } as Partial<ServerWithName>),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: {
          _id: "person_1",
          subject: "bob-001",
          email: "bob@tables.test",
        },
        projectId: "proj_1",
        projectDefault,
      }),
    );
    expect(result.current.runInput.userId).toBe("bob-001");
    expect(result.current.runInput.email).toBe("bob@tables.test");
  });

  it("a stale/deleted person (resolved to null by the caller) falls through to the project default", () => {
    // The owning page resolves a stale selectedPersonId against the roster
    // to null before calling the hook — so the fallthrough contract is:
    // null person + no override → project default, atomically.
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer(),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
        projectDefault,
      }),
    );
    expect(result.current.runInput.userId).toBe("proj-sub-1");
    expect(result.current.runInput.email).toBe("proj@example.com");
  });

  it("a registration target resolves person > project default > run fallback (no server override)", () => {
    remoteServers = [];
    const registration: XaaResourceApp = {
      id: "app_1",
      name: "AcmeApp",
      resourceType: "mcp",
      resourceUrl: "https://acme.example.com/mcp",
      authServerMode: "own",
      issuer: "https://acme-as.example.com",
      targetClientId: "acme-client",
      scopes: ["read"],
      hasSecret: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: undefined,
        selectedServerName: "none",
        selectedRegistration: registration,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
        projectDefault,
      }),
    );
    expect(result.current.runInput.userId).toBe("proj-sub-1");
    expect(result.current.runInput.email).toBe("proj@example.com");
    expect(result.current.identityError).toBeUndefined();
  });

  it("falls back to run settings when there is no person, override, or project default", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer(),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
        projectDefault: null,
      }),
    );
    expect(result.current.runInput.userId).toBe("user-1");
    expect(result.current.runInput.email).toBe("u@example.com");
  });

  it("a partial legacy server override sets identityError and never mixes sources", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({
          xaaSubject: "server-sub",
          // Legacy row: email member missing.
        } as Partial<ServerWithName>),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: null,
        projectId: "proj_1",
        projectDefault,
      }),
    );
    expect(result.current.identityError).toBe(
      "Complete or clear the server identity override",
    );
    // Run input stays coherent (fallback pair) but the consumer must block
    // the run — never server-sub with the project default's email.
    expect(result.current.runInput.userId).toBe("user-1");
    expect(result.current.runInput.email).toBe("u@example.com");
  });

  it("a selected person clears the partial-override block (person wins atomically)", () => {
    remoteServers = [
      { _id: "srv_1", name: "staging-mcp", projectId: "proj_1" },
    ];
    const { result } = renderHook(() =>
      useXaaTestTarget({
        server: httpServer({
          xaaSubject: "server-sub",
        } as Partial<ServerWithName>),
        selectedServerName: "staging-mcp",
        selectedRegistration: null,
        runSettings,
        selectedPerson: {
          _id: "person_1",
          subject: "bob-001",
          email: "bob@tables.test",
        },
        projectId: "proj_1",
        projectDefault: null,
      }),
    );
    expect(result.current.identityError).toBeUndefined();
    expect(result.current.runInput.userId).toBe("bob-001");
    expect(result.current.runInput.email).toBe("bob@tables.test");
  });
});
