import { vi } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;

/**
 * Type for the mock MCPClientManager - all methods are vi.fn() mocks
 */
export type MockMCPClientManager = ReturnType<
  typeof createMockMcpClientManager
>;

/**
 * Default implementations for MCPClientManager methods.
 *
 * Defined as plain functions (not vi.fn() instances) so the factory can
 * install them via vi.fn(impl) on each call. mockReturnValue/mockResolvedValue
 * do NOT register an implementation visible to getMockImplementation(), so
 * copying defaults that way silently drops every default to undefined.
 */
const defaultImplementations = {
  // Connection management
  connectToServer: async () => undefined,
  disconnectServer: async () => undefined,
  removeServer: () => undefined,
  getClient: () => ({}),
  hasServer: () => true,
  listServers: () => [],
  getServerSummaries: () => [],
  getConnectionStatus: () => "connected",
  getInitializationInfo: () => null,

  // Tools
  listTools: async () => ({ tools: [] }),
  getToolsForAiSdk: async () => ({}),
  executeTool: async () => ({
    content: [{ type: "text", text: "Tool executed successfully" }],
  }),
  getAllToolsMetadata: () => ({}),
  setElicitationHandler: () => undefined,
  clearElicitationHandler: () => undefined,

  // Resources
  listResources: async () => ({
    resources: [],
    nextCursor: undefined,
  }),
  readResource: async () => ({
    contents: [],
  }),

  // Prompts
  listPrompts: async () => ({ prompts: [] }),
  getPrompt: async () => ({ messages: [] }),
} satisfies Record<string, (...args: any[]) => any>;

type DefaultMocks = {
  [K in keyof typeof defaultImplementations]: MockFn;
};

/**
 * Creates a mock MCPClientManager with sensible defaults.
 * All methods can be overridden via the overrides parameter.
 *
 * @example
 * // Basic usage with defaults
 * const manager = createMockMcpClientManager();
 *
 * @example
 * // Override specific methods
 * const manager = createMockMcpClientManager({
 *   listTools: vi.fn().mockResolvedValue({
 *     tools: [{ name: "my-tool", description: "A test tool" }]
 *   }),
 * });
 *
 * @example
 * // Override within a test
 * const manager = createMockMcpClientManager();
 * manager.listTools.mockResolvedValue({ tools: [{ name: "custom" }] });
 */
export function createMockMcpClientManager(
  overrides: Partial<Record<keyof typeof defaultImplementations, MockFn>> = {},
): DefaultMocks {
  const freshMocks = Object.fromEntries(
    (
      Object.keys(defaultImplementations) as Array<
        keyof typeof defaultImplementations
      >
    ).map((key) => [key, vi.fn(defaultImplementations[key] as any)]),
  ) as DefaultMocks;

  return {
    ...freshMocks,
    ...overrides,
  };
}

/**
 * Pre-configured mock factories for common test scenarios
 */
export const mockFactories = {
  /**
   * Creates a manager with tools configured
   */
  withTools: (
    tools: Array<{ name: string; description?: string; inputSchema?: object }>,
  ) =>
    createMockMcpClientManager({
      listTools: vi.fn().mockResolvedValue({ tools }),
      listServers: vi.fn().mockReturnValue(["test-server"]),
    }),

  /**
   * Creates a manager with resources configured
   */
  withResources: (
    resources: Array<{ uri: string; name: string; mimeType?: string }>,
  ) =>
    createMockMcpClientManager({
      listResources: vi
        .fn()
        .mockResolvedValue({ resources, nextCursor: undefined }),
    }),

  /**
   * Creates a manager with prompts configured
   */
  withPrompts: (
    prompts: Array<{ name: string; description?: string; arguments?: any[] }>,
  ) =>
    createMockMcpClientManager({
      listPrompts: vi.fn().mockResolvedValue({ prompts }),
    }),

  /**
   * Creates a manager with servers configured
   */
  withServers: (
    servers: Array<{ id: string; status: string; config: object }>,
  ) =>
    createMockMcpClientManager({
      getServerSummaries: vi.fn().mockReturnValue(servers),
      listServers: vi.fn().mockReturnValue(servers.map((s) => s.id)),
    }),

  /**
   * Creates a manager that simulates connection failures
   */
  withConnectionError: (errorMessage: string) =>
    createMockMcpClientManager({
      connectToServer: vi.fn().mockRejectedValue(new Error(errorMessage)),
    }),

  /**
   * Creates a manager with initialization info
   */
  withInitInfo: (initInfo: {
    protocolVersion?: string;
    capabilities?: object;
    serverInfo?: { name: string; version: string };
  }) =>
    createMockMcpClientManager({
      getInitializationInfo: vi.fn().mockReturnValue({
        protocolVersion: initInfo.protocolVersion || "2024-11-05",
        capabilities: initInfo.capabilities || { tools: {}, resources: {} },
        serverInfo: initInfo.serverInfo || {
          name: "test-server",
          version: "1.0.0",
        },
      }),
    }),
};

/**
 * Sample data for use in tests
 */
export const sampleData = {
  tools: {
    echo: {
      name: "echo",
      description: "Echoes input back",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    readFile: {
      name: "read_file",
      description: "Reads a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },

  resources: {
    textFile: {
      uri: "file:///test.txt",
      name: "test.txt",
      mimeType: "text/plain",
    },
    jsonFile: {
      uri: "file:///data.json",
      name: "data.json",
      mimeType: "application/json",
    },
  },

  prompts: {
    codeReview: {
      name: "code-review",
      description: "Review code for best practices",
      arguments: [
        { name: "code", description: "The code to review", required: true },
        {
          name: "language",
          description: "Programming language",
          required: false,
        },
      ],
    },
    summarize: {
      name: "summarize",
      description: "Summarize text content",
      arguments: [
        { name: "text", description: "Text to summarize", required: true },
      ],
    },
  },

  servers: {
    stdio: {
      id: "server-1",
      status: "connected",
      config: { command: "node", args: ["server.js"] },
    },
    http: {
      id: "server-2",
      status: "disconnected",
      config: { url: new URL("http://localhost:3000") },
    },
  },

  initInfo: {
    basic: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "test-server", version: "1.0.0" },
    },
  },
};
