/**
 * Resolve who a WorkOS agent-registration token (auth.md) acts for.
 *
 * The token names the registration in `sub`, the approving WorkOS user in
 * `act.sub` and the WorkOS organization they chose in `org_id`. This maps the
 * user and the organization to their MCPJam records, so the caller can be
 * handled like an org-bound `sk_…` key: a delegated identity for that user,
 * confined to that organization. Org membership itself is checked downstream,
 * where the delegated token is minted and on every org-scoped Convex call.
 */

import type { AgentRegistrationClaim } from "./authkit-jwt.js";
import { resolveUserByExternalId } from "./identity.js";
import { isServiceCredentialUnavailableError } from "./service-credential.js";
import { resolveOrganizationByWorkosId } from "./slack-backend.js";

export type AgentRegistrationRefusalReason =
  | "AGENT_NOT_CLAIMED"
  | "AGENT_ORG_MISSING"
  | "AGENT_USER_UNKNOWN"
  | "AGENT_ORG_UNLINKED"
  | "LOOKUP_FAILED"
  | "SERVICE_CREDENTIAL_UNAVAILABLE";

/** The token claims the caller is resolved from, kept for mid-turn rechecks. */
export interface AgentRegistrationClaims extends AgentRegistrationClaim {
  workosOrganizationId?: string;
}

export type AgentRegistrationCaller =
  | {
      ok: true;
      registrationId: string;
      workosUserId: string;
      mcpjamUserId: string;
      mcpjamOrganizationId: string;
    }
  | {
      ok: false;
      reason: AgentRegistrationRefusalReason;
      /** The lookup failure, for the caller to log. */
      error?: unknown;
    };

/** The feature named when this server cannot resolve agents at all (self-hosted). */
export const AGENT_REGISTRATION_FEATURE = "Using an agent that signed in through auth.md";

/** What the caller of a refused agent request is told, by reason. */
export const AGENT_REFUSAL_MESSAGES: Record<
  AgentRegistrationRefusalReason,
  string
> = {
  AGENT_NOT_CLAIMED:
    "This agent has not been approved by a user. Finish the approval step, then request a new token.",
  AGENT_ORG_MISSING:
    "This agent was approved without an organization. Approve it again and choose an organization.",
  AGENT_USER_UNKNOWN:
    "The person who approved this agent has no MCPJam account. Sign in to MCPJam once, then request a new token.",
  AGENT_ORG_UNLINKED:
    "The organization chosen for this agent is not set up in MCPJam. Approve the agent again and choose another organization.",
  LOOKUP_FAILED:
    "Could not confirm who this agent acts for. Try the request again.",
  SERVICE_CREDENTIAL_UNAVAILABLE:
    "Could not confirm who this agent acts for. Try the request again.",
};

function lookupFailure(error: unknown): AgentRegistrationCaller {
  return {
    ok: false,
    reason: isServiceCredentialUnavailableError(error)
      ? "SERVICE_CREDENTIAL_UNAVAILABLE"
      : "LOOKUP_FAILED",
    error,
  };
}

export async function resolveAgentRegistrationCaller(
  claims: AgentRegistrationClaims,
): Promise<AgentRegistrationCaller> {
  const { registrationId, userId, workosOrganizationId } = claims;
  if (!userId) return { ok: false, reason: "AGENT_NOT_CLAIMED" };
  if (!workosOrganizationId) return { ok: false, reason: "AGENT_ORG_MISSING" };

  const [user, organization] = await Promise.allSettled([
    resolveUserByExternalId(userId),
    resolveOrganizationByWorkosId(workosOrganizationId),
  ]);
  // The user lookup first: it is the one that reports a missing service
  // credential, which gets its own answer.
  if (user.status === "rejected") return lookupFailure(user.reason);
  if (organization.status === "rejected") {
    return lookupFailure(organization.reason);
  }
  if (!user.value) return { ok: false, reason: "AGENT_USER_UNKNOWN" };
  if (!organization.value) return { ok: false, reason: "AGENT_ORG_UNLINKED" };

  return {
    ok: true,
    registrationId,
    workosUserId: userId,
    mcpjamUserId: user.value._id,
    mcpjamOrganizationId: organization.value.organizationId,
  };
}
