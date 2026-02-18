import { Hono } from "hono";
import { vi } from "vitest";
import webRoutes from "../../index.js";

/**
 * Minimal mock for hosted-mode MCPClientManager.
 * Web routes create their own managers via `createAuthorizedManager`,
 * but the Hono context still needs the field for type compliance.
 */
export function createWebTestApp(options?: {
  /** Stub the Convex authorize endpoint. Defaults to returning authorized. */
  authorizeResponse?: Record<string, unknown>;
  /** Bearer token required for requests. */
  bearerToken?: string;
}) {
  const app = new Hono();

  // Inject a no-op mcpClientManager (web routes create their own)
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {};
    await next();
  });

  app.route("/api/web", webRoutes);

  const token = options?.bearerToken ?? "test-token-123";

  return { app, token };
}

/**
 * POST JSON helper with optional bearer token.
 */
export async function postJson(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * GET helper with optional bearer token.
 */
export async function getJson(
  app: Hono,
  path: string,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return app.request(path, { method: "GET", headers });
}

export async function expectJson<T = unknown>(
  response: Response,
): Promise<{ status: number; data: T }> {
  return {
    status: response.status,
    data: (await response.json()) as T,
  };
}

export async function expectError<T = unknown>(
  response: Response,
  expectedStatus?: number,
): Promise<T> {
  const { status, data } = await expectJson<T>(response);
  if (expectedStatus !== undefined && status !== expectedStatus) {
    throw new Error(
      `Expected status ${expectedStatus} but got ${status}: ${JSON.stringify(data)}`,
    );
  }
  return data;
}
