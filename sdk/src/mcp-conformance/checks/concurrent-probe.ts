/**
 * The request Multiple POST Streams and Functional SSE Streams send three
 * times at once on a 2025-era session.
 *
 * Any request would test "accepts concurrent POSTs", but it has to be one the
 * server agreed to: "Both parties MUST ... only use capabilities that were
 * successfully negotiated" (a SHOULD in 2025-03-26). So it is the listing of a
 * capability the server's `initialize` answer declared, and a `ping`, which
 * needs no capability, when it declared none of them.
 */

/**
 * The listing each server capability lets a client send. In this order, so a
 * server that declares tools is probed the way it always was.
 */
const LISTING_BY_CAPABILITY = [
  ["tools", "tools/list"],
  ["prompts", "prompts/list"],
  ["resources", "resources/list"],
] as const;

export interface ConcurrentProbe {
  /** The JSON-RPC method the probes send. */
  method: string;
  /** The declared capability that allows it. Absent for the `ping` fallback. */
  capability?: string;
  /** The request body for one of the concurrent probes. */
  body: (id: number) => Record<string, unknown>;
}

/**
 * Pick the probe from the `capabilities` of an `initialize` answer, as sent.
 * A capability counts as declared when its key is present and not null; an
 * answer with no `capabilities` object declares nothing.
 */
export function concurrentProbe(capabilities: unknown): ConcurrentProbe {
  const declared =
    capabilities !== null && typeof capabilities === "object"
      ? (capabilities as Record<string, unknown>)
      : {};
  for (const [capability, method] of LISTING_BY_CAPABILITY) {
    const value = declared[capability];
    if (value !== undefined && value !== null) {
      return {
        method,
        capability,
        // A listing takes (empty) params.
        body: (id) => ({ jsonrpc: "2.0", id, method, params: {} }),
      };
    }
  }
  return {
    method: "ping",
    // A ping takes none.
    body: (id) => ({ jsonrpc: "2.0", id, method: "ping" }),
  };
}

/**
 * Why Functional SSE Streams has nothing to grade when the probe was the
 * `ping` fallback and every answer was JSON. A ping is not a request a server
 * streams, and it was only sent because the server declared nothing to list,
 * so JSON answers to it show nothing about SSE either way. A pass would claim
 * SSE works without having seen a stream.
 */
export const PING_ANSWERED_AS_JSON =
  "The server declares no tools, prompts or resources, so the probe was a ping, and it was answered as JSON. No SSE stream was opened to check.";
