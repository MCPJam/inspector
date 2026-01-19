import { Hono } from "hono";
import { cors } from "hono/cors";
import type { MockMCPClientManager } from "./mock-mcp-client-manager.js";

// Import route modules
import connect from "../../connect.js";
import tools from "../../tools.js";
import resources from "../../resources.js";
import servers from "../../servers.js";
import prompts from "../../prompts.js";
import chatV2 from "../../chat-v2.js";
import { adapterHttp, managerHttp } from "../../http-adapters.js";

// Import security middleware
import { sessionAuthMiddleware } from "../../../../middleware/session-auth.js";
import { originValidationMiddleware } from "../../../../middleware/origin-validation.js";
import { securityHeadersMiddleware } from "../../../../middleware/security-headers.js";
import { CORS_ORIGINS } from "../../../../config.js";

/**
 * Route configuration for test app creation
 */
export type RouteConfig =
  | "connect"
  | "tools"
  | "resources"
  | "servers"
  | "prompts"
  | "chat-v2"
  | "adapter-http"
  | "manager-http";

const routeModules: Record<RouteConfig, { path: string; handler: Hono }> = {
  connect: { path: "/api/mcp/connect", handler: connect },
  tools: { path: "/api/mcp/tools", handler: tools },
  resources: { path: "/api/mcp/resources", handler: resources },
  servers: { path: "/api/mcp/servers", handler: servers },
  prompts: { path: "/api/mcp/prompts", handler: prompts },
  "chat-v2": { path: "/api/mcp/chat-v2", handler: chatV2 },
  "adapter-http": { path: "/api/mcp/adapter-http", handler: adapterHttp },
  "manager-http": { path: "/api/mcp/manager-http", handler: managerHttp },
};

/**
 * Options for creating a test app
 */
export interface CreateTestAppOptions {
  /**
   * Enable security middleware (origin validation, session auth, security headers).
   * When enabled, requests must include valid authentication tokens.
   * @default false
   */
  withSecurity?: boolean;
}

/**
 * Creates a test Hono app with the mock MCPClientManager injected.
 * Supports mounting single or multiple route modules.
 *
 * @example
 * // Create app with single route
 * const app = createTestApp(mockManager, "tools");
 *
 * @example
 * // Create app with multiple routes
 * const app = createTestApp(mockManager, ["connect", "tools", "servers"]);
 *
 * @example
 * // Create app with security middleware enabled
 * const app = createTestApp(mockManager, "adapter-http", { withSecurity: true });
 */
export function createTestApp(
  mcpClientManager: MockMCPClientManager,
  routes: RouteConfig | RouteConfig[],
  options: CreateTestAppOptions = {},
): Hono {
  const app = new Hono();

  // Middleware to inject mock mcpClientManager into context
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = mcpClientManager;
    await next();
  });

  // Apply security middleware if requested (same order as server/index.ts)
  if (options.withSecurity) {
    app.use("*", securityHeadersMiddleware);
    app.use("*", originValidationMiddleware);
    app.use("*", sessionAuthMiddleware);
    app.use(
      "*",
      cors({
        origin: CORS_ORIGINS,
        credentials: true,
      }),
    );
  }

  // Mount requested routes
  const routesToMount = Array.isArray(routes) ? routes : [routes];
  for (const route of routesToMount) {
    const config = routeModules[route];
    app.route(config.path, config.handler);
  }

  return app;
}

/**
 * Helper to make JSON POST requests to the test app.
 * Automatically sets Content-Type header and stringifies body.
 *
 * @example
 * const response = await postJson(app, "/api/mcp/tools/list", { serverId: "test" });
 * const data = await response.json();
 */
export async function postJson(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Helper to make GET requests to the test app.
 *
 * @example
 * const response = await getJson(app, "/api/mcp/servers");
 * const data = await response.json();
 */
export async function getJson(app: Hono, path: string): Promise<Response> {
  return app.request(path, { method: "GET" });
}

/**
 * Helper to make DELETE requests to the test app.
 *
 * @example
 * const response = await deleteJson(app, "/api/mcp/servers/server-1");
 * const data = await response.json();
 */
export async function deleteJson(app: Hono, path: string): Promise<Response> {
  return app.request(path, { method: "DELETE" });
}

/**
 * Convenience function to extract JSON from response and check status in one call.
 *
 * @example
 * const { status, data } = await expectJson(response);
 * expect(status).toBe(200);
 * expect(data.success).toBe(true);
 */
export async function expectJson<T = unknown>(
  response: Response,
): Promise<{ status: number; data: T }> {
  return {
    status: response.status,
    data: (await response.json()) as T,
  };
}

/**
 * Asserts response is successful (2xx) and returns parsed JSON.
 * Throws if status is not 2xx.
 *
 * @example
 * const data = await expectSuccess(response);
 * expect(data.tools).toHaveLength(2);
 */
export async function expectSuccess<T = unknown>(
  response: Response,
): Promise<T> {
  const { status, data } = await expectJson<T>(response);
  if (status < 200 || status >= 300) {
    throw new Error(
      `Expected success status but got ${status}: ${JSON.stringify(data)}`,
    );
  }
  return data;
}

/**
 * Asserts response is an error (4xx or 5xx) and returns parsed JSON.
 * Throws if status is 2xx.
 *
 * @example
 * const data = await expectError(response, 400);
 * expect(data.error).toBe("serverId is required");
 */
export async function expectError<T = unknown>(
  response: Response,
  expectedStatus?: number,
): Promise<T> {
  const { status, data } = await expectJson<T>(response);
  if (status >= 200 && status < 300) {
    throw new Error(
      `Expected error status but got ${status}: ${JSON.stringify(data)}`,
    );
  }
  if (expectedStatus !== undefined && status !== expectedStatus) {
    throw new Error(`Expected status ${expectedStatus} but got ${status}`);
  }
  return data;
}
