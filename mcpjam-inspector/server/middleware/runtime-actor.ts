import type { Context, Next } from "hono";
import { HOSTED_MODE } from "../config";
import {
  tenantActorRegistry,
  type RuntimeTier,
} from "../services/runtime/tenant-actor-registry";

function parseDedicatedTenants(): Set<string> {
  const value = process.env.MCPJAM_DEDICATED_TENANTS;
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function resolveTier(tenantId: string): RuntimeTier {
  const dedicatedTenants = parseDedicatedTenants();
  return dedicatedTenants.has(tenantId) ? "dedicated" : "shared";
}

/**
 * Resolves runtime actor for /api/mcp routes.
 * In hosted mode this isolates each tenant into a distinct actor.
 */
export async function runtimeActorMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (!HOSTED_MODE || !c.req.path.startsWith("/api/mcp/")) {
    return next();
  }

  if (c.req.path === "/api/mcp/health") {
    return next();
  }

  const tenantId = c.tenantId || "unknown-tenant";
  const tier = resolveTier(tenantId);
  const actor = tenantActorRegistry.getOrCreateActor(tenantId, tier);
  actor.lastSeenAt = Date.now();

  c.runtimeActor = actor;
  c.mcpClientManager = actor.mcpClientManager;
  c.tenantId = tenantId;

  return next();
}
