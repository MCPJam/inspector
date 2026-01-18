/**
 * Origin Validation Middleware
 *
 * Blocks requests from non-localhost origins to prevent:
 * - DNS rebinding attacks
 * - CSRF attacks from malicious websites
 *
 * This is defense-in-depth alongside session token auth.
 *
 * In web mode (public deployment):
 * - ALLOWED_ORIGINS must be configured with the public domain(s)
 * - Localhost origins are still allowed for local development
 */

import type { Context, Next } from "hono";
import { SERVER_PORT } from "../config.js";
import { logger as appLogger } from "../utils/logger.js";
import { isWebMode } from "../utils/web-mode.js";

/**
 * Get the list of allowed origins.
 * Can be overridden via ALLOWED_ORIGINS environment variable.
 *
 * In web mode, both configured origins AND localhost are allowed.
 * This allows the same deployment to work for both web and local access.
 */
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  // Always include localhost origins for local development
  const ports = [SERVER_PORT, 5173, 8080];
  for (const port of ports) {
    origins.push(`http://localhost:${port}`);
    origins.push(`http://127.0.0.1:${port}`);
  }

  // Add configured origins (for web mode / public deployment)
  if (process.env.ALLOWED_ORIGINS) {
    const configuredOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o) =>
      o.trim(),
    );
    origins.push(...configuredOrigins);
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
  const path = c.req.path;

  // Debug logging for all API requests
  if (path.startsWith("/api/")) {
    console.log(`[OriginValidation] path=${path}, origin=${origin}, ALLOWED_ORIGINS=${process.env.ALLOWED_ORIGINS}`);
  }

  // No origin header = same-origin request or non-browser client (curl, etc.)
  // These still require valid token, so this is safe
  if (!origin) {
    return next();
  }

  const allowedOrigins = getAllowedOrigins();
  console.log(`[OriginValidation] allowedOrigins=${JSON.stringify(allowedOrigins)}, checking origin=${origin}`);

  if (!allowedOrigins.includes(origin)) {
    console.log(`[OriginValidation] BLOCKED - origin not in allowed list`);
    appLogger.warn(`[Security] Blocked request from origin: ${origin}`);
    const webMode = isWebMode();
    return c.json(
      {
        error: "Forbidden",
        message: "Request origin not allowed.",
        hint: webMode
          ? `Configure ALLOWED_ORIGINS environment variable to include: ${origin}`
          : "This endpoint only accepts requests from localhost.",
      },
      403,
    );
  }

  return next();
}
