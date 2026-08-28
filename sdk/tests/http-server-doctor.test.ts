import {
  collectConnectedHttpServerDoctorState,
  runHttpServerDoctor,
} from "../src/http-server-doctor";
import type { ProbeMcpServerResult } from "../src/server-probe";

function createProbeResult(
  overrides: Partial<ProbeMcpServerResult> = {}
): ProbeMcpServerResult {
  return {
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: {
      selected: "streamable-http",
      attempts: [],
    },
    oauth: {
      required: false,
      optional: false,
      registrationStrategies: [],
    },
    initialize: {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
      capabilities: { tools: {} },
    },
    ...overrides,
  };
}

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    close: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({
      tools: [
        {
          name: "echo",
          description: "Echo input",
          _meta: { title: "Echo" },
        },
      ],
    }),
    listResources: jest
      .fn()
      .mockResolvedValue({ resources: [{ uri: "file://note", name: "Note" }] }),
    listPrompts: jest
      .fn()
      .mockResolvedValue({ prompts: [{ name: "summarize" }] }),
    listResourceTemplates: jest.fn().mockResolvedValue({
      resourceTemplates: [{ uriTemplate: "note://{id}" }],
    }),
    getInitializationInfo: jest.fn().mockReturnValue({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
    }),
    getServerCapabilities: jest
      .fn()
      .mockReturnValue({ tools: {}, resources: {}, prompts: {} }),
    ...overrides,
  } as any;
}

describe("collectConnectedHttpServerDoctorState", () => {
  it("collects connected server state and metadata", async () => {
    const client = createMockClient();

    const result = await collectConnectedHttpServerDoctorState(client, {
      timeout: 4_000,
    });

    expect(result.initInfo).toEqual({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
    });
    expect(result.capabilities).toEqual({
      tools: {},
      resources: {},
      prompts: {},
    });
    expect(result.tools).toEqual([{ name: "echo", description: "Echo input" }]);
    expect(result.toolsMetadata).toEqual({ echo: { title: "Echo" } });
    expect(result.resources).toEqual([{ uri: "file://note", name: "Note" }]);
    expect(result.prompts).toEqual([{ name: "summarize" }]);
    expect(result.resourceTemplates).toEqual([{ uriTemplate: "note://{id}" }]);
    expect(result.checks.tools.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  it("marks unsupported resource templates as skipped", async () => {
    const client = createMockClient({
      listResourceTemplates: jest
        .fn()
        .mockRejectedValue(new Error("Method resources/templates not found")),
    });

    const result = await collectConnectedHttpServerDoctorState(client, {
      timeout: 4_000,
    });

    expect(result.checks.resourceTemplates).toEqual({
      status: "skipped",
      detail: "Server does not support resources/templates.",
    });
    expect(result.errors).toEqual([]);
  });

  // MCP 2026-07-28 `server/utilities/pagination`: "an empty string is a valid
  // cursor and thus MUST NOT be treated as the end of results".
  it("follows an empty-string nextCursor and forwards it verbatim", async () => {
    const cursors: Array<string | undefined> = [];
    const client = createMockClient({
      listTools: jest.fn().mockImplementation(async (params?: any) => {
        cursors.push(params?.cursor);
        return params?.cursor === undefined
          ? { tools: [{ name: "echo" }], nextCursor: "" }
          : { tools: [{ name: "draw" }] };
      }),
    });

    const result = await collectConnectedHttpServerDoctorState(client, {
      timeout: 4_000,
    });

    expect(result.tools).toEqual([{ name: "echo" }, { name: "draw" }]);
    expect(cursors).toEqual([undefined, ""]);
    expect(result.checks.tools.status).toBe("ok");
  });

  it("stops on a repeated empty-string cursor instead of spinning to the page cap", async () => {
    // Before `""` was accepted as a continuation it terminated this loop, so
    // the drain never needed a cycle guard. Now that it continues, a server
    // looping on `""` would re-request the identical page up to
    // MAX_PAGINATION_PAGES times, each with this module's timeout and retry
    // handling. The guard trips on the SECOND occurrence.
    const listTools = jest
      .fn()
      .mockResolvedValue({ tools: [{ name: "echo" }], nextCursor: "" });
    const client = createMockClient({ listTools });

    const result = await collectConnectedHttpServerDoctorState(client, {
      timeout: 4_000,
    });

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(result.checks.tools.status).toBe("error");
    expect(result.checks.tools.detail).toContain("repeated cursor");
  });

  it("treats a non-string nextCursor as the end, never as a cursor", async () => {
    for (const nextCursor of [null, 42, { opaque: true }]) {
      const listTools = jest
        .fn()
        .mockResolvedValue({ tools: [{ name: "echo" }], nextCursor });
      const client = createMockClient({ listTools });

      const result = await collectConnectedHttpServerDoctorState(client, {
        timeout: 4_000,
      });

      expect(listTools).toHaveBeenCalledTimes(1);
      expect(result.tools).toEqual([{ name: "echo" }]);
      expect(result.checks.tools.status).toBe("ok");
    }
  });
});

describe("runHttpServerDoctor", () => {
  it("returns a ready report for a healthy HTTP server", async () => {
    const client = createMockClient();

    const result = await runHttpServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
      },
      {
        probeServer: jest.fn().mockResolvedValue(createProbeResult()),
        connectClient: jest.fn().mockResolvedValue(client),
      }
    );

    expect(result.status).toBe("ready");
    expect(result.checks.probe.status).toBe("ok");
    expect(result.checks.connection.status).toBe("ok");
    expect(result.tools).toHaveLength(1);
    expect(result.resources).toHaveLength(1);
    expect(result.prompts).toHaveLength(1);
    expect(result.error).toBeNull();
    expect(client.close).toHaveBeenCalled();
  });

  it("returns oauth_required and skips connect when no credentials are supplied", async () => {
    const connectClient = jest.fn();

    const result = await runHttpServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
      },
      {
        probeServer: jest.fn().mockResolvedValue(
          createProbeResult({
            status: "oauth_required",
            oauth: {
              required: true,
              optional: false,
              authorizationServerMetadataUrl:
                "https://auth.example.com/.well-known/oauth-authorization-server",
              resourceMetadataUrl:
                "https://example.com/.well-known/oauth-protected-resource",
              registrationStrategies: ["dcr", "cimd"],
            },
          })
        ),
        connectClient,
      }
    );

    expect(result.status).toBe("oauth_required");
    expect(result.checks.probe.status).toBe("error");
    expect(result.checks.connection.status).toBe("skipped");
    expect(result.error?.code).toBe("OAUTH_REQUIRED");
    expect(connectClient).not.toHaveBeenCalled();
  });

  it("continues after an oauth_required probe when credentials are present", async () => {
    const client = createMockClient();
    const connectClient = jest.fn().mockResolvedValue(client);

    const result = await runHttpServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          requestInit: {
            headers: {
              Authorization: "Bearer oauth-token",
            },
          },
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
      },
      {
        probeServer: jest.fn().mockResolvedValue(
          createProbeResult({
            status: "oauth_required",
            oauth: {
              required: true,
              optional: false,
              registrationStrategies: ["dcr"],
            },
          })
        ),
        connectClient,
      }
    );

    expect(connectClient).toHaveBeenCalled();
    expect(result.status).toBe("ready");
    expect(result.checks.probe.status).toBe("ok");
    expect(result.checks.probe.detail).toMatch(
      /continuing with provided credentials/i
    );
    expect(client.close).toHaveBeenCalled();
  });
});
