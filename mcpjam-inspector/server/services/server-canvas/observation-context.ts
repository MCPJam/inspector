/**
 * The capture context of the connection that produced observed traffic,
 * built exactly as connect capture builds it: `buildCaptureContext` over the
 * manager's `getInitializationInfo` (negotiated version, transport, the
 * client capabilities MCPJam advertised) with the `captureAccountKey` rule.
 * So observations land under the hash a capture of the same connection would
 * have, whichever manager or Inspector instance carried them.
 */
import { computeCaptureContextHash, type MCPClientManager } from "@mcpjam/sdk";
import { getManagerConnections } from "../../utils/mcp-connections.js";
import { buildCaptureContext } from "./capture.js";
import { captureAccountKey } from "./connect-hook.js";

/** Connections remembered per helper before the memo starts over. */
const MAX_MEMOIZED_CONNECTIONS = 512;

/**
 * The project server and account behind a hosted manager key: the key is
 * the authorized server id, or an alias for one of that server's accounts.
 */
export function hostedConnectionOf(
  manager: MCPClientManager,
  managerKey: string,
): { serverId: string; accountKey?: string } {
  const groups = getManagerConnections(manager);
  if (!groups || groups[managerKey]) return { serverId: managerKey };
  for (const [serverId, group] of Object.entries(groups)) {
    const alias = group.find((connection) => connection.key === managerKey);
    if (alias) return { serverId, accountKey: alias.connectionId };
  }
  return { serverId: managerKey };
}

/** Memoized per connection; recomputed when its negotiation changes. */
export class LiveContextHashes {
  private readonly memo = new Map<
    string,
    { capabilities: unknown; signature: string; hash: string }
  >();

  /** Undefined until the connection has negotiated a protocol version. */
  hashFor(
    manager: MCPClientManager,
    managerKey: string,
    accountKey?: string,
  ): string | undefined {
    const info = manager.getInitializationInfo(managerKey);
    if (!info?.protocolVersion) return undefined;
    const account = captureAccountKey(manager, managerKey, accountKey);
    const signature = JSON.stringify([
      info.protocolVersion,
      info.transport,
      account ?? null,
    ]);
    const known = this.memo.get(managerKey);
    if (
      known &&
      known.signature === signature &&
      known.capabilities === info.clientCapabilities
    )
      return known.hash;
    const hash = computeCaptureContextHash(
      buildCaptureContext(info, account ? { accountKey: account } : {}),
    );
    if (this.memo.size >= MAX_MEMOIZED_CONNECTIONS) this.memo.clear();
    this.memo.set(managerKey, {
      capabilities: info.clientCapabilities,
      signature,
      hash,
    });
    return hash;
  }
}
