import type { MCPClientManager } from "@mcpjam/sdk";

type ListTools = MCPClientManager["listTools"];

/**
 * One `tools/list` per server while a turn prepares its tools.
 *
 * The session API reads each server's tools to apply its tool policy, then
 * `prepareChatV2` reads them again to build the model's tool set. Both reads
 * reach the server through `MCPClientManager.listTools`, so until `end()` a
 * plain listing of a server (no cursor, no request options) is answered by
 * the listing already made for it. The second round trip goes away, and the
 * policy is decided on exactly the tools the model is handed. A listing that
 * fails is not kept, so the next one asks the server again.
 *
 * Only for a manager the turn created for itself and tears down at its end.
 * `end()` restores the manager's own `listTools` and may be called again.
 */
export function shareToolListing(manager: MCPClientManager): { end(): void } {
  const own = Object.getOwnPropertyDescriptor(manager, "listTools");
  const list: ListTools = manager.listTools;
  const listed = new Map<string, ReturnType<ListTools>>();
  manager.listTools = (serverId, params, options) => {
    if (params !== undefined || options !== undefined) {
      return list.call(manager, serverId, params, options);
    }
    const shared = listed.get(serverId);
    if (shared) return shared;
    const listing = list.call(manager, serverId);
    listed.set(serverId, listing);
    listing.then(undefined, () => listed.delete(serverId));
    return listing;
  };
  return {
    end() {
      if (own) Object.defineProperty(manager, "listTools", own);
      else Reflect.deleteProperty(manager, "listTools");
    },
  };
}
