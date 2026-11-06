/**
 * The route receipt a harness turn trace carries (`turnTrace.harnessMcpAtTurn`).
 *
 * The planner decides who talks to the server and how the tools arrive. Whose
 * handshake MCPJam's client performed is read here from the connection the
 * runner actually built, never inferred from a route label:
 *
 *  - host tools run on the turn's own manager: the client's hostConfig.
 *  - the hosted rebuild proxy replays the profile sealed into each proxy token
 *    from this manager (`initializePins`): the client's hostConfig.
 *  - the local loopback plane serves this manager directly: the client's.
 *  - profiled forwarding seals profiles built from this manager: the client's.
 *  - the `local-mcp` plane tunnels to the persistent manager, which the turn
 *    cannot vouch for, so the receipt says so instead of guessing.
 *  - pass-through forwarding: the harness's own handshake, no profile.
 *
 * `generic` (a profile-less endpoint) is part of the receipt vocabulary, but no
 * current runner path builds one. `observedRuntimeVersion` exists only for
 * adapters that report their installed CLI, which today is Cursor alone.
 */
import {
  parseHarnessMcpAtTurn,
  type HarnessMcpAtTurn,
} from "@mcpjam/sdk/host-config/internal";
import {
  HARNESS_MCP_PLANNER_VERSION,
  type HarnessMcpPlan,
} from "./harness-mcp-plan.js";
import type { HarnessMcpProxyStrategy } from "./harness-proxy-strategy.js";

export const LOCAL_MCP_PROFILE_REASON =
  "local-mcp plane: handshake owned by the persistent manager";
const NO_SERVERS_REASON = "no servers selected";

export type HarnessMcpConnectionFacts = {
  /** The plane the turn's MCP endpoint was built on. */
  plane: HarnessMcpProxyStrategy["plane"];
  serverCount: number;
  /** `harnessConnectionFingerprint` over the selected servers. */
  profileDigest: () => string;
};

function handshakeOwner(
  plan: HarnessMcpPlan,
  connection: HarnessMcpConnectionFacts,
): { profile?: "client"; reason?: string } {
  if (plan.upstream === "harness") return {};
  if (connection.serverCount === 0) return { reason: NO_SERVERS_REASON };
  if (plan.delivery === "host-tools" || plan.forwardingKind === "profiled") {
    return { profile: "client" };
  }
  return connection.plane === "local-mcp"
    ? { reason: LOCAL_MCP_PROFILE_REASON }
    : { profile: "client" };
}

/** A digest the profile schema refuses leaves the receipt without one. */
function digestOf(connection: HarnessMcpConnectionFacts): string | undefined {
  try {
    return connection.profileDigest();
  } catch {
    // Diagnostic only: a server config the profile schema rejects must not
    // fail the turn over its receipt, and the profile claim still stands.
    return undefined;
  }
}

export function buildHarnessMcpAtTurn(args: {
  plan: HarnessMcpPlan;
  connection: HarnessMcpConnectionFacts;
  pinnedRuntimeVersion: string | undefined;
  observedRuntimeVersion: string | undefined;
  adapterVersion: string | undefined;
  requireNativeToolDiscovery: boolean;
}): HarnessMcpAtTurn | undefined {
  const { plan } = args;
  const owner = handshakeOwner(plan, args.connection);
  const reasons: string[] = [...plan.reasons];
  if (owner.reason && !reasons.includes(owner.reason))
    reasons.push(owner.reason);
  const digest = owner.profile ? digestOf(args.connection) : undefined;
  // Reaching the stream with required discovery means the gate found every
  // server supported; otherwise nothing was asked.
  const status = args.requireNativeToolDiscovery ? "supported" : "not-required";
  return parseHarnessMcpAtTurn({
    version: 1,
    upstream: plan.upstream,
    delivery: plan.delivery,
    ...(owner.profile ? { profile: owner.profile } : {}),
    ...(plan.forwardingKind
      ? { forwarding: { kind: plan.forwardingKind } }
      : {}),
    gaps: plan.gaps,
    reasons,
    pinnedRuntimeVersion: args.pinnedRuntimeVersion ?? "",
    ...(args.observedRuntimeVersion
      ? { observedRuntimeVersion: args.observedRuntimeVersion }
      : {}),
    ...(args.adapterVersion ? { adapterVersion: args.adapterVersion } : {}),
    plannerVersion: HARNESS_MCP_PLANNER_VERSION,
    qualification: { status },
    ...(digest ? { profileDigest: digest } : {}),
  });
}
