/**
 * Terminal driver for the 2026-07-28 `subscriptions/listen` stream.
 *
 * The session owns the *reporting* contract; the SDK's
 * `SubscriptionCoordinator` owns the protocol. That split is deliberate:
 * everything the coordinator already models as a first-class fact (requested
 * vs acknowledged filter, subscription identity, close reason, bounded
 * re-listen) is rendered here verbatim rather than re-derived.
 *
 * Contract:
 *
 * - **stdout is NDJSON only.** One structured event per line, no human
 *   progress text ever, in both `--format json` and `--format human`. A
 *   long-lived stream is a pipe into `jq`/a CI step before it is something a
 *   person reads, so mixing status into stdout would corrupt every consumer.
 * - **Human status goes to stderr.**
 * - **The acknowledgement is its own event type.** `subscription.acknowledged`
 *   is never folded into the notification stream: it is the server stating
 *   which subset of the requested filter it agreed to honor, and it gates
 *   delivery.
 * - **Every notification carries both ids** — the MCPJam-local stream id and
 *   the MCP subscription id (when the server stamps one).
 * - **Close reasons are distinct outcomes**, not one "disconnected" bucket:
 *   `graceful` (server completed the subscription) exits 0, `remote`
 *   (unexpected loss, re-listens exhausted or disabled) exits non-zero,
 *   `cancelled` (local abort: signal, duration cap, notification cap) exits 0,
 *   and `error` (the open itself failed) exits non-zero.
 */

import type {
  DeliveredSubscriptionNotification,
  DesiredSubscriptionInterests,
  RejectedSubscriptionNotification,
  SubscriptionFilterShape,
  SubscriptionInterestRejection,
  SubscriptionReconnectPolicy,
  SubscriptionStreamRecord,
} from "@mcpjam/sdk";

/** How the stream ended. Distinct outcomes, distinct exit codes. */
export type SubscriptionListenOutcome =
  | "graceful"
  | "remote"
  | "cancelled"
  | "error";

/** Why *we* stopped, when the outcome is `cancelled`. */
export type SubscriptionListenStopReason =
  | "signal"
  | "duration"
  | "max-notifications";

export const SUBSCRIPTION_OUTCOME_EXIT_CODES: Readonly<
  Record<SubscriptionListenOutcome, number>
> = {
  graceful: 0,
  cancelled: 0,
  remote: 1,
  error: 1,
};

export type SubscriptionListenEvent =
  | {
      type: "subscription.opened";
      localSubscriptionId: string;
      subscriptionId?: string;
      era: "legacy" | "modern";
      requestedFilter: SubscriptionFilterShape;
      rejectedInterests: SubscriptionInterestRejection[];
      relistenAttempt: number;
      at: number;
    }
  | {
      type: "subscription.acknowledged";
      localSubscriptionId: string;
      subscriptionId?: string;
      requestedFilter: SubscriptionFilterShape;
      acknowledgedFilter: SubscriptionFilterShape;
      rejectedInterests: SubscriptionInterestRejection[];
      at: number;
    }
  | {
      type: "notification";
      localSubscriptionId: string;
      subscriptionId?: string;
      method: string;
      kind: DeliveredSubscriptionNotification["kind"];
      uri?: string;
      params?: Record<string, unknown>;
      at: number;
    }
  | {
      type: "notification.rejected";
      localSubscriptionId?: string;
      subscriptionId?: string;
      method: string;
      reason: RejectedSubscriptionNotification["reason"];
      at: number;
    }
  | {
      type: "subscription.relisten";
      localSubscriptionId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      at: number;
    }
  | {
      type: "subscription.closed";
      localSubscriptionId: string;
      subscriptionId?: string;
      outcome: SubscriptionListenOutcome;
      closeReason?: SubscriptionStreamRecord["closeReason"];
      error?: string;
      relistenAttempt: number;
      at: number;
    }
  | {
      type: "summary";
      outcome: SubscriptionListenOutcome;
      stopReason?: SubscriptionListenStopReason;
      exitCode: number;
      error?: string;
      notifications: number;
      rejectedNotifications: number;
      relistenAttempts: number;
      streams: number;
      at: number;
    };

export interface SubscriptionListenResult {
  outcome: SubscriptionListenOutcome;
  stopReason?: SubscriptionListenStopReason;
  exitCode: number;
  error?: string;
  notifications: number;
  rejectedNotifications: number;
  relistenAttempts: number;
  streams: number;
}

/** The slice of `SubscriptionCoordinator` the session drives. */
export interface SubscriptionCoordinatorLike {
  setDesiredInterests(desired: DesiredSubscriptionInterests): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SubscriptionCoordinatorHandlers {
  onStreamChange: (stream: SubscriptionStreamRecord) => void;
  onNotification: (event: DeliveredSubscriptionNotification) => void;
  onRejectedNotification: (event: RejectedSubscriptionNotification) => void;
}

export interface SubscriptionListenSessionDeps {
  /**
   * Builds the coordinator around the session's handlers. Injected so the
   * session can be driven by a fixture without a live connection — and so the
   * reconnect policy the session *reports* is the same object the coordinator
   * *enforces*.
   */
  createCoordinator(
    handlers: SubscriptionCoordinatorHandlers,
  ): SubscriptionCoordinatorLike;
  /** Structured NDJSON sink (stdout). */
  emit(event: SubscriptionListenEvent): void;
  /** Human status sink (stderr). */
  status(message: string): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

export interface SubscriptionListenSessionOptions {
  desired: DesiredSubscriptionInterests;
  reconnect: SubscriptionReconnectPolicy;
  /** Stop after this many delivered notifications. */
  maxNotifications?: number;
  /** Stop after this wall-clock budget. */
  durationMs?: number;
}

/**
 * Backoff for re-listen attempt `attempt` (1-based), mirroring the
 * coordinator's schedule so the reported delay is the delay actually waited.
 */
export function relistenDelayMs(
  policy: SubscriptionReconnectPolicy,
  attempt: number,
): number {
  return Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * policy.factor ** (attempt - 1),
  );
}

function describeFilter(filter: SubscriptionFilterShape): string {
  const parts: string[] = [];
  if (filter.toolsListChanged) parts.push("tools/list_changed");
  if (filter.promptsListChanged) parts.push("prompts/list_changed");
  if (filter.resourcesListChanged) parts.push("resources/list_changed");
  for (const uri of filter.resourceSubscriptions ?? []) {
    parts.push(`resource:${uri}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(empty)";
}

export function hasAnyInterest(desired: DesiredSubscriptionInterests): boolean {
  return Boolean(
    desired.toolsListChanged ||
      desired.promptsListChanged ||
      desired.resourcesListChanged ||
      (desired.resourceUris?.length ?? 0) > 0,
  );
}

export class SubscriptionListenSession {
  private readonly coordinator: SubscriptionCoordinatorLike;
  private readonly now: () => number;
  private readonly setTimer: (
    fn: () => void,
    ms: number,
  ) => { cancel: () => void };
  private readonly timers: Array<{ cancel: () => void }> = [];

  private settled = false;
  /**
   * Set the moment a local abort is requested, before the (async) cancel
   * round-trip completes: notifications that land during the teardown belong
   * to a stream we have already decided to stop, so counting them would let a
   * chatty server overshoot `--max-notifications`.
   */
  private stopping = false;
  private stopReason?: SubscriptionListenStopReason;
  private notifications = 0;
  private rejectedNotifications = 0;
  private relistenAttempts = 0;
  private readonly seenStreams = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly closed = new Set<string>();
  private resolveCompletion!: (result: SubscriptionListenResult) => void;
  private readonly completion: Promise<SubscriptionListenResult>;

  constructor(
    private readonly options: SubscriptionListenSessionOptions,
    private readonly deps: SubscriptionListenSessionDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // A pending duration cap must not by itself keep the process alive.
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      });
    this.completion = new Promise<SubscriptionListenResult>((resolve) => {
      this.resolveCompletion = resolve;
    });
    this.coordinator = deps.createCoordinator({
      onStreamChange: (stream) => this.onStreamChange(stream),
      onNotification: (event) => this.onNotification(event),
      onRejectedNotification: (event) => this.onRejectedNotification(event),
    });
  }

  /** Opens the stream and resolves when it reaches a terminal outcome. */
  async run(): Promise<SubscriptionListenResult> {
    this.deps.status(
      `Opening subscription: ${describeFilter({
        toolsListChanged: this.options.desired.toolsListChanged,
        promptsListChanged: this.options.desired.promptsListChanged,
        resourcesListChanged: this.options.desired.resourcesListChanged,
        resourceSubscriptions: [...(this.options.desired.resourceUris ?? [])],
      })}`,
    );
    if (this.options.durationMs !== undefined) {
      this.timers.push(
        this.setTimer(() => {
          void this.stop("duration");
        }, this.options.durationMs),
      );
    }
    try {
      await this.coordinator.setDesiredInterests(this.options.desired);
    } catch (error) {
      this.finish(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
    const result = await this.completion;
    for (const timer of this.timers) timer.cancel();
    await this.safeDispose();
    return result;
  }

  /** Local abort (signal, duration cap, notification cap). Idempotent. */
  async stop(reason: SubscriptionListenStopReason): Promise<void> {
    if (this.settled || this.stopping) return;
    this.stopping = true;
    this.stopReason ??= reason;
    this.deps.status(`Cancelling subscription (${reason})...`);
    try {
      await this.coordinator.cancel();
    } catch (error) {
      this.deps.status(
        `Cancel failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A coordinator whose stream was never live emits no cancelled record;
    // the local abort is still the outcome.
    this.finish("cancelled");
  }

  private onStreamChange(stream: SubscriptionStreamRecord): void {
    if (this.settled) return;
    if (!this.seenStreams.has(stream.localId)) {
      this.seenStreams.add(stream.localId);
      if (stream.reconnectAttempt > 0) {
        this.relistenAttempts = Math.max(
          this.relistenAttempts,
          stream.reconnectAttempt,
        );
      }
      this.deps.emit({
        type: "subscription.opened",
        localSubscriptionId: stream.localId,
        ...(stream.mcpSubscriptionId
          ? { subscriptionId: stream.mcpSubscriptionId }
          : {}),
        era: stream.era,
        requestedFilter: stream.requestedFilter,
        rejectedInterests: stream.rejectedInterests,
        relistenAttempt: stream.reconnectAttempt,
        at: stream.openedAt,
      });
      this.deps.status(
        stream.reconnectAttempt > 0
          ? `Re-listening (attempt ${stream.reconnectAttempt}): ${describeFilter(stream.requestedFilter)}`
          : `Requested: ${describeFilter(stream.requestedFilter)}`,
      );
    }

    if (stream.acknowledgedFilter && !this.acknowledged.has(stream.localId)) {
      this.acknowledged.add(stream.localId);
      this.deps.emit({
        type: "subscription.acknowledged",
        localSubscriptionId: stream.localId,
        ...(stream.mcpSubscriptionId
          ? { subscriptionId: stream.mcpSubscriptionId }
          : {}),
        requestedFilter: stream.requestedFilter,
        acknowledgedFilter: stream.acknowledgedFilter,
        rejectedInterests: stream.rejectedInterests,
        at: stream.acknowledgedAt ?? this.now(),
      });
      this.deps.status(
        `Acknowledged: ${describeFilter(stream.acknowledgedFilter)}`,
      );
    }

    if (
      stream.status === "opening" ||
      stream.status === "active" ||
      this.closed.has(stream.localId)
    ) {
      return;
    }
    this.closed.add(stream.localId);
    this.onStreamClosed(stream);
  }

  private onStreamClosed(stream: SubscriptionStreamRecord): void {
    const outcome: SubscriptionListenOutcome =
      stream.status === "graceful-closed"
        ? "graceful"
        : stream.status === "remote-closed"
          ? "remote"
          : stream.status === "cancelled"
            ? "cancelled"
            : "error";
    this.deps.emit({
      type: "subscription.closed",
      localSubscriptionId: stream.localId,
      ...(stream.mcpSubscriptionId
        ? { subscriptionId: stream.mcpSubscriptionId }
        : {}),
      outcome,
      ...(stream.closeReason ? { closeReason: stream.closeReason } : {}),
      ...(stream.error ? { error: stream.error } : {}),
      relistenAttempt: stream.reconnectAttempt,
      at: stream.closedAt ?? this.now(),
    });

    if (outcome === "remote") {
      const attempt = stream.reconnectAttempt + 1;
      if (attempt <= this.options.reconnect.maxAttempts) {
        // The coordinator schedules and performs the re-listen; the session
        // reports the same schedule so the wait is visible, not silent.
        const delayMs = relistenDelayMs(this.options.reconnect, attempt);
        this.relistenAttempts = Math.max(this.relistenAttempts, attempt);
        this.deps.emit({
          type: "subscription.relisten",
          localSubscriptionId: stream.localId,
          attempt,
          maxAttempts: this.options.reconnect.maxAttempts,
          delayMs,
          at: this.now(),
        });
        this.deps.status(
          `Stream lost; re-listening in ${delayMs}ms (attempt ${attempt}/${this.options.reconnect.maxAttempts})`,
        );
        return;
      }
      this.deps.status(
        this.options.reconnect.maxAttempts > 0
          ? "Stream lost remotely; re-listen attempts exhausted."
          : "Stream lost remotely.",
      );
      this.finish("remote");
      return;
    }
    if (outcome === "graceful") {
      this.deps.status("Server completed the subscription.");
    }
    this.finish(outcome, stream.error);
  }

  private onNotification(event: DeliveredSubscriptionNotification): void {
    if (this.settled || this.stopping) return;
    this.notifications += 1;
    this.deps.emit({
      type: "notification",
      localSubscriptionId: event.localSubscriptionId,
      ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
      method: event.method,
      kind: event.kind,
      ...(event.uri ? { uri: event.uri } : {}),
      ...(event.params ? { params: event.params } : {}),
      at: event.at,
    });
    if (
      this.options.maxNotifications !== undefined &&
      this.notifications >= this.options.maxNotifications
    ) {
      void this.stop("max-notifications");
    }
  }

  private onRejectedNotification(event: RejectedSubscriptionNotification): void {
    if (this.settled || this.stopping) return;
    this.rejectedNotifications += 1;
    this.deps.emit({
      type: "notification.rejected",
      ...(event.localSubscriptionId
        ? { localSubscriptionId: event.localSubscriptionId }
        : {}),
      ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
      method: event.method,
      reason: event.reason,
      at: event.at,
    });
  }

  private finish(outcome: SubscriptionListenOutcome, error?: string): void {
    if (this.settled) return;
    this.settled = true;
    const result: SubscriptionListenResult = {
      outcome,
      ...(outcome === "cancelled" && this.stopReason
        ? { stopReason: this.stopReason }
        : {}),
      exitCode: SUBSCRIPTION_OUTCOME_EXIT_CODES[outcome],
      ...(error ? { error } : {}),
      notifications: this.notifications,
      rejectedNotifications: this.rejectedNotifications,
      relistenAttempts: this.relistenAttempts,
      streams: this.seenStreams.size,
    };
    this.deps.emit({ type: "summary", ...result, at: this.now() });
    this.resolveCompletion(result);
  }

  private async safeDispose(): Promise<void> {
    try {
      await this.coordinator.dispose();
    } catch {
      // Teardown is best-effort: the outcome is already decided, and a
      // failing dispose must not turn a clean exit into a crash.
    }
  }
}
