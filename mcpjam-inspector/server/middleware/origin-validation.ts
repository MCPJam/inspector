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
    const origins = process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

    // Wildcard origins (e.g. https://*.up.railway.app) are only safe behind
    // non-prod lockdown.  Reject them in production to prevent accidental
    // misconfiguration from weakening origin checks.
    if (process.env.MCPJAM_NONPROD_LOCKDOWN !== "true") {
      const wildcards = origins.filter((o) => o.includes("*"));
      if (wildcards.length > 0) {
        appLogger.warn(
          `[Security] Wildcard ALLOWED_ORIGINS rejected outside non-prod lockdown: ${wildcards.join(", ")}`,
        );
        return origins.filter((o) => !o.includes("*"));
      }
    }

    return origins;
  }

  // Default: localhost origins on common dev ports
  const clientPort = parseInt(process.env.CLIENT_PORT || "5173", 10);
  const ports = [SERVER_PORT, clientPort, 8080];
  const origins: string[] = [];

  for (const port of ports) {
    origins.push(`http://localhost:${port}`);
    origins.push(`http://127.0.0.1:${port}`);
  }

  return origins;
}

/**
 * Check whether an origin matches the allowed list.
 * Supports wildcard entries like `https://*.up.railway.app`.
 */
function matchesAllowedOrigin(
  origin: string,
  allowedOrigins: string[],
): boolean {
  for (const allowed of allowedOrigins) {
    if (allowed.includes("*")) {
      // e.g. "https://*.up.railway.app"  →  scheme "https://" + pattern "*.up.railway.app"
      const schemeEnd = allowed.indexOf("://");
      if (schemeEnd === -1) continue;
      const scheme = allowed.slice(0, schemeEnd + 3); // "https://"
      const pattern = allowed.slice(schemeEnd + 3); // "*.up.railway.app"

      if (!origin.startsWith(scheme)) continue;
      const originHost = origin.slice(scheme.length); // "foo.up.railway.app"

      if (pattern.startsWith("*.")) {
        const suffix = pattern.slice(2); // "up.railway.app"
        if (originHost === suffix || originHost.endsWith(`.${suffix}`)) {
          return true;
        }
      }
    } else if (origin === allowed) {
      return true;
    }
  }
  return false;
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

  // Static assets contain no sensitive data and are already excluded from
  // session auth.  Vite emits <script type="module" crossorigin> and
  // <link rel="stylesheet" crossorigin>, which cause the browser to attach
  // an Origin header.  Blocking them here breaks every preview deploy.
  const path = c.req.path;
  if (path.startsWith("/assets/")) {
    return next();
  }

  const origin = c.req.header("Origin");

  // No origin header = same-origin request or non-browser client (curl, etc.)
  // Most routes still require valid token; OAuth proxy routes rely on HTTPS-only + private IP blocking
  if (!origin) {
    return next();
  }

  const allowedOrigins = getAllowedOrigins();

  if (!matchesAllowedOrigin(origin, allowedOrigins)) {
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
