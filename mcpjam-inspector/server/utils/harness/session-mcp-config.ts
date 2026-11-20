/**
 * MCP configuration that stays the same for a whole harness chat lane.
 *
 * Every runtime on a chat lane gets, per server, an envelope that seals the
 * lane's session handle (minted by the backend, deterministic, no expiry) with
 * the server's policy and profile. The turn's own authority is bound on the
 * backend instead (`bind-turn`), and the proxy route checks it, with the
 * session grant the box's egress injects, on every request. So an agent kept
 * running between messages, or paused on an approval, never needs new
 * credentials: Cursor's ACP adapter refuses to resume a changed configuration,
 * and GitHub Copilot CLI keeps the headers its session started with.
 */
import { createHash } from "node:crypto";
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
  type HarnessSessionTurnServer,
} from "./harness-session-state.js";
import type { HarnessProxyServerInput } from "./mcp-config.js";
import { toolCatalogFingerprint } from "./codex-appserver/shared/turn-fingerprint.js";
import { logger } from "../logger.js";

import { HARNESS_TOOL_CATALOG_QUERY } from "./harness-proxy-limits.js";
export { HARNESS_TOOL_CATALOG_QUERY };

/**
 * A short version of the tools MCPJam's client lists on `serverId`. A lane's
 * configuration otherwise stays the same across turns, and MCPJam's proxies
 * pass no `list_changed` on, so a runtime that reconnects, reloads or restarts
 * only when its configuration changes would keep the tools it first listed.
 * Undefined when the server cannot list right now: the entry then drops the
 * version, which changes its configuration the way a new version would.
 */
export async function toolCatalogVersion(
  manager: Pick<MCPClientManager, "listTools">,
  serverId: string,
): Promise<string | undefined> {
  try {
    const { tools } = await manager.listTools(serverId);
    return createHash("sha256")
      .update(toolCatalogFingerprint(tools))
      .digest("hex")
      .slice(0, 16);
  } catch (error) {
    logger.warn("[harness] tool catalog version unavailable", {
      serverId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

function withQueryParam(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
}

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
  profile?: HarnessConnectionProfile,
): string {
  // Over the profile as every instance reads it from an envelope: the
  // negotiation rides outside it, where instances that predate it never look.
  const { versionNegotiation: _outside, ...shared } = profile ?? {};
  return nativePolicyDigest(
    { [serverId]: policy },
    { profile: profile && shared },
  );
}

/** Bind the turn to its lane's lease; returns each server's session handle. */
export async function bindSessionTurnHandles(
  session: HarnessSessionTurn,
  servers: HarnessSessionTurnServer[],
  bearer: string,
): Promise<Record<string, string>> {
  const bound = await bindHarnessSessionTurn({ ...session, servers, bearer });
  if (!bound.ok) {
    logger.warn("[harness] session turn binding failed", {
      status: bound.status,
      error: bound.error,
    });
    throw new Error(
      "Couldn't connect this turn to its chat session. Send your message again.",
    );
  }
  return bound.handles;
}

/**
 * Signed-proxy inputs for the session: the same envelope on every turn. A
 * runtime that fingerprints its configuration gets nothing else; any other
 * runtime's entries also carry each server's tool-catalog version and close
 * every connection, because its agent can outlive the turn (`closeConnection`).
 */
export async function sessionProxyInputs(args: {
  manager: MCPClientManager;
  serverIds: string[];
  strategy: HarnessMcpProxyStrategy;
  authHeader: string;
  toolPolicy?: Record<string, ToolPolicySnapshot>;
  session: HarnessSessionTurn;
  fingerprinted?: boolean;
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
  const handles = await bindSessionTurnHandles(
    args.session,
    servers.map(({ serverId, policyDigest }) => ({ serverId, policyDigest })),
    args.authHeader,
  );
  return Promise.all(
    servers.map(async ({ serverId, policy, profile }) => {
      const proxyUrl = await resolveHarnessProxyUrl({
        strategy: args.strategy,
        serverId,
        authHeader: args.authHeader,
      });
      const sealedProxyToken = sealHarnessSessionEnvelope({
        handle: handles[serverId]!,
        serverId,
        policy,
        profile,
      });
      if (args.fingerprinted)
        return { name: serverId, proxyUrl, sealedProxyToken };
      const version = await toolCatalogVersion(args.manager, serverId);
      return {
        name: serverId,
        proxyUrl: version
          ? withQueryParam(proxyUrl, HARNESS_TOOL_CATALOG_QUERY, version)
          : proxyUrl,
        sealedProxyToken,
        closeConnection: true as const,
      };
    }),
  );
}
