/**
 * The organization registry's client half.
 *
 * ONE THING here is load-bearing and everything else follows from it: the
 * status join is PROVENANCE FIRST. The curated hook matches a card to a
 * running server by display name, which is safe there because only its own
 * connect mutation ever mints those names. It is NOT safe for org entries,
 * because PROMOTE creates an entry from a server that already exists — so the
 * entry and that server share a display name in the project it came from.
 *
 * A name join would then show the card as connected in a project that never
 * installed it, and the Disconnect it offers would delete the user's original
 * server. These tests pin both halves: the join reads the provenance row's
 * `serverName`, and disconnect does nothing without a provenance row.
 */
import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queries, mutations } = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutations: { calls: [] as Array<{ name: string; args: unknown }> },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) =>
    args === "skip" ? undefined : queries[name],
  useMutation: (name: string) => async (args: unknown) => {
    mutations.calls.push({ name, args });
  },
}));

import { useOrgRegistryServers } from "../useOrgRegistryServers";

const ORG_ROW = {
  _id: "reg_1",
  name: "org/org_1/internal-docs",
  displayName: "Internal Docs",
  scope: "organization" as const,
  status: "approved" as const,
  transport: { transportType: "http" as const, url: "https://a.example/mcp" },
  createdBy: "user_1",
  createdAt: 1,
  updatedAt: 1,
  derived: {
    probedAt: 1,
    endpointUrl: "https://a.example/mcp",
    serverVersion: "1.4.2",
    authRequired: true,
    supportsDcr: true,
  },
  editedFields: [],
};

function render(
  overrides: {
    connections?: unknown[];
    liveServers?: Record<string, { connectionStatus: string }>;
    onConnect?: (formData: unknown) => void;
    onDisconnect?: (name: string) => void;
  } = {}
) {
  queries["registryServers:listOrgRegistryServers"] = [ORG_ROW];
  queries["registryServers:getOrgRegistryContext"] = {
    organizationId: "org_1",
    canAdd: true,
  };
  queries["registryServers:getProjectRegistryConnections"] =
    overrides.connections ?? [];

  return renderHook(() =>
    useOrgRegistryServers({
      projectId: "proj_1",
      isAuthenticated: true,
      liveServers: overrides.liveServers,
      onConnect: overrides.onConnect ?? (() => {}),
      onDisconnect: overrides.onDisconnect,
    })
  );
}

beforeEach(() => {
  mutations.calls = [];
  for (const key of Object.keys(queries)) delete queries[key];
});

describe("useOrgRegistryServers — status join", () => {
  it("is not connected without a provenance row, even when a server shares its name", () => {
    // Exactly the promote case seen from ANOTHER project: the same display
    // name is up and running, and this project installed nothing.
    const { result } = render({
      connections: [],
      liveServers: { "Internal Docs": { connectionStatus: "connected" } },
    });

    expect(result.current.servers[0].connectionStatus).toBe("not_connected");
    expect(result.current.servers[0].connectedServerName).toBeNull();
  });

  it("reads the live server through the provenance row's own server name", () => {
    // The provenance points at a server whose name is NOT the display name —
    // a rename, or a promoted entry retitled after the fact.
    const { result } = render({
      connections: [
        {
          _id: "conn_1",
          registryServerId: "reg_1",
          serverId: "srv_1",
          serverName: "Docs (renamed)",
        },
      ],
      liveServers: {
        "Docs (renamed)": { connectionStatus: "connected" },
        "Internal Docs": { connectionStatus: "disconnected" },
      },
    });

    expect(result.current.servers[0].connectionStatus).toBe("connected");
    expect(result.current.servers[0].connectedServerName).toBe(
      "Docs (renamed)"
    );
  });

  it("reads 'added' when provenance exists but the server is not up", () => {
    const { result } = render({
      connections: [
        {
          _id: "conn_1",
          registryServerId: "reg_1",
          serverId: "srv_1",
          serverName: "Internal Docs",
        },
      ],
      liveServers: {},
    });

    expect(result.current.servers[0].connectionStatus).toBe("added");
  });

  it("stays loading until provenance resolves, rather than guessing", () => {
    queries["registryServers:listOrgRegistryServers"] = [ORG_ROW];
    queries["registryServers:getOrgRegistryContext"] = {
      organizationId: "org_1",
      canAdd: true,
    };
    // The two queries land independently. Rows first, provenance still in
    // flight: an empty map here would read as "nothing is installed", so every
    // installed card would flash "Connect" and a click in that window would
    // try to install it twice.
    queries["registryServers:getProjectRegistryConnections"] = undefined;

    const { result } = renderHook(() =>
      useOrgRegistryServers({
        projectId: "proj_1",
        isAuthenticated: true,
        onConnect: () => {},
      })
    );

    expect(result.current.servers).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });
});

describe("useOrgRegistryServers — connect and disconnect", () => {
  it("writes the connection BEFORE handing off to the app's connect", async () => {
    const order: string[] = [];
    const { result } = render({
      onConnect: () => order.push("onConnect"),
    });
    mutations.calls = [];

    await act(async () => {
      await result.current.connect(result.current.servers[0]);
    });

    // Mutation first: it creates the `servers` row and the provenance record
    // before anything can redirect the browser into OAuth.
    expect(mutations.calls[0].name).toBe(
      "registryServers:connectRegistryServer"
    );
    expect(order).toEqual(["onConnect"]);
  });

  it("connects with auto discovery rather than trusting the stored posture", async () => {
    const connectArgs: Array<Record<string, unknown>> = [];
    const { result } = render({
      onConnect: (formData) =>
        connectArgs.push(formData as Record<string, unknown>),
    });

    await act(async () => {
      await result.current.connect(result.current.servers[0]);
    });

    expect(connectArgs[0]).toMatchObject({
      authMethod: "auto",
      useOAuth: true,
      url: "https://a.example/mcp",
      registryServerId: "reg_1",
    });
  });

  it("does nothing on disconnect without a provenance row", async () => {
    const onDisconnect = vi.fn();
    const { result } = render({
      connections: [],
      liveServers: { "Internal Docs": { connectionStatus: "connected" } },
      onDisconnect,
    });
    mutations.calls = [];

    await act(async () => {
      await result.current.disconnect(result.current.servers[0]);
    });

    // The server sharing this name belongs to whoever created it. Tearing it
    // down from here is the bug this hook exists to prevent.
    expect(mutations.calls).toEqual([]);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("disconnects the server its provenance names", async () => {
    const onDisconnect = vi.fn();
    const { result } = render({
      connections: [
        {
          _id: "conn_1",
          registryServerId: "reg_1",
          serverId: "srv_1",
          serverName: "Internal Docs",
        },
      ],
      onDisconnect,
    });
    mutations.calls = [];

    await act(async () => {
      await result.current.disconnect(result.current.servers[0]);
    });

    expect(mutations.calls[0].name).toBe(
      "registryServers:disconnectRegistryServer"
    );
    expect(onDisconnect).toHaveBeenCalledWith("Internal Docs");
  });

  it("preserves the promoted source server on disconnect", async () => {
    const onDisconnect = vi.fn();
    const { result } = render({
      connections: [
        {
          _id: "conn_1",
          registryServerId: "reg_1",
          serverId: "srv_1",
          serverName: "Internal Docs",
          connectionKind: "promoted_source",
        },
      ],
      onDisconnect,
    });
    mutations.calls = [];

    await act(async () => {
      await result.current.disconnect(result.current.servers[0]);
    });

    expect(mutations.calls[0].name).toBe(
      "registryServers:disconnectRegistryServer"
    );
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});

describe("useOrgRegistryServers — adding", () => {
  it("sends the organization resolved from the project, never one from the caller", async () => {
    const { result } = render();
    mutations.calls = [];

    await act(async () => {
      await result.current.add({
        displayName: "Docs",
        url: "https://b.example/mcp",
        useOAuth: true,
        derived: { probedAt: 2, endpointUrl: "https://b.example/mcp" },
      });
    });

    expect(mutations.calls[0]).toMatchObject({
      name: "registryServers:addOrgRegistryServer",
      args: { organizationId: "org_1", displayName: "Docs" },
    });
  });

  it("refuses to add for a project with no organization", async () => {
    render();
    queries["registryServers:getOrgRegistryContext"] = {
      organizationId: null,
      canAdd: false,
    };
    const { result } = renderHook(() =>
      useOrgRegistryServers({
        projectId: "proj_1",
        isAuthenticated: true,
        onConnect: () => {},
      })
    );

    await expect(
      result.current.add({
        displayName: "Docs",
        url: "https://b.example/mcp",
        derived: { probedAt: 2, endpointUrl: "https://b.example/mcp" },
      })
    ).rejects.toThrow(/not part of an organization/);
  });
});
