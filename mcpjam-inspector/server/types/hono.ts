import type { ErrorOrigin, MCPClientManager } from "@mcpjam/sdk";
import type { RequestLogContext } from "../utils/log-events.js";
import type { RouteFailureHop } from "../utils/route-error-report.js";

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
     *
     * `origin`/`slug` are present whenever the failing route had a normalized
     * describe-error block. They make `http.request.failed` sliceable by whose
     * fault a failure was, which is what lets the Sentry capture policy stay
     * narrow: `ambiguous` volume stays visible in Axiom without paying for it
     * in issue-tracker noise.
     */
    webErrorMeta?: {
      status: number;
      code: string;
      message: string;
      origin?: ErrorOrigin;
      slug?: string;
      /**
       * Which hop the failure came off, when the catch site declared one.
       * Orthogonal to `origin` — see the field docs on
       * `http.request.failed` in `log-events.ts`. Absent means unknown.
       */
      hop?: RouteFailureHop;
    };
    /**
     * Auth method used to resolve the caller. Set by `bearerAuthMiddleware`:
     * - `"workos_api_key"` — caller presented a WorkOS `sk_…` API key
     *   (validated via `WorkOS.apiKeys.createValidation`).
     * - `"slack_service"` — the MCPJam Slack bot presented its `slk_…`
     *   service credential PLUS the Slack team/user headers, and that Slack
     *   user has a completed account link. The identity below is the LINKED
     *   user's, never the bot's: `slk_` names the bot and grants nothing on
     *   its own.
     * - `"discord_service"` — the Discord bot's `dsc_…` credential, resolving
     *   to a linked user by the same rule as `slack_service`.
     * - `"guest"` — a VALIDATED guest JWT. `guestId` is set alongside.
     * - `"unverified_passthrough"` — a bearer that LOOKED like a WorkOS AuthKit
     *   JWT and was let through unverified, on the expectation that Convex
     *   checks it downstream. Not an authenticated caller. See
     *   `middleware/require-verified-auth.ts`.
     * - Absent — no bearer at all, or one this middleware did not classify.
     *
     * The last two are the ones to be careful with: a value being present here
     * does NOT mean the caller was authenticated. Anything deciding trust must
     * name the methods it accepts rather than testing for presence.
     *
     * `getConvexBearerForRequest` reads this to decide between forwarding the
     * original bearer (JWT/guest) and minting a delegated org-scoped JWT (both
     * non-JWT methods). Dispatching on this rather than on the presence of the
     * identity vars matters: a JWT caller can carry those too.
     *
     * `authorizeBatch` handles `workos_api_key` only, and would forward a
     * `slk_` bearer to Convex VERBATIM rather than exchanging it. Allowlisted
     * Slack routes do reach it — `POST /eval-runs` does — but they reach it
     * with a delegated JWT already minted by `getConvexBearerForRequest`, so
     * the raw `slk_` never arrives there. That is the invariant: not "no Slack
     * route touches `authorizeBatch`", but "no Slack route hands it the bot
     * credential". A new allowlisted route that passes the ORIGINAL bearer
     * through would break it, so teach `authorizeBatch` about `slack_service`
     * before adding one.
     */
    authMethod?:
      | "workos_api_key"
      | "slack_service"
      | "discord_service"
      // RESERVED, and currently UNREACHABLE: `surface-service-auth.ts` no
      // longer accepts `"teams"`, so no branch assigns this. Kept so a future
      // Teams gate is an additive change — but it must not appear in any
      // allowlist while nothing can produce it.
      | "teams_service"
      // A validated guest JWT. `guestId` is set alongside.
      | "guest"
      // ASSERTED, NOT VERIFIED. The bearer looked like a WorkOS AuthKit JWT
      // and `bearerAuthMiddleware` let it through without checking the
      // signature, because the routes it normally fronts forward the bearer to
      // Convex, which does check it. A route that does NOT forward the bearer
      // must not trust this — see `middleware/require-verified-auth.ts`.
      | "unverified_passthrough";
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
    /**
     * WHICH CHAT SURFACE this request came from, if any.
     *
     * The canonical trio (`surfaceKind`/`surfaceTenantId`/`surfaceActorId`) is
     * what routes read. It is set by whichever auth branch identified the
     * caller — today only the `slk_` branch, which sets it alongside the Slack
     * vars below — so a second wrapper is a new auth branch populating the
     * same three names, with zero route surgery.
     *
     * The distinction from `mcpjamOrganizationId`/`workosUserId` matters:
     * those are the MCPJam identity the surface actor RESOLVED TO. These three
     * are the surface's own id space, which is what a proposal must be keyed
     * and re-checked on — the person who clicks a button is identified by
     * their Slack/Discord id long before they are identified as a MCPJam user.
     */
    surfaceKind?: "slack" | "discord" | "teams";
    /** Workspace / guild / server id inside `surfaceKind`. */
    surfaceTenantId?: string;
    /** The acting human's id inside `surfaceKind`. */
    surfaceActorId?: string;
    /**
     * The linked user's default project, if they picked one. Advisory: the
     * route's `:projectId` still governs, and Convex still enforces access.
     */
    slackDefaultProjectId?: string;
  }
}
