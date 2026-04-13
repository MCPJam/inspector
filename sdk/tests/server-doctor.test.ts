import {
  collectConnectedServerDoctorState,
  runServerDoctor,
} from "../src/server-doctor";
import type { ProbeMcpServerResult } from "../src/server-probe";

function createProbeResult(
  overrides: Partial<ProbeMcpServerResult> = {},
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

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    listTools: jest
      .fn()
      .mockResolvedValue({ tools: [{ name: "echo", description: "Echo input" }] }),
    getAllToolsMetadata: jest.fn().mockReturnValue({ echo: { title: "Echo" } }),
    listResources: jest
      .fn()
      .mockResolvedValue({ resources: [{ uri: "file://note", name: "Note" }] }),
    listPrompts: jest.fn().mockResolvedValue({ prompts: [{ name: "summarize" }] }),
    listResourceTemplates: jest
      .fn()
      .mockResolvedValue({ resourceTemplates: [{ uriTemplate: "note://{id}" }] }),
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

describe("collectConnectedServerDoctorState", () => {
  it("collects connected server state and metadata", async () => {
    const manager = createMockManager();

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.initInfo).toEqual({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
    });
    expect(result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    expect(result.tools).toEqual([{ name: "echo", description: "Echo input" }]);
    expect(result.toolsMetadata).toEqual({ echo: { title: "Echo" } });
    expect(result.resources).toEqual([{ uri: "file://note", name: "Note" }]);
    expect(result.prompts).toEqual([{ name: "summarize" }]);
    expect(result.resourceTemplates).toEqual([{ uriTemplate: "note://{id}" }]);
    expect(result.checks.tools.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  it("marks unsupported resource templates as skipped", async () => {
    const manager = createMockManager({
      listResourceTemplates: jest
        .fn()
        .mockRejectedValue(new Error("Method resources/templates not found")),
    });

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.resourceTemplates).toEqual({
      status: "skipped",
      detail: "Server does not support resources/templates.",
    });
    expect(result.errors).toEqual([]);
  });
});

describe("runServerDoctor", () => {
  it("returns a ready report for a healthy server", async () => {
    const result = await runServerDoctor(
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
        withManager: async (_config, fn) => fn(createMockManager(), "srv"),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.target).toEqual({ label: "https://example.com/mcp" });
    expect(result.checks.probe.status).toBe("ok");
    expect(result.checks.connection.status).toBe("ok");
    expect(result.tools).toHaveLength(1);
    expect(result.resources).toHaveLength(1);
    expect(result.prompts).toHaveLength(1);
    expect(result.error).toBeNull();
  });

  it("returns oauth_required and skips connect when no credentials are supplied", async () => {
    let connected = false;

    const result = await runServerDoctor(
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
          }),
        ),
        withManager: async () => {
          connected = true;
          throw new Error("should not connect");
        },
      },
    );

    expect(result.status).toBe("oauth_required");
    expect(result.checks.probe.status).toBe("error");
    expect(result.checks.connection.status).toBe("skipped");
    expect(result.error?.code).toBe("OAUTH_REQUIRED");
    expect(connected).toBe(false);
  });

  it("continues after an oauth_required probe when credentials are present in headers", async () => {
    let connected = false;

    const result = await runServerDoctor(
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
          }),
        ),
        withManager: async (_config, fn) => {
          connected = true;
          return fn(createMockManager(), "srv");
        },
      },
    );

    expect(connected).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.checks.probe.status).toBe("ok");
    expect(result.checks.probe.detail).toMatch(/continuing with provided credentials/i);
  });
});
