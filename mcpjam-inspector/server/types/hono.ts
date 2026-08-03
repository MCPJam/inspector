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
     * Code + message from the last `webError()` on this request. Set so
     * `requestLogContextMiddleware` can record *why* a returned (non-thrown)
     * 5xx failed; without it the middleware only ever sees a status code.
     */
    webErrorMeta?: { status: number; code: string; message: string };
    /**
     * Auth method used to resolve the caller. Set by `bearerAuthMiddleware`:
     * - `"workos_api_key"` — caller presented a WorkOS `sk_…` API key
     *   (validated via `WorkOS.apiKeys.createValidation`).
     * - `"slack_service"` — the MCPJam Slack bot presented its `slk_…`
     *   service credential PLUS the Slack team/user headers, and that Slack
     *   user has a completed account link. The identity below is the LINKED
     *   user's, never the bot's: `slk_` names the bot and grants nothing on
     *   its own.
     * - Absent — guest JWT (see `guestId`) or WorkOS AuthKit JWT.
     *
     * `getConvexBearerForRequest` reads this to decide between forwarding the
     * original bearer (JWT/guest) and minting a delegated org-scoped JWT (both
     * non-JWT methods). Dispatching on this rather than on the presence of the
     * identity vars matters: a JWT caller can carry those too.
     *
     * `authorizeBatch` handles `workos_api_key` only. It is NOT on the
     * `slack_service` path — the allowlist in `slack-service-auth.ts` does not
     * admit any route that reaches it — and it would forward the `slk_` bearer
     * verbatim rather than exchanging it. Widening that allowlist means
     * teaching `authorizeBatch` about `slack_service` first.
     */
    authMethod?: "workos_api_key" | "slack_service";
    /** WorkOS API key id (e.g. `api_key_…`). Set with `authMethod`. */
    workosApiKeyId?: string;
    /** WorkOS user externalId. Set with `authMethod`. */
    workosUserId?: string;
    /** Resolved MCPJam user `_id` (Convex). Set with `authMethod`. */
    mcpjamUserId?: string;
    /**
     * MCPJam organization id (Convex `Id<'organizations'>`) the WorkOS API
     * key is bound to. Set with `authMethod` by `bearerAuthMiddleware` after
     * looking up the key's org binding. Forwarded to Convex as
     * `x-mcpjam-acting-in-org` by the delegated-identity exchange.
     */
    mcpjamOrganizationId?: string;
    /** Slack workspace id. Set only with `authMethod: "slack_service"`. */
    slackTeamId?: string;
    /** Slack user id of the acting human. Set with `slackTeamId`. */
    slackUserId?: string;
    /**
     * The linked user's default project, if they picked one. Advisory: the
     * route's `:projectId` still governs, and Convex still enforces access.
     */
    slackDefaultProjectId?: string;
  }
}
