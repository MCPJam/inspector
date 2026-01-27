import { vi } from "vitest";

/**
 * Type for the mock MCPClientManager - all methods are vi.fn() mocks
 */
export type MockMCPClientManager = ReturnType<
  typeof createMockMcpClientManager
>;

/**
 * Default mock implementations for MCPClientManager methods.
 * Each method returns a sensible default that can be overridden.
 */
const defaultMocks = {
  // Connection management
  connectToServer: vi.fn().mockResolvedValue(undefined),
  disconnectServer: vi.fn().mockResolvedValue(undefined),
  removeServer: vi.fn(),
  getClient: vi.fn().mockReturnValue({}),
  hasServer: vi.fn().mockReturnValue(false),
  listServers: vi.fn().mockReturnValue([]),
  getServerSummaries: vi.fn().mockReturnValue([]),
  getConnectionStatus: vi.fn().mockReturnValue("connected"),
  getInitializationInfo: vi.fn().mockReturnValue(null),

  // Tools
  listTools: vi.fn().mockResolvedValue({ tools: [] }),
  executeTool: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Tool executed successfully" }],
  }),
  getAllToolsMetadata: vi.fn().mockReturnValue({}),
  setElicitationHandler: vi.fn(),
  clearElicitationHandler: vi.fn(),

  // Resources
  listResources: vi.fn().mockResolvedValue({
    resources: [],
    nextCursor: undefined,
  }),
  readResource: vi.fn().mockResolvedValue({
    contents: [],
  }),

  // Prompts
  listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
  getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
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
  overrides: Partial<
    Record<keyof typeof defaultMocks, ReturnType<typeof vi.fn>>
  > = {},
) {
  return {
    ...Object.fromEntries(
      Object.entries(defaultMocks).map(([key, mockFn]) => [
        key,
        // Create a fresh mock for each call to avoid state pollution
        vi.fn().mockImplementation(mockFn.getMockImplementation()),
      ]),
    ),
    ...overrides,
  } as typeof defaultMocks;
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
