/**
 * Wire shapes for the HOSTED subscription passthrough stream (MCP 2026-07-28
 * §13.4).
 *
 * ## Why a passthrough, not a shared sink
 *
 * The hosted plane is horizontally scaled, but a `subscriptions/listen` stream
 * is a *long-lived* upstream request. §5.5 / §13.4 make the deliberate choice
 * that the downstream browser connection and the upstream MCP subscription live
 * on the SAME replica for their shared lifetime:
 *
 * - the browser opens ONE authenticated endpoint (`POST /api/web/subscriptions/
 *   listen`) with project/server/desired-interests;
 * - the replica authorizes + connects exactly like an ordinary hosted op, opens
 *   a dedicated official-client connection, and drives the SDK's
 *   `SubscriptionCoordinator`;
 * - acknowledgement, notifications, lifecycle status, and *safe* errors are
 *   forwarded downstream over SSE;
 * - browser abort cancels upstream and disposes the manager;
 * - upstream graceful/remote closure closes downstream with a STRUCTURED
 *   TERMINAL EVENT (graceful vs remote are distinct);
 * - a browser reconnect reopens from the desired filter — there is NO replay.
 *
 * This is horizontally scalable precisely because nothing crosses replicas: we
 * do NOT write every notification to Convex to fan across the fleet.
 *
 * The observation shapes reuse the era-neutral view types declared for the
 * LOCAL bridge (`shared/subscription-bridge.ts`) so both surfaces render the
 * same "what did the server agree to send, on which subscription, why did it
 * stop" facts; the hosted stream adds an `open` preamble and a `terminal`
 * closer that the local (already-connected, snapshot-on-connect) channel does
 * not need.
 */

import type {
  SubscriptionCloseReasonView,
  SubscriptionEra,
  SubscriptionNotificationView,
  SubscriptionRejectedNotificationView,
  SubscriptionStreamView,
} from "./subscription-bridge.js";

export type {
  SubscriptionCloseReasonView,
  SubscriptionEra,
  SubscriptionNotificationView,
  SubscriptionRejectedNotificationView,
  SubscriptionStreamView,
} from "./subscription-bridge.js";

/**
 * Wire-contract version. Bump only on an incompatible change to the event
 * shapes below so a stale browser bundle can degrade rather than misparse.
 */
export const HOSTED_SUBSCRIPTION_VERSION = 1;

/** Desired interests the browser POSTs when opening the stream. */
export interface HostedSubscriptionDesired {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceUris?: string[];
}

export type HostedSubscriptionEvent =
  /**
   * Sent once, immediately, before any upstream work — confirms the replica
   * accepted the stream and reports the negotiated era and whether this
   * connection can open a modern `subscriptions/listen` stream at all.
   */
  | {
      type: "open";
      serverId: string;
      era: SubscriptionEra;
      supportsListen: boolean;
    }
  /** A stream opened, was acknowledged (carries `acknowledgedFilter`), or closed. */
  | { type: "stream"; serverId: string; stream: SubscriptionStreamView }
  /** A forwarded notification, stamped with its subscription id. */
  | {
      type: "notification";
      serverId: string;
      notification: SubscriptionNotificationView;
    }
  /** A safe refusal: an unrequested/unknown/inactive notification, shown not dropped. */
  | {
      type: "rejected";
      serverId: string;
      rejection: SubscriptionRejectedNotificationView;
    }
  /**
   * The structured terminal event. `reason` distinguishes a server-intended
   * `graceful` close from an unexpected `remote` loss, a local `local-abort`
   * (browser hung up / disposal), or an `error` open. After this the SSE
   * closes; a browser that still wants the data re-opens from the desired
   * filter (no replay).
   */
  | {
      type: "terminal";
      serverId: string;
      reason: SubscriptionCloseReasonView;
      era: SubscriptionEra;
      stream: SubscriptionStreamView;
    };
