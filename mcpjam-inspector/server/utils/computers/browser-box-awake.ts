import type { ComputerSandboxInfo } from "./control-plane-client.js";

/**
 * Is the box behind a hosted browser running?
 *
 * A computer runs when `ready` and a conversation sandbox when `live`. Any
 * other status means its daemon is not answering, and only `ensure=1` on the
 * panel's session route wakes it. Read from the status the ownership check
 * already fetched, so asking costs nothing.
 */
export function browserBoxAwake(
  target: { computerId?: string; sandboxRowId?: string },
  status: ComputerSandboxInfo["status"] | undefined,
): boolean {
  return status === (target.computerId ? "ready" : "live");
}
