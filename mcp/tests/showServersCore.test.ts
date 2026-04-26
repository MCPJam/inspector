import { describe, expect, it, vi } from "vitest";
import {
  buildShowServersPayload,
  resolveWorkspace,
  type AuthorizeBatchInput,
  type AuthorizeBatchResult,
  type RemoteServer,
  type RemoteWorkspace,
} from "../src/tools/showServersCore.js";
import type { ProbeMcpServerConfig, ProbeMcpServerResult } from "@mcpjam/sdk/worker";

const WORKSPACES: RemoteWorkspace[] = [
  {
    _id: "workspace-old",
    organizationId: "org-a",
    name: "Old",
    updatedAt: 100,
  },
  {
    _id: "workspace-new",
    organizationId: "org-a",
    name: "New",
    updatedAt: 200,
  },
];

function probeResult(
  overrides: Partial<ProbeMcpServerResult> = {}
): ProbeMcpServerResult {
  return {
    url: "https://server.example.com/mcp",
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: {
      selected: "streamable-http",
      attempts: [],
    },
    initialize: {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "server", version: "1.0.0" },
    },
    oauth: {
      required: false,
      optional: false,
      registrationStrategies: [],
    },
    ...overrides,
  };
}

describe("resolveWorkspace", () => {
  it("selects the most recently updated workspace when omitted", () => {
    const result = resolveWorkspace(WORKSPACES);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace._id).toBe("workspace-new");
    }
  });

  it("selects an exact workspace ID before considering names", () => {
    const result = resolveWorkspace(
      [
        ...WORKSPACES,
        {
          _id: "New",
          organizationId: "org-b",
          name: "ID Wins",
          updatedAt: 50,
        },
      ],
      "New"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace._id).toBe("New");
      expect(result.workspace.name).toBe("ID Wins");
    }
  });

  it("selects a unique workspace name case-insensitively", () => {
    const result = resolveWorkspace(WORKSPACES, "new");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace._id).toBe("workspace-new");
    }
  });

  it("returns an actionable error for duplicate workspace names", () => {
    const result = resolveWorkspace(
      [
        ...WORKSPACES,
        {
          _id: "workspace-new-copy",
          organizationId: "org-b",
          name: "New",
          updatedAt: 150,
        },
      ],
      "new"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("ambiguous");
      expect(result.message).toContain("workspace-new");
      expect(result.message).toContain("workspace-new-copy");
    }
  });

  it("returns available workspaces for a missing selector", () => {
    const result = resolveWorkspace(WORKSPACES, "missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Available workspaces");
      expect(result.message).toContain("workspace-new");
      expect(result.message).toContain("workspace-old");
    }
  });
});

describe("buildShowServersPayload", () => {
  it("maps server skips, authorization failures, probe success, non-ready probes, and thrown probes", async () => {
    const servers: RemoteServer[] = [
      { _id: "stdio", name: "Stdio", transportType: "stdio" },
      {
        _id: "insecure",
        name: "Insecure",
        transportType: "http",
        url: "http://example.com/mcp",
      },
      {
        _id: "ready",
        name: "Ready",
        transportType: "http",
        url: "https://ready.example.com/mcp",
      },
      {
        _id: "non-ready",
        name: "Non Ready",
        transportType: "http",
        url: "https://non-ready.example.com/mcp",
      },
      {
        _id: "auth-fail",
        name: "Auth Fail",
        transportType: "http",
        url: "https://auth-fail.example.com/mcp",
      },
      {
        _id: "throws",
        name: "Throws",
        transportType: "http",
        url: "https://throws.example.com/mcp",
      },
    ];

    const authorizeBatch = vi.fn(
      async (_input: AuthorizeBatchInput): Promise<AuthorizeBatchResult> => ({
        ok: true,
        body: {
          results: {
            ready: {
              ok: true,
              oauthAccessToken: "ready-token",
              serverConfig: {
                transportType: "http",
                url: "https://ready.example.com/mcp",
                headers: { "X-Test": "ready" },
              },
            },
            "non-ready": {
              ok: true,
              serverConfig: {
                transportType: "http",
                url: "https://non-ready.example.com/mcp",
              },
            },
            "auth-fail": {
              ok: false,
              status: 403,
              code: "FORBIDDEN",
              message: "Denied",
            },
            throws: {
              ok: true,
              serverConfig: {
                transportType: "http",
                url: "https://throws.example.com/mcp",
              },
            },
          },
        },
      })
    );
    const probe = vi.fn(async (config: ProbeMcpServerConfig) => {
      if (config.url.includes("non-ready")) {
        return probeResult({
          url: config.url,
          status: "reachable",
          initialize: undefined,
          error: "Server responded without initialize result.",
        });
      }

      if (config.url.includes("ready")) {
        return probeResult({
          url: config.url,
          initialize: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "ready-server", version: "2.0.0" },
          },
        });
      }

      throw new Error("connect timeout");
    });

    const payload = await buildShowServersPayload({
      bearerToken: "token",
      convexHttpUrl: "https://convex.example.com",
      workspace: WORKSPACES[0]!,
      workspaces: WORKSPACES,
      servers,
      generatedAt: "2026-04-26T00:00:00.000Z",
      authorizeBatch,
      probe,
    });

    expect(authorizeBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        serverIds: ["ready", "non-ready", "auth-fail", "throws"],
      })
    );
    expect(payload.servers.map((server) => [server.id, server.status])).toEqual([
      ["stdio", "skipped"],
      ["insecure", "skipped"],
      ["ready", "reachable"],
      ["non-ready", "unreachable"],
      ["auth-fail", "error"],
      ["throws", "unreachable"],
    ]);
    expect(payload.servers[2]?.serverInfo).toEqual({
      name: "ready-server",
      version: "2.0.0",
    });
    expect(payload.servers[4]?.statusDetail).toContain("FORBIDDEN");
    expect(payload.servers[5]?.statusDetail).toContain("connect timeout");
    expect(payload.summary).toEqual({
      reachable: 1,
      unreachable: 2,
      skipped: 2,
      error: 1,
    });
  });

  it("marks supported HTTPS servers as errors when batch authorization fails", async () => {
    const payload = await buildShowServersPayload({
      bearerToken: "token",
      convexHttpUrl: "https://convex.example.com",
      workspace: WORKSPACES[0]!,
      workspaces: WORKSPACES,
      servers: [
        {
          _id: "server-a",
          name: "Server A",
          transportType: "http",
          url: "https://a.example.com/mcp",
        },
      ],
      generatedAt: "2026-04-26T00:00:00.000Z",
      authorizeBatch: async () => ({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Batch authorization unavailable.",
        },
      }),
    });

    expect(payload.servers[0]?.status).toBe("error");
    expect(payload.servers[0]?.statusDetail).toBe(
      "Batch authorization unavailable."
    );
  });
});
