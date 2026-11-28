/**
 * Where observed feature ids come from and when they are flushed.
 *
 * Each observation is filed under the capture context of the connection that
 * carried it, computed from that connection's manager when the frame arrives
 * (`observation-context.ts`), so it never depends on which Inspector instance
 * captured the server or on what that capture negotiated.
 *
 * Local: the one long-lived manager reports into a process-wide buffer. Its
 * keys map to project servers through the scope the local connect registered.
 * A later `/api/mcp/*` request that carries a bearer flushes the buffer with
 * that bearer, at most once per interval; no bearer is kept between requests.
 * Observations still buffered when the process exits are lost, which costs
 * evidence the next use of the server records again, never user data.
 *
 * Hosted: an authorized manager gets its own observer only when it serves a
 * user's interactive session (`createAuthorizedManager`'s `observeFeatures`:
 * chat, and the Inspector's own tool, resource and prompt calls). Evals,
 * checks, bench, simulations and other automated runs are MCPJam's own
 * traffic and record nothing. The observer is keyed by the project server ids
 * the manager authorized, and flushes on a timer with the bearer it was
 * authorized with.
 *
 * The hosted buffer is per manager, and most managers live for one request,
 * so the interval rarely merges requests: it is one write per manager per
 * target, and the interval only batches a long-lived manager (a chat turn).
 * That is deliberate. A buffer shared across requests would need a bearer
 * that outlives the requests it came from; each manager's bearer is scoped to
 * its request and is kept at most one interval past its last observation. A
 * graceful shutdown flushes the buffers still inside their interval
 * ({@link flushPendingHostedObservations}); a crash or a kill loses them,
 * which, as locally, costs evidence the next use records again.
 *
 * MCPJam's own traffic is kept out: the SDK manager pauses observation for
 * its handshake, and the connect inspection, Refresh and background probes
 * run with their connection paused (`suppressFeatureObservation`).
 *
 * Every flush rechecks the `server-canvas` rollout for the flushing identity
 * through `resolveServerCanvasRollout`, which keeps a definite yes or no for a
 * minute, so with the flag off a busy manager does not ask PostHog on every
 * flush.
 */
import type { MiddlewareHandler } from "hono";
import type {
  FeatureObservationEvent,
  FeatureObserver,
  MCPClientManager,
} from "@mcpjam/sdk";
import { getLocalConnectionScope } from "../../utils/mcp-connections.js";
import { resolveServerCanvasRollout } from "../../utils/server-canvas-rollout.js";
import { rememberHostedContext } from "./connection-context.js";
import {
  LiveContextHashes,
  hostedConnectionOf,
} from "./observation-context.js";
import {
  FeatureObservationBuffer,
  convexObservationWriter,
  flushFeatureObservations,
} from "./observations.js";

/** A buffer flushes at most this often. */
export const OBSERVATION_FLUSH_INTERVAL_MS = 15_000;
/** How long a shutdown waits for pending hosted flushes. */
export const OBSERVATION_SHUTDOWN_FLUSH_MS = 2_000;

const localBuffer = new FeatureObservationBuffer();
const localHashes = new LiveContextHashes();
let lastLocalFlushAt = 0;

/** The context hash of a live local connection, as its capture computes it. */
export function localContextHash(
  manager: MCPClientManager,
  managerKey: string,
): string | undefined {
  const scope = getLocalConnectionScope(manager, managerKey);
  return scope
    ? localHashes.hashFor(manager, managerKey, scope.accountKey)
    : undefined;
}

/** The local manager's `featureObserver`, bound to that manager. */
export function recordLocalObservation(
  manager: MCPClientManager,
  event: FeatureObservationEvent,
): void {
  const scope = getLocalConnectionScope(manager, event.serverId);
  const contextHash = localContextHash(manager, event.serverId);
  if (!scope || !contextHash) return;
  localBuffer.record(
    { projectId: scope.projectId, serverId: scope.serverId, contextHash },
    event.featureIds,
    event.at,
    "rpc",
  );
}

/** Flushes local observations as the caller behind `authorization`. */
export async function flushLocalObservations(
  authorization: string | null | undefined,
  now = Date.now(),
): Promise<void> {
  if (!authorization || localBuffer.size === 0) return;
  if (now - lastLocalFlushAt < OBSERVATION_FLUSH_INTERVAL_MS) return;
  lastLocalFlushAt = now;
  await flushFeatureObservations(localBuffer, {
    canvasOn: () => resolveServerCanvasRollout(authorization),
    write: convexObservationWriter(authorization),
  });
}

/** After a local API request, flush with its bearer when one is due. */
export const localObservationFlushMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  await next();
  if (localBuffer.size === 0) return;
  void flushLocalObservations(c.req.header("Authorization"));
};

/** Hosted buffers waiting on their timer, for a graceful shutdown to flush. */
const pendingHostedFlushes = new Set<() => Promise<unknown>>();

/**
 * Test seam: empties the local buffer and the pending hosted flushes.
 */
export function resetLocalObservationsForTests(): void {
  localBuffer.take();
  lastLocalFlushAt = 0;
  pendingHostedFlushes.clear();
}

/**
 * Flushes every hosted buffer still inside its interval, for a graceful
 * shutdown; waits at most `timeoutMs`. Never throws.
 */
export async function flushPendingHostedObservations(
  timeoutMs = OBSERVATION_SHUTDOWN_FLUSH_MS,
): Promise<void> {
  if (pendingHostedFlushes.size === 0) return;
  const flushes = [...pendingHostedFlushes].map((flush) => flush());
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(flushes),
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, timeoutMs);
      deadline.unref?.();
    }),
  ]);
  clearTimeout(deadline);
}

/**
 * The `featureObserver` for one hosted authorized manager. `managerOf`
 * returns that manager once constructed; frames only arrive after that.
 * `actorId` is the user the backend authorized (its Convex user id); without
 * one, the live context is not cached for that user's Apps bridge batches.
 */
export function hostedFeatureObserver(
  projectId: string,
  bearerToken: string,
  managerOf: () => MCPClientManager | undefined,
  actorId: string | null | undefined,
): FeatureObserver {
  const buffer = new FeatureObservationBuffer();
  const hashes = new LiveContextHashes();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    pendingHostedFlushes.delete(flush);
    return flushFeatureObservations(buffer, {
      canvasOn: () => resolveServerCanvasRollout(bearerToken),
      write: convexObservationWriter(bearerToken),
    });
  };
  return (event) => {
    const manager = managerOf();
    if (!manager) return;
    const connection = hostedConnectionOf(manager, event.serverId);
    const contextHash = hashes.hashFor(
      manager,
      event.serverId,
      connection.accountKey,
    );
    if (!contextHash) return;
    if (actorId)
      rememberHostedContext(
        { projectId, serverId: connection.serverId, actorId },
        contextHash,
      );
    buffer.record(
      { projectId, serverId: connection.serverId, contextHash },
      event.featureIds,
      event.at,
      "rpc",
    );
    if (timer) return;
    // Unref'd so a pending flush never holds the process open; a graceful
    // shutdown flushes it early instead.
    timer = setTimeout(() => void flush(), OBSERVATION_FLUSH_INTERVAL_MS);
    timer.unref?.();
    pendingHostedFlushes.add(flush);
  };
}
