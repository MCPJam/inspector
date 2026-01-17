/**
 * Origin Validation Middleware
 *
 * Blocks requests from non-localhost origins to prevent:
 * - DNS rebinding attacks
 * - CSRF attacks from malicious websites
 *
 * This is defense-in-depth alongside session token auth.
 */

import type { Context, Next } from "hono";
import { SERVER_PORT } from "../config.js";
import { logger as appLogger } from "../utils/logger.js";

/**
 * Get the list of allowed origins.
 * Can be overridden via ALLOWED_ORIGINS environment variable.
 */
function getAllowedOrigins(): string[] {
  // Allow override via environment variable
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  }

  // Default: localhost origins on common dev ports
  const ports = [SERVER_PORT, 5173, 8080];
  const origins: string[] = [];

  for (const port of ports) {
    origins.push(`http://localhost:${port}`);
    origins.push(`http://127.0.0.1:${port}`);
  }

  return origins;
}

/**
 * Origin validation middleware.
 * Blocks requests from non-localhost origins.
 */
export async function originValidationMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  // Allow CORS preflight requests through
  if (c.req.method === "OPTIONS") {
    return next();
  }

  const origin = c.req.header("Origin");

  // No origin header = same-origin request or non-browser client (curl, etc.)
  // These still require valid token, so this is safe
  if (!origin) {
    return next();
  }

  const allowedOrigins = getAllowedOrigins();

  if (!allowedOrigins.includes(origin)) {
    appLogger.warn(`[Security] Blocked request from origin: ${origin}`);
    return c.json(
      {
        error: "Forbidden",
        message: "Request origin not allowed.",
      },
      403,
    );
  }

  return next();
}
