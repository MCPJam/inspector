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
     * - `"workos_api_key"` — caller presented a WorkOS `sk_…` API key
     *   (validated via `WorkOS.apiKeys.createValidation`).
     * - Absent — guest JWT (see `guestId`) or WorkOS AuthKit JWT.
     *
     * Downstream Convex callers (`authorizeBatch`) read this to decide
     * between forwarding the original bearer (JWT/guest) and exchanging
     * for `INSPECTOR_SERVICE_TOKEN` + `x-mcpjam-acting-as` (API key).
     */
    authMethod?: "workos_api_key";
    /** WorkOS API key id (e.g. `api_key_…`). Set with `authMethod`. */
    workosApiKeyId?: string;
    /** WorkOS user externalId. Set with `authMethod`. */
    workosUserId?: string;
    /** Resolved MCPJam user `_id` (Convex). Set with `authMethod`. */
    mcpjamUserId?: string;
  }
}
