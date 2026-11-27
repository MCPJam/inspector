export const LOCAL_EVENTS_HOOKS_PATH = "/api/mcp/events/hooks";
export const LOCAL_EVENTS_HOOK_ROUTE = "/hooks/:serverId/i/:inboxId/s/:slotId";

/** Escape dot segments so URL parsers preserve the server's name. */
export function localEventsServerSegment(serverId: string): string {
  return serverId === "." || serverId === ".." || serverId.startsWith("~")
    ? `~${serverId}`
    : serverId;
}

/** Keep the Host exception confined to the signed receiver's POST route. */
export function isLocalEventsHookPost(method: string, path: string): boolean {
  return method === "POST" &&
    /^\/api\/mcp\/events\/hooks\/[^/]+\/i\/[a-z2-7]+\/s\/[a-z2-7]+$/.test(path);
}
