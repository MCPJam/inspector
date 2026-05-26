import { describe, expect, it, vi } from "vitest";
import {
  buildShowServersPayload,
  resolveProject,
  type AuthorizeBatchInput,
  type AuthorizeBatchResult,
  type InspectMcpServerResult,
  type RemoteServer,
  type RemoteProject,
} from "../src/tools/showServersCore.js";
import type {
  ProbeMcpServerConfig,
  ProbeMcpServerResult,
} from "@mcpjam/sdk/worker";

const PROJECTS: RemoteProject[] = [
  {
    _id: "project-old",
    organizationId: "org-a",
    name: "Old",
    updatedAt: 100,
  },
  {
    _id: "project-new",
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

describe("resolveProject", () => {
  it("selects the most recently updated project when omitted", () => {
    const result = resolveProject(PROJECTS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project._id).toBe("project-new");
    }
  });

  it("selects an exact project ID before considering names", () => {
    const result = resolveProject(
      [
        ...PROJECTS,
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
      expect(result.project._id).toBe("New");
      expect(result.project.name).toBe("ID Wins");
    }
  });

  it("selects a unique project name case-insensitively", () => {
    const result = resolveProject(PROJECTS, "new");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project._id).toBe("project-new");
    }
  });

  it("returns an actionable error for duplicate project names", () => {
    const result = resolveProject(
      [
        ...PROJECTS,
        {
          _id: "project-new-copy",
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
      expect(result.message).toContain("project-new");
      expect(result.message).toContain("project-new-copy");
    }
  });

  it("returns available projects for a missing selector", () => {
    const result = resolveProject(PROJECTS, "missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Available projects");
      expect(result.message).toContain("project-new");
      expect(result.message).toContain("project-old");
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
        _id: "oauth-required",
        name: "OAuth Required",
        transportType: "http",
        url: "https://oauth-required.example.com/mcp",
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
            "oauth-required": {
              ok: true,
              serverConfig: {
                transportType: "http",
                url: "https://oauth-required.example.com/mcp",
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

      if (config.url.includes("oauth-required")) {
        return probeResult({
          url: config.url,
          status: "oauth_required",
          initialize: undefined,
          oauth: {
            required: true,
            optional: false,
            registrationStrategies: [],
          },
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
      project: PROJECTS[0]!,
      projects: PROJECTS,
      servers,
      generatedAt: "2026-04-26T00:00:00.000Z",
      authorizeBatch,
      probe,
    });

    expect(authorizeBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        serverIds: [
          "ready",
          "non-ready",
          "oauth-required",
          "auth-fail",
          "throws",
        ],
      })
    );
    expect(payload.servers.map((server) => [server.id, server.status])).toEqual(
      [
        ["stdio", "skipped"],
        ["insecure", "skipped"],
        ["ready", "reachable"],
        ["non-ready", "unreachable"],
        ["oauth-required", "reachable"],
        ["auth-fail", "error"],
        ["throws", "unreachable"],
      ]
    );
    expect(payload.servers[2]?.serverInfo).toEqual({
      name: "ready-server",
      version: "2.0.0",
    });
    expect(payload.servers[4]?.statusDetail).toContain("OAuth required");
    expect(payload.servers[5]?.statusDetail).toContain("FORBIDDEN");
    expect(payload.servers[6]?.statusDetail).toContain("connect timeout");
    expect(payload.summary).toEqual({
      reachable: 2,
      unreachable: 2,
      skipped: 2,
      error: 1,
    });
  });

  it("marks supported HTTPS servers as errors when batch authorization fails", async () => {
    const payload = await buildShowServersPayload({
      bearerToken: "token",
      convexHttpUrl: "https://convex.example.com",
      project: PROJECTS[0]!,
      projects: PROJECTS,
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

  it("adds compact tool, resource, and prompt summaries from server inspection", async () => {
    const inspect = vi.fn(
      async (): Promise<InspectMcpServerResult> => ({
        probe: probeResult({
          initialize: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "ready-server", version: "2.0.0" },
          },
        }),
        tools: [
          {
            name: "search_tasks",
            title: "Search tasks",
            description: "Search the task index.",
            inputSchema: { type: "object" },
          },
        ],
        resources: [
          {
            uri: "file:///tmp/example.txt",
            name: "example",
            title: "Example",
            description: "Example resource.",
            mimeType: "text/plain",
          },
        ],
        prompts: [
          {
            name: "summarize_project",
            description: "Summarize project state.",
            arguments: [
              {
                name: "project_id",
                description: "Project ID.",
                required: true,
              },
            ],
          },
        ],
        checks: {
          tools: { status: "ok", detail: "1 tool discovered." },
          resources: { status: "ok", detail: "1 resource discovered." },
          prompts: { status: "ok", detail: "1 prompt discovered." },
        },
      })
    );

    const payload = await buildShowServersPayload({
      bearerToken: "token",
      convexHttpUrl: "https://convex.example.com",
      project: PROJECTS[0]!,
      projects: PROJECTS,
      servers: [
        {
          _id: "ready",
          name: "Ready",
          transportType: "http",
          url: "https://ready.example.com/mcp",
        },
      ],
      generatedAt: "2026-04-26T00:00:00.000Z",
      authorizeBatch: async () => ({
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
          },
        },
      }),
      inspect,
    });

    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://ready.example.com/mcp",
        accessToken: "ready-token",
        headers: { "X-Test": "ready" },
      })
    );
    expect(payload.servers[0]?.primitives).toEqual({
      tools: {
        status: "loaded",
        statusDetail: "1 tool discovered.",
        items: [
          {
            name: "search_tasks",
            title: "Search tasks",
            description: "Search the task index.",
          },
        ],
      },
      resources: {
        status: "loaded",
        statusDetail: "1 resource discovered.",
        items: [
          {
            uri: "file:///tmp/example.txt",
            name: "example",
            title: "Example",
            description: "Example resource.",
            mimeType: "text/plain",
          },
        ],
      },
      prompts: {
        status: "loaded",
        statusDetail: "1 prompt discovered.",
        items: [
          {
            name: "summarize_project",
            description: "Summarize project state.",
            arguments: [
              {
                name: "project_id",
                description: "Project ID.",
                required: true,
              },
            ],
          },
        ],
      },
    });
  });
});
