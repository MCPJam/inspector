import { logger } from "./logger.js";

/**
 * Credentials that act as exactly one MCPJam user inside exactly one
 * organization, with no Convex-verifiable bearer of their own:
 *
 * - `workos_api_key`: an `sk_…` key, bound to an org when it was minted.
 * - `workos_agent`: an AuthKit agent-registration token (auth.md), bound to
 *   the org its user chose when approving the agent.
 *
 * Code that must treat both alike (delegated-identity exchange, persistence
 * rechecks, harness labels) asks this instead of comparing against one label,
 * so a third org-bound credential is one edit here.
 */
export function isOrgBoundCredential(
  method: string | undefined,
): method is "workos_api_key" | "workos_agent" {
  return method === "workos_api_key" || method === "workos_agent";
}

/** Below this much life left, an exchanged token is not sent. */
export const EXCHANGED_BEARER_MIN_REMAINING_MS = 30_000;

/**
 * The token the backend exchanged an `sk_` key for, while it has at least
 * 30 s left. It lasts at most 10 minutes and can't be renewed, because the
 * raw key isn't kept, so work that outlives it (a caller context or request
 * kept for later) takes acting-as again, as it would with the switch off.
 * I4b gives that background work grants instead.
 */
export function usableExchangedBearer(
  holder: { exchangedBearer?: string; exchangedBearerExpiresAt?: number },
  now = Date.now(),
): string | undefined {
  if (!holder.exchangedBearer) return undefined;
  const remainingMs = (holder.exchangedBearerExpiresAt ?? 0) - now;
  if (remainingMs >= EXCHANGED_BEARER_MIN_REMAINING_MS) {
    return holder.exchangedBearer;
  }
  logger.info("Exchanged API key token near expiry; using acting-as", {
    event: "auth.exchanged_token_fallback",
    remaining_ms: remainingMs,
  });
  return undefined;
}

/**
 * How an org-bound caller's backend calls say who they act for: the token
 * the backend exchanged its `sk_` key for, while it is usable
 * (`MCPJAM_TOKEN_EXCHANGE`), else acting-as for its user and organization.
 * `undefined` for every other caller, whose own bearer goes as it is.
 */
export function orgBoundActingAs(caller: {
  authMethod?: string;
  workosUserId?: string;
  mcpjamOrganizationId?: string;
  exchangedBearer?: string;
  exchangedBearerExpiresAt?: number;
}):
  | {
      workosUserId: string;
      mcpjamOrganizationId: string;
      exchangedBearer?: string;
    }
  | undefined {
  if (
    !isOrgBoundCredential(caller.authMethod) ||
    !caller.workosUserId ||
    !caller.mcpjamOrganizationId
  ) {
    return undefined;
  }
  const exchangedBearer = usableExchangedBearer(caller);
  return {
    workosUserId: caller.workosUserId,
    mcpjamOrganizationId: caller.mcpjamOrganizationId,
    ...(exchangedBearer ? { exchangedBearer } : {}),
  };
}
