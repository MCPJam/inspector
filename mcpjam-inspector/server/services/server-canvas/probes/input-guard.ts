/**
 * Keeps a server's requests for user input away from the user while the
 * background probes read on its connection. Background probes stop when the
 * server asks for input; they never prompt anyone.
 *
 * On 2026-07-28 a server asks for input only inside a result
 * (`input_required`), which the Apps probe already abandons. On 2025 revisions
 * it can send `elicitation/create` while a probe's read is in flight, and the
 * MCP client gives no way to tell which outgoing request it belongs to: the
 * request handler gets no related request id, and the Streamable HTTP
 * transport hands a POST stream's messages on without naming the POST. So:
 *
 *   hosted  The ephemeral connection serves only this connect or refresh, so
 *           for the probe window every `elicitation/create` is declined
 *           without reaching any handler, and reads in flight when one
 *           arrives count as abandoned.
 *   local   The connection is shared with the user's own requests, which
 *           must keep reaching their handler. On a 2025 revision, or one not
 *           known, the probes send nothing that could prompt: no UI resource
 *           or skill reads, and no `events/list`.
 *
 * MCPJam never advertises sampling or roots, so the client refuses those
 * requests on its own.
 */
import type { CaptureContext, MCPClientManager } from "@mcpjam/sdk";

export const LOCAL_LEGACY_READS_SKIPPED =
  "MCPJam does not read UI resources in the background on this connection, since the server could ask you for input. Run checks to read them.";

export interface ProbeInputGuard {
  /** Whether the probes' reads (UI resources, skills, `events/list`) may run on this connection. */
  readsAllowed: boolean;
  /** Marks a read in flight; the returned function ends it and says whether the server asked for input meanwhile. */
  track(): () => boolean;
  /** Ends the window and gives the connection back its own handling. */
  release(): void;
}

type GuardedManager = Pick<
  MCPClientManager,
  "setElicitationHandler" | "clearElicitationHandler"
>;

export function guardProbeInput(target: {
  hosted: boolean;
  manager: GuardedManager;
  managerKey: string;
  context: CaptureContext;
}): ProbeInputGuard {
  const inFlight = new Set<{ asked: boolean }>();
  const track = () => {
    const entry = { asked: false };
    inFlight.add(entry);
    return () => {
      inFlight.delete(entry);
      return entry.asked;
    };
  };

  if (!target.hosted) {
    return {
      // Only 2026-07-28 has no server-to-client requests to tell apart.
      readsAllowed: target.context.era === "modern",
      track,
      release: () => undefined,
    };
  }

  // The ephemeral manager carries no server-specific handler of its own, so
  // clearing restores exactly what was there.
  target.manager.setElicitationHandler(target.managerKey, () => {
    for (const entry of inFlight) entry.asked = true;
    return { action: "decline" };
  });
  let released = false;
  return {
    readsAllowed: true,
    track,
    release: () => {
      if (released) return;
      released = true;
      target.manager.clearElicitationHandler(target.managerKey);
    },
  };
}
