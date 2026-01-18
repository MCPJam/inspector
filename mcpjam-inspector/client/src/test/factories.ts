/**
 * Test data factories for creating consistent test data.
 * Uses factory pattern to generate unique instances with sensible defaults.
 */
import type { ServerWithName, Workspace, ConnectionStatus } from "@/state/app-types";
import type { MCPServerConfig } from "@/sdk";

// Counter for generating unique IDs
let idCounter = 0;
const uniqueId = (prefix: string) => `${prefix}-${++idCounter}`;

/**
 * Reset ID counter between test suites if needed
 */
export function resetFactoryIds(): void {
  idCounter = 0;
}

/**
 * Creates a server configuration object
 */
export function createServerConfig(
  overrides: Partial<MCPServerConfig> = {}
): MCPServerConfig {
  return {
    command: "node",
    args: ["server.js"],
    ...overrides,
  } as MCPServerConfig;
}

/**
 * Creates an HTTP server configuration
 */
export function createHttpServerConfig(
  url: string,
  overrides: Partial<MCPServerConfig> = {}
): MCPServerConfig {
  return {
    url: new URL(url),
    ...overrides,
  } as MCPServerConfig;
}

/**
 * Creates a ServerWithName object with sensible defaults
 */
export function createServer(
  overrides: Partial<ServerWithName> = {}
): ServerWithName {
  const name = overrides.name || uniqueId("server");
  return {
    name,
    config: createServerConfig(),
    connectionStatus: "disconnected" as ConnectionStatus,
    lastConnectionTime: new Date(),
    retryCount: 0,
    enabled: false,
    ...overrides,
  };
}

/**
 * Creates a connected server
 */
export function createConnectedServer(
  overrides: Partial<ServerWithName> = {}
): ServerWithName {
  return createServer({
    connectionStatus: "connected",
    enabled: true,
    ...overrides,
  });
}

/**
 * Creates a server with OAuth configuration
 */
export function createOAuthServer(
  url: string,
  overrides: Partial<ServerWithName> = {}
): ServerWithName {
  return createServer({
    config: createHttpServerConfig(url),
    useOAuth: true,
    oauthTokens: {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    },
    ...overrides,
  });
}

/**
 * Creates a Workspace object with sensible defaults
 */
export function createWorkspace(
  overrides: Partial<Workspace> = {}
): Workspace {
  const id = overrides.id || uniqueId("workspace");
  return {
    id,
    name: overrides.name || `Workspace ${id}`,
    description: "",
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: false,
    ...overrides,
  };
}

/**
 * Creates a workspace with servers
 */
export function createWorkspaceWithServers(
  serverCount: number,
  overrides: Partial<Workspace> = {}
): Workspace {
  const servers: Record<string, ServerWithName> = {};
  for (let i = 0; i < serverCount; i++) {
    const server = createServer();
    servers[server.name] = server;
  }
  return createWorkspace({ servers, ...overrides });
}

/**
 * Tool factory
 */
export function createTool(
  overrides: Partial<{
    name: string;
    description: string;
    inputSchema: object;
    outputSchema?: object;
  }> = {}
) {
  const name = overrides.name || uniqueId("tool");
  return {
    name,
    description: overrides.description || `Description for ${name}`,
    inputSchema: overrides.inputSchema || {
      type: "object",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
    },
    ...overrides,
  };
}

/**
 * Resource factory
 */
export function createResource(
  overrides: Partial<{
    uri: string;
    name: string;
    mimeType: string;
    description?: string;
  }> = {}
) {
  const name = overrides.name || uniqueId("resource");
  return {
    uri: overrides.uri || `file:///${name}.txt`,
    name,
    mimeType: overrides.mimeType || "text/plain",
    ...overrides,
  };
}

/**
 * Prompt factory
 */
export function createPrompt(
  overrides: Partial<{
    name: string;
    description: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  }> = {}
) {
  const name = overrides.name || uniqueId("prompt");
  return {
    name,
    description: overrides.description || `Description for ${name}`,
    arguments: overrides.arguments || [],
    ...overrides,
  };
}

/**
 * Creates initialization info for a server
 */
export function createInitializationInfo(
  overrides: Partial<{
    protocolVersion: string;
    capabilities: {
      tools?: object;
      resources?: object;
      prompts?: object;
    };
    serverInfo: {
      name: string;
      version: string;
    };
  }> = {}
) {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      ...overrides.capabilities,
    },
    serverInfo: {
      name: "test-server",
      version: "1.0.0",
      ...overrides.serverInfo,
    },
    ...overrides,
  };
}

/**
 * Creates a mock API response
 */
export function createApiResponse<T>(
  data: T,
  success = true
): { success: boolean; data?: T; error?: string } {
  if (success) {
    return { success: true, data };
  }
  return { success: false, error: "Test error" };
}

/**
 * Creates a mock fetch response
 */
export function createFetchResponse<T>(
  data: T,
  status = 200
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: new Headers({ "Content-Type": "application/json" }),
  } as Response;
}

/**
 * Creates multiple items using a factory function
 */
export function createMany<T>(
  factory: (index: number) => T,
  count: number
): T[] {
  return Array.from({ length: count }, (_, i) => factory(i));
}
