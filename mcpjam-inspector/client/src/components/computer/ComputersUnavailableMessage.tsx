import { PaneMessage } from "./PaneMessage";

/**
 * The one honest empty state for `dataPlaneUnavailable` (no local data-plane
 * credentials AND discovery found no remote data plane to delegate to).
 *
 * Computers are cloud-only: an inspector gets them either by being an
 * MCPJam-deployed data plane or by delegating to one advertised by its Convex
 * deployment. Neither is something a user at this screen can change, so the
 * copy names the situation without instructing anyone to set server env vars
 * (operator setup lives in mcpjam-backend docs/project-computers.md).
 */
export function ComputersUnavailableMessage() {
  return (
    <PaneMessage dashed>
      <span className="max-w-md text-center">
        Computers aren't available here — the MCPJam deployment this inspector
        is connected to hasn't enabled Project Computers, so the terminal and
        the bash tool are off.
      </span>
    </PaneMessage>
  );
}
