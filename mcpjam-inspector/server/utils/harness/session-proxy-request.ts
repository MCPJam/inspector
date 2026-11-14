import type { SealedHarnessProxyPolicy } from "./harness-proxy-policy-seal.js";
import {
  verifyHarnessSessionHandle,
  type HarnessMcpProxyClaims,
} from "./harness-proxy-token.js";
import { authorizeSessionTurn } from "./proxy-turn.js";
import { sessionPolicyDigest } from "./session-mcp-config.js";

const unauthorized = () =>
  Response.json({ error: "Unauthorized" }, { status: 401 });

/**
 * A session envelope proves who the lane belongs to, never that a turn is
 * running. Every request also needs the lane's live turn, the policy and
 * profile that turn bound for this server, and the session grant the turn's
 * box egress injects: an envelope from an older configuration never runs under
 * a newer turn, and a copy sent from outside the box reaches nothing.
 */
export async function authorizeSessionRequest(
  sealed: SealedHarnessProxyPolicy,
  serverId: string,
  boxGrant: string | undefined,
): Promise<
  { claims: HarnessMcpProxyClaims; turnId: string; laneId: string } | Response
> {
  const handle = verifyHarnessSessionHandle(sealed.token, serverId);
  if (!handle || !sealed.profile || !boxGrant) return unauthorized();
  const turn = await authorizeSessionTurn({
    laneId: handle.laneId,
    userId: handle.userId,
    projectId: handle.projectId,
    serverId,
    boxGrant,
  });
  if (turn instanceof Response) return turn;
  if (
    turn.policyDigest !==
    sessionPolicyDigest(serverId, sealed.policy, sealed.profile)
  )
    return unauthorized();
  return {
    claims: {
      userId: handle.userId,
      externalId: handle.externalId,
      orgId: handle.orgId,
      projectId: handle.projectId,
      serverId,
    },
    turnId: turn.turnId,
    laneId: handle.laneId,
  };
}

/** Re-check before dispatch and before answering: the turn must not have moved on. */
export async function sameSessionTurn(
  sealed: SealedHarnessProxyPolicy,
  serverId: string,
  boxGrant: string | undefined,
  turnId: string,
): Promise<Response | undefined> {
  const again = await authorizeSessionRequest(sealed, serverId, boxGrant);
  if (again instanceof Response) return again;
  return again.turnId === turnId ? undefined : unauthorized();
}
