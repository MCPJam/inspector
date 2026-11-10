/**
 * MCP configuration that stays identical for a whole harness session.
 *
 * Cursor's ACP adapter fingerprints its MCP servers, header values included,
 * and refuses to resume when they change. A per-turn proxy token in that
 * config ends the session every turn. So a runtime that declares
 * `sessionStableMcpConfig` gets, per server, an envelope that seals the lane's
 * session handle (minted by the backend, deterministic, no expiry) with the
 * server's policy and profile. The turn's own authority is bound on the backend
 * instead (`bind-turn`), and the proxy route checks it on every request.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  harnessConnectionProfile,
  type HarnessConnectionProfile,
} from "./harness-connection-profile.js";
import { forwardingToolPolicy, nativePolicyDigest } from "./forwarding/native-policy.js";
import { sealHarnessSessionEnvelope } from "./harness-proxy-policy-seal.js";
import {
  resolveHarnessProxyUrl,
  type HarnessMcpProxyStrategy,
} from "./harness-proxy-strategy.js";
import {
  bindHarnessSessionTurn,
  type HarnessOwnerRef,
} from "./harness-session-state.js";
import type { HarnessProxyServerInput } from "./mcp-config.js";
import { logger } from "../logger.js";

/** The turn a session-stable configuration is being used for. */
export type HarnessSessionTurn = {
  owner: HarnessOwnerRef;
  leaseId: string;
  turnId: string;
};

/**
 * What a turn binds per server, and what the proxy recomputes from the envelope
 * it receives: a changed policy or profile cannot ride an older envelope.
 */
export function sessionPolicyDigest(
  serverId: string,
  policy: ToolPolicySnapshot,
  profile: HarnessConnectionProfile,
): string {
  return nativePolicyDigest({ [serverId]: policy }, { profile });
}

/** Signed-proxy inputs for the session: the same envelope on every turn. */
export async function sessionProxyInputs(args: {
  manager: MCPClientManager;
  serverIds: string[];
  strategy: HarnessMcpProxyStrategy;
  authHeader: string;
  toolPolicy?: Record<string, ToolPolicySnapshot>;
  session: HarnessSessionTurn;
}): Promise<HarnessProxyServerInput[]> {
  const servers = args.serverIds.map((serverId) => {
    const policy = forwardingToolPolicy(args.toolPolicy?.[serverId]);
    const profile = harnessConnectionProfile(args.manager, serverId);
    return {
      serverId,
      policy,
      profile,
      policyDigest: sessionPolicyDigest(serverId, policy, profile),
    };
  });
  const bound = await bindHarnessSessionTurn({
    ...args.session,
    servers: servers.map(({ serverId, policyDigest }) => ({
      serverId,
      policyDigest,
    })),
    bearer: args.authHeader,
  });
  if (!bound.ok) {
    logger.warn("[harness] session turn binding failed", {
      status: bound.status,
      error: bound.error,
    });
    throw new Error(
      "Couldn't connect this turn to its chat session. Send your message again.",
    );
  }
  return Promise.all(
    servers.map(async ({ serverId, policy, profile }) => ({
      name: serverId,
      proxyUrl: await resolveHarnessProxyUrl({
        strategy: args.strategy,
        serverId,
        authHeader: args.authHeader,
      }),
      sealedProxyToken: sealHarnessSessionEnvelope({
        handle: bound.handles[serverId]!,
        serverId,
        policy,
        profile,
      }),
    })),
  );
}
