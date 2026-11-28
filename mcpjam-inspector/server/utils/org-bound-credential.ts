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

/**
 * How an org-bound caller's backend calls say who they act for: the token
 * the backend exchanged its `sk_` key for, when it has one
 * (`MCPJAM_TOKEN_EXCHANGE`), else acting-as for its user and organization.
 * `undefined` for every other caller, whose own bearer goes as it is.
 */
export function orgBoundActingAs(caller: {
  authMethod?: string;
  workosUserId?: string;
  mcpjamOrganizationId?: string;
  exchangedBearer?: string;
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
  return {
    workosUserId: caller.workosUserId,
    mcpjamOrganizationId: caller.mcpjamOrganizationId,
    ...(caller.exchangedBearer
      ? { exchangedBearer: caller.exchangedBearer }
      : {}),
  };
}
