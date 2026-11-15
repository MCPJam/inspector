/**
 * Cancellation for calls on the signed proxy's session route.
 *
 * Cursor's MCP client gives up on a call after 60 seconds and sends
 * `notifications/cancelled` as a separate request, leaving the call's own
 * request open. The proxy is stateless, so only the instance running the call
 * can stop it: a cancel that reaches that instance aborts the call, and
 * MCPJam's MCP client then sends the server its own cancel. A cancel that lands
 * on another instance cannot reach the call, which then runs to completion.
 */
const running = new Map<string, AbortController>();

function callKey(laneId: string, serverId: string, rpcId: string | number) {
  return JSON.stringify([laneId, serverId, rpcId]);
}

/** Track one call until it settles, so a cancel for it can stop it. */
export function trackSessionCall(
  laneId: string,
  serverId: string,
  rpcId: string | number,
): { signal: AbortSignal; done: () => void } {
  const key = callKey(laneId, serverId, rpcId);
  const controller = new AbortController();
  running.set(key, controller);
  return {
    signal: controller.signal,
    done: () => {
      if (running.get(key) === controller) running.delete(key);
    },
  };
}

/** Stop the call a client cancelled; true when it was running here. */
export function cancelSessionCall(
  laneId: string,
  serverId: string,
  rpcId: string | number,
): boolean {
  const controller = running.get(callKey(laneId, serverId, rpcId));
  controller?.abort(new Error("The client cancelled this request."));
  return controller !== undefined;
}
