import type { MCPClientManager } from "@mcpjam/sdk";
import type { RequestLogContext } from "../utils/log-events.js";

// Extend Hono's context with our custom variables
declare module "hono" {
  interface Context {
    mcpClientManager: MCPClientManager;
  }

  interface ContextVariableMap {
    guestId?: string;
    requestLogContext?: RequestLogContext;
    /**
     * Auth method used to resolve the caller. Set by `bearerAuthMiddleware`:
     * - `"workos_api_key"` — caller presented a platform `sk_mcpjam_…` API
     *   key (hashed and validated against the backend's platformApiKeys
     *   table). The literal keeps the WorkOS-era name so every downstream
     *   consumer stays untouched; there is no WorkOS call on this path.
     * - Absent — guest JWT (see `guestId`) or WorkOS AuthKit JWT.
     *
     * Downstream Convex callers (`authorizeBatch`) read this to decide
     * between forwarding the original bearer (JWT/guest) and exchanging
     * for `INSPECTOR_SERVICE_TOKEN` + `x-mcpjam-acting-as` (API key).
     */
    authMethod?: "workos_api_key";
    /** Platform API key id (Convex `Id<'platformApiKeys'>`). Set with `authMethod`. */
    workosApiKeyId?: string;
    /** The key owner's WorkOS externalId (users.externalId). Set with `authMethod`. */
    workosUserId?: string;
    /** Resolved MCPJam user `_id` (Convex). Set with `authMethod`. */
    mcpjamUserId?: string;
    /**
     * MCPJam organization id (Convex `Id<'organizations'>`) the platform API
     * key is scoped to (stored on its platformApiKeys row and returned by the
     * validate route). Set with `authMethod` by `bearerAuthMiddleware`.
     * Forwarded to Convex as `x-mcpjam-acting-in-org` by the
     * delegated-identity exchange.
     */
    mcpjamOrganizationId?: string;
  }
}
