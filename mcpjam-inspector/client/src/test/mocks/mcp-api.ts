/**
 * Mocks for MCP API functions.
 * Use these to mock the mcp-api module in tests.
 *
 * @example
 * vi.mock("@/state/mcp-api", () => mockMcpApi);
 */
import { vi } from "vitest";

/**
 * Default mock implementations for MCP API functions
 */
export const mockMcpApi = {
  testConnection: vi.fn().mockResolvedValue({ success: true, status: "connected" }),
  deleteServer: vi.fn().mockResolvedValue({ success: true, message: "Disconnected" }),
  listServers: vi.fn().mockResolvedValue({ success: true, servers: [] }),
  reconnectServer: vi.fn().mockResolvedValue({ success: true, status: "connected" }),
  getInitializationInfo: vi.fn().mockResolvedValue({
    success: true,
    initInfo: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "test-server", version: "1.0.0" },
    },
  }),
  setServerLoggingLevel: vi.fn().mockResolvedValue({ success: true }),
};

/**
 * Creates a fresh copy of the mocks (useful in beforeEach)
 */
export function createMockMcpApi() {
  return {
    testConnection: vi.fn().mockResolvedValue({ success: true, status: "connected" }),
    deleteServer: vi.fn().mockResolvedValue({ success: true, message: "Disconnected" }),
    listServers: vi.fn().mockResolvedValue({ success: true, servers: [] }),
    reconnectServer: vi.fn().mockResolvedValue({ success: true, status: "connected" }),
    getInitializationInfo: vi.fn().mockResolvedValue({
      success: true,
      initInfo: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "test-server", version: "1.0.0" },
      },
    }),
    setServerLoggingLevel: vi.fn().mockResolvedValue({ success: true }),
  };
}

/**
 * Preset configurations for common test scenarios
 */
export const mcpApiPresets = {
  /** All operations succeed */
  allSuccess: () => createMockMcpApi(),

  /** Connection fails */
  connectionFails: (errorMessage = "Connection refused") => ({
    ...createMockMcpApi(),
    testConnection: vi.fn().mockResolvedValue({
      success: false,
      error: errorMessage,
    }),
    reconnectServer: vi.fn().mockResolvedValue({
      success: false,
      error: errorMessage,
    }),
  }),

  /** Network error (fetch throws) */
  networkError: (errorMessage = "Network error") => ({
    ...createMockMcpApi(),
    testConnection: vi.fn().mockRejectedValue(new Error(errorMessage)),
    deleteServer: vi.fn().mockRejectedValue(new Error(errorMessage)),
    listServers: vi.fn().mockRejectedValue(new Error(errorMessage)),
    reconnectServer: vi.fn().mockRejectedValue(new Error(errorMessage)),
    getInitializationInfo: vi.fn().mockRejectedValue(new Error(errorMessage)),
  }),

  /** With servers already connected */
  withConnectedServers: (serverIds: string[]) => ({
    ...createMockMcpApi(),
    listServers: vi.fn().mockResolvedValue({
      success: true,
      servers: serverIds.map((id) => ({
        id,
        name: id,
        status: "connected",
        config: { command: "node" },
      })),
    }),
  }),
};

/**
 * Helper to setup mcp-api mock for a test file
 *
 * @example
 * // At the top of your test file:
 * vi.mock("@/state/mcp-api", () => setupMcpApiMock());
 *
 * // Or with a preset:
 * vi.mock("@/state/mcp-api", () => setupMcpApiMock(mcpApiPresets.connectionFails()));
 */
export function setupMcpApiMock(overrides = {}) {
  return {
    ...mockMcpApi,
    ...overrides,
  };
}
