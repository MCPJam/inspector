import type { Context, Next } from "hono";
import { HOSTED_MODE } from "../config";
import { logger } from "../utils/logger";
import {
  HostedJwtVerificationError,
  verifyHostedJwt,
} from "../services/auth/hosted-jwt-verifier";

function sanitizeTenantId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 200) return null;
  if (!/^[A-Za-z0-9._:/-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Hosted MCP auth middleware.
 *
 * In hosted mode, all /api/mcp/* routes require Authorization: Bearer <JWT>.
 * Tenant is derived from x-mcpjam-workspace-id (preferred) or JWT sub.
 */
export async function hostedMcpAuthMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (!HOSTED_MODE) {
    return next();
  }

  if (!c.req.path.startsWith("/api/mcp/")) {
    return next();
  }

  if (c.req.path === "/api/mcp/health") {
    return next();
  }

  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        error: "Unauthorized",
        message: "Authorization Bearer token is required in hosted mode.",
      },
      401,
    );
  }

  const token = authHeader.slice("Bearer ".length).trim();
  let payload: Record<string, unknown>;
  try {
    payload = await verifyHostedJwt(token);
  } catch (error) {
    if (error instanceof HostedJwtVerificationError) {
      if (error.code === "misconfigured" || error.code === "jwks_unavailable") {
        logger.error("Hosted JWT verifier unavailable", error);
        return c.json(
          {
            error: "Service Unavailable",
            message: error.message,
          },
          error.status,
        );
      }

      return c.json(
        {
          error: "Unauthorized",
          message: error.message,
        },
        error.status,
      );
    }

    logger.error("Unexpected hosted JWT verification error", error);
    return c.json(
      {
        error: "Unauthorized",
        message: "Bearer token verification failed.",
      },
      401,
    );
  }

  const workspaceId = sanitizeTenantId(c.req.header("x-mcpjam-workspace-id"));
  const subjectTenantId = sanitizeTenantId(payload.sub);
  const tenantId = workspaceId ?? subjectTenantId;

  if (!tenantId) {
    logger.warn("Hosted MCP auth failed due to missing tenant identifier");
    return c.json(
      {
        error: "Unauthorized",
        message:
          "Unable to resolve tenant. Provide x-mcpjam-workspace-id or a valid token subject.",
      },
      401,
    );
  }

  c.tenantId = tenantId;
  return next();
}
