/**
 * Feature observation at the transport tap (engineering spec v0.4,
 * "3. Observed"). A manager with a `featureObserver` creates one tap per
 * connection, which `wrapTransportForLogging` feeds every frame; the tap
 * classifies each frame with `classifyFrame` and hands the observer feature
 * ids only. Frames are never retained: the tap keeps the method of each
 * in-flight request (and a closed completion-ref enum) so a response can be
 * classified, bounded per connection.
 *
 * MCPJam's own traffic is not observed use. A connection's observation can be
 * paused (`pauseFeatureObservation`, `suppressFeatureObservation`): the
 * manager pauses it for its handshake and its automatic `logging/setLevel`,
 * and callers pause it around capture and probes.
 *
 * The tap sees frames before the client validates them, so a result the SDK
 * then rejects (a `structuredContent` that fails the tool's output schema, a
 * missing `resultType`) still counts the shapes it carried. The server did
 * send them, and the rejection happens past the transport, where the tap
 * cannot see it without wrapping every call.
 */

import type { MCPClientManager } from "./MCPClientManager.js";
import {
  classifyFrame,
  requestContextOf,
  type FrameDirection,
  type FrameRequestContext,
} from "../server-features/classify-frame.js";
import { protocolEra } from "../server-features/context.js";

/** Payload-free: the connection's manager key, feature ids and a time. */
export interface FeatureObservationEvent {
  serverId: string;
  featureIds: readonly string[];
  at: number;
}

/**
 * Receives the feature ids each frame showed. Called synchronously on the
 * transport path, so it must be cheap; anything it throws is dropped.
 */
export type FeatureObserver = (event: FeatureObservationEvent) => void;

/**
 * Open pauses per manager and connection key. Kept beside the manager rather
 * than in it, so any holder of a manager handle can pause a connection.
 */
const pausedConnections = new WeakMap<MCPClientManager, Map<string, number>>();

/**
 * Pauses feature observation on `serverId`'s connection in `manager` until
 * the returned `resume` is called; a second call does nothing, and pauses
 * nest. While paused, the tap reports no frame on that connection, and a
 * request sent while paused is never reported, even if its response arrives
 * after `resume`.
 *
 * For traffic MCPJam starts on its own. A tap cannot tell who sent a frame,
 * so anything else on the connection while it is paused, such as a user's
 * tool call at the same moment, goes unreported too.
 */
export function pauseFeatureObservation(
  manager: MCPClientManager,
  serverId: string
): () => void {
  const counts = pausedConnections.get(manager) ?? new Map<string, number>();
  pausedConnections.set(manager, counts);
  counts.set(serverId, (counts.get(serverId) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    const left = (counts.get(serverId) ?? 1) - 1;
    if (left > 0) counts.set(serverId, left);
    else counts.delete(serverId);
  };
}

/** Runs `work` with the connection paused; see {@link pauseFeatureObservation}. */
export async function suppressFeatureObservation<T>(
  manager: MCPClientManager,
  serverId: string,
  work: () => Promise<T>
): Promise<T> {
  const resume = pauseFeatureObservation(manager, serverId);
  try {
    return await work();
  } finally {
    resume();
  }
}

/** Whether any pause is open on `serverId`'s connection in `manager`. */
export function isFeatureObservationPaused(
  manager: MCPClientManager,
  serverId: string
): boolean {
  return (pausedConnections.get(manager)?.get(serverId) ?? 0) > 0;
}

/** `observe` never throws, whatever the frame or the observer does. */
export interface FeatureFrameTap {
  observe(direction: "send" | "receive", message: unknown): void;
  setProtocolVersion(version: string): void;
}

/** In-flight requests remembered per connection before the oldest is dropped. */
export const MAX_PENDING_FEATURE_REQUESTS = 256;

type Rec = Record<string, unknown>;

/** What the tap keeps of an in-flight request: closed facts, never payload. */
interface PendingRequest {
  context: FrameRequestContext;
  /** Sent while observation was paused: whatever answers it is MCPJam's own. */
  paused: boolean;
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function pendingKey(origin: FrameDirection, id: string | number): string {
  return `${origin}:${typeof id}:${id}`;
}

const OTHER_SIDE: Readonly<Record<FrameDirection, FrameDirection>> = {
  "client-to-server": "server-to-client",
  "server-to-client": "client-to-server",
};

export function createFeatureFrameTap(
  serverId: string,
  observer: FeatureObserver,
  options: {
    now?: () => number;
    maxPending?: number;
    /** Whether observation is paused on this connection right now. */
    isPaused?: () => boolean;
  } = {}
): FeatureFrameTap {
  const now = options.now ?? Date.now;
  const maxPending = options.maxPending ?? MAX_PENDING_FEATURE_REQUESTS;
  const isPaused = options.isPaused ?? (() => false);
  const pending = new Map<string, PendingRequest>();
  let protocolVersion: string | undefined;

  function remember(
    origin: FrameDirection,
    id: string | number,
    frame: Rec,
    paused: boolean
  ) {
    const context = requestContextOf(frame);
    if (!context) return;
    const key = pendingKey(origin, id);
    pending.delete(key);
    pending.set(key, { context, paused });
    if (pending.size > maxPending) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
  }

  /** The request a response or cancellation refers to, consumed on use. */
  function take(origin: FrameDirection, id: unknown) {
    if (!isRequestId(id)) return undefined;
    const key = pendingKey(origin, id);
    const request = pending.get(key);
    pending.delete(key);
    return request;
  }

  /**
   * The request a cancellation ends. A cancellation names a request its
   * sender issued, and each side numbers its own requests, so the sender's
   * pending request comes first. The other side's is used only for a
   * `subscriptions/listen`: on stdio the server ends a listen stream by
   * cancelling the client's request.
   */
  function takeCancelled(sender: FrameDirection, id: unknown) {
    const own = take(sender, id);
    if (own || !isRequestId(id)) return own;
    const other = pending.get(pendingKey(OTHER_SIDE[sender], id));
    return other?.context.method === "subscriptions/listen"
      ? take(OTHER_SIDE[sender], id)
      : undefined;
  }

  function observeOne(direction: FrameDirection, frame: unknown) {
    if (!isRecord(frame)) return;
    const paused = isPaused();
    let request: PendingRequest | undefined;
    if (typeof frame.method === "string") {
      if (isRequestId(frame.id)) remember(direction, frame.id, frame, paused);
      else if (frame.method === "notifications/cancelled")
        request = takeCancelled(
          direction,
          isRecord(frame.params) ? frame.params.requestId : undefined
        );
    } else {
      request = take(OTHER_SIDE[direction], frame.id);
    }
    if (paused || request?.paused) return;
    const featureIds = classifyFrame(
      direction,
      frame,
      protocolEra(protocolVersion),
      request?.context
    );
    if (featureIds.length > 0) observer({ serverId, featureIds, at: now() });
  }

  return {
    observe(direction, message) {
      const side: FrameDirection =
        direction === "send" ? "client-to-server" : "server-to-client";
      try {
        if (Array.isArray(message))
          for (const frame of message) observeOne(side, frame);
        else observeOne(side, message);
      } catch {
        // Observation is best effort: neither a classifier bug nor an
        // observer failure may reach the transport the tap sits on.
      }
    },
    setProtocolVersion(version) {
      protocolVersion = version;
    },
  };
}
