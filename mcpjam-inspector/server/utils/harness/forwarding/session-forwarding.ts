/**
 * Native forwarding for a runtime that fingerprints its MCP configuration.
 *
 * The per-turn forwarding context names the turn and expires with its grant,
 * so it changes the configuration every turn. A session-stable runtime gets the
 * lane's session envelope instead, the same value on every turn. The turn's
 * authority lives elsewhere: the grant the egress proxy injects, and the policy
 * each owner binds on that grant for this turn.
 */
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  sealHarnessSessionEnvelope,
  type SealedHarnessProxyPolicy,
} from "../harness-proxy-policy-seal.js";
import { verifyHarnessSessionHandle } from "../harness-proxy-token.js";
import type { HarnessConnectionProfile } from "../harness-connection-profile.js";
import {
  bindSessionTurnHandles,
  sessionPolicyDigest,
  type HarnessSessionTurn,
} from "../session-mcp-config.js";
import {
  createExecutionControl,
  type ForwardingOwner,
} from "./execution-control.js";
import { forwardingToolPolicy } from "./native-policy.js";

/** Bind this turn on the lane and on each owner's grant; returns each server's headers. */
export async function sessionForwardingHeaders(args: {
  owners: ForwardingOwner[];
  session: HarnessSessionTurn;
  /** The turn the grant was installed for, which `bindPolicy` checks. */
  grantTurnId: string;
  policies?: Record<string, ToolPolicySnapshot>;
  bearer: string;
  /** Each server's connection profile on a bridged turn; none on pass-through. */
  profiles?: Record<string, HarnessConnectionProfile>;
}): Promise<Record<string, Record<string, string>>> {
  const servers = args.owners.map((owner) => {
    const policy = forwardingToolPolicy(args.policies?.[owner.serverId]);
    const profile = args.profiles?.[owner.serverId];
    return {
      owner,
      policy,
      profile,
      policyDigest: sessionPolicyDigest(owner.serverId, policy, profile),
    };
  });
  const handles = await bindSessionTurnHandles(
    args.session,
    servers.map(({ owner, policyDigest }) => ({
      serverId: owner.serverId,
      ...(owner.connectionId ? { connectionId: owner.connectionId } : {}),
      policyDigest,
    })),
    args.bearer,
  );
  const headers: Record<string, Record<string, string>> = {};
  for (const { owner, policy, profile, policyDigest } of servers) {
    await createExecutionControl({ owner }).bindPolicy(
      args.grantTurnId,
      policyDigest,
    );
    headers[owner.serverId] = {
      // Each turn's grant is a new injected credential, and E2B pins it to
      // the outbound connection.
      Connection: "close",
      "X-MCPJam-Forwarding-Context": sealHarnessSessionEnvelope({
        handle: handles[owner.serverId]!,
        serverId: owner.serverId,
        policy,
        ...(profile ? { profile, delivery: "bridge" as const } : {}),
      }),
    };
  }
  return headers;
}

/** The owner a session envelope names, the digest its turn must have bound,
 *  and whether MCPJam's client carries the server with the sealed profile. */
export function sessionForwardingContext(
  sealed: SealedHarnessProxyPolicy,
  serverId: string,
):
  | { owner: ForwardingOwner; policyDigest: string; delivery?: "bridge" }
  | undefined {
  const handle = verifyHarnessSessionHandle(sealed.token, serverId);
  if (!handle) return undefined;
  return {
    owner: {
      kind: "chat",
      userId: handle.userId,
      serverId,
      harnessSessionId: handle.laneId,
      ...(handle.connectionId ? { connectionId: handle.connectionId } : {}),
    },
    policyDigest: sessionPolicyDigest(serverId, sealed.policy, sealed.profile),
    ...(sealed.delivery ? { delivery: sealed.delivery } : {}),
  };
}
