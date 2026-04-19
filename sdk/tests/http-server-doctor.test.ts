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
