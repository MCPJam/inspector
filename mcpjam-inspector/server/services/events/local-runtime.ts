/**
 * The LOCAL MCP Events runtime (plan: local app; contracts C3, C5, C9).
 *
 * Everything the hosted system spreads over Convex, the inbox Worker and the
 * keeper, in one process, for the desktop/local inspector:
 *
 *   - an in-memory registry of `SubscriptionRecord`s (`locality: "local"`),
 *     each with the development overrides the user explicitly acknowledged;
 *   - ONE `MemoryEventInbox` whose callback URLs are this inspector's own
 *     development receiver — `http://127.0.0.1:<port>/api/mcp/events/hooks/
 *     i/<inboxId>/s/<slotId>`. Plain http, so a webhook subscription is only
 *     created when the user explicitly picked it and acknowledged the
 *     `insecure-local-receiver` override; it is labelled as such everywhere
 *     and is never a conformance pass;
 *   - an `EventsCoordinator` whose rpc port drives the singleton manager for
 *     the record's server, stepped by a small scheduler (a timer armed at the
 *     earliest `nextActionAt`, bounded concurrency, and a generation fence
 *     mirroring the hosted CAS: a step that raced a user edit is discarded);
 *   - `events/stream` push delivery through the SDK's `EventsPushRuntime`
 *     (one per server, sharing the inbox), so pushed events journal exactly
 *     like polled and webhook ones;
 *   - a broadcaster of `EventsStreamFrame`s for the Events tab.
 *
 * There is no trigger dispatcher locally (triggers run hosted), so every
 * journal entry is acknowledged as it lands: the inbox's undispatched
 * counter — which is what applies backpressure — stays meaningful.
 *
 * Nothing here ever exposes a slot secret: views are projected field by field
 * (`views.ts`) and the inbox keeps secrets private.
 */

import { randomUUID } from "node:crypto";
import {
  EventsCoordinator,
  EventsPushRuntime,
  IDLE_NEXT_ACTION_AT,
  MemoryEventInbox,
  applySubscriptionPatch,
  computeArgumentsHash,
  computeBindingKey,
  createManagerPushPort,
  type EventsRpcPort,
  type JournalEntry,
  type PushStreamHandle,
  type ReceiveResult,
  type SubscriptionRecord,
} from "@mcpjam/sdk/events";
import type { MCPClientManager } from "@mcpjam/sdk";
import type {
  EventsCreateSubscriptionRequest,
  EventsFeedEntryView,
  EventsSimulateRequest,
  EventsStreamFrame,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { logger } from "../../utils/logger.js";
import {
  feedEntryView,
  rejectionView,
  subscriptionView,
  type LocalOverride,
} from "./views.js";

/** Records are keyed by project; the local app has exactly one. */
export const LOCAL_EVENTS_PROJECT_ID = "local";
/** Whose credentials a local binding uses: the local user's own. */
export const LOCAL_CREDENTIAL_OWNER = "local";
/** `setTimeout`'s ceiling; a longer delay overflows to ~0. */
const MAX_TIMER_MS = 2_147_483_647;

export class LocalEventsError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: "EVENTS_NOT_FOUND" | "EVENTS_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "LocalEventsError";
  }
}

interface LocalSubscription {
  record: SubscriptionRecord;
  overrides: LocalOverride[];
  argumentsHash: string;
  push?: PushStreamHandle;
}

export interface LocalEventsRuntimeOptions {
  manager: MCPClientManager;
  /** Origin callback URLs are minted under, e.g. `http://127.0.0.1:6274/api/mcp/events/hooks`. */
  publicOrigin: string;
  clock?: { now(): number };
  concurrency?: number;
  /** Coordinator knobs (tests shorten windows). */
  coordinatorOptions?: {
    defaultPollMs?: number;
    lateRefreshWindowMs?: number;
    maxBackoffMs?: number;
  };
  /** Push runtime knobs (tests shorten the heartbeat window). */
  pushOptions?: { heartbeatIntervalMs?: number; maxBackoffMs?: number };
}

type Listener = (frame: EventsStreamFrame) => void;

export class LocalEventsRuntime {
  readonly inbox: MemoryEventInbox;
  private readonly manager: MCPClientManager;
  private readonly clock: { now(): number };
  private readonly coordinator: EventsCoordinator;
  private readonly subscriptions = new Map<string, LocalSubscription>();
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly pushRuntimes = new Map<string, EventsPushRuntime>();
  private readonly concurrency: number;
  private readonly pushOptions: LocalEventsRuntimeOptions["pushOptions"];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private head = 0;
  private readonly unsubscribeJournal: () => void;

  constructor(options: LocalEventsRuntimeOptions) {
    this.manager = options.manager;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.pushOptions = options.pushOptions;
    this.inbox = new MemoryEventInbox({
      publicOrigin: options.publicOrigin,
      clock: this.clock,
    });
    this.coordinator = new EventsCoordinator({
      clock: this.clock,
      ...(options.coordinatorOptions ?? {}),
      rpc: async (record) => this.rpcPort(record.serverId),
      inbox: async () => this.inbox,
    });
    const { unsubscribe } = this.inbox.subscribe(0, (entry) => this.onJournal(entry));
    this.unsubscribeJournal = unsubscribe;
  }

  // -------------------------------------------------------------------------
  // Ports
  // -------------------------------------------------------------------------

  private rpcPort(serverId: string): EventsRpcPort {
    const manager = this.manager;
    return {
      list: (params) => manager.listServerEvents(serverId, params),
      poll: (params) => manager.pollServerEvents(serverId, params),
      subscribe: (params) => manager.subscribeServerEvents(serverId, params),
      unsubscribe: (params) => manager.unsubscribeServerEvents(serverId, params),
    };
  }

  private pushRuntimeFor(serverId: string): EventsPushRuntime {
    let runtime = this.pushRuntimes.get(serverId);
    if (!runtime) {
      runtime = new EventsPushRuntime({
        port: createManagerPushPort(this.manager as never, serverId),
        inbox: this.inbox,
        clock: this.clock,
        ...(this.pushOptions ?? {}),
      });
      this.pushRuntimes.set(serverId, runtime);
    }
    return runtime;
  }

  // -------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------

  private emit(frame: EventsStreamFrame): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  private onJournal(entry: JournalEntry): void {
    this.head = Math.max(this.head, entry.seq);
    // No local dispatcher: acknowledge so backpressure counts only real
    // backlog (see the module header).
    this.inbox.ackDispatch(entry.seq);
    this.emit({ type: "entry", entry: feedEntryView(entry) });
    // A delivery landing on a removed webhook slot re-arms the removal step
    // (C4: one more unsubscribe after a late delivery).
    if (entry.origin === "webhook") {
      const local = this.subscriptions.get(entry.logicalSubscriptionId);
      if (local && local.record.desiredState === "removed" && local.record.mode === "webhook") {
        local.record = { ...local.record, nextActionAt: this.clock.now() };
        this.kick();
      }
    }
  }

  private view(local: LocalSubscription): EventsSubscriptionView {
    return subscriptionView(local.record, {
      locality: "local",
      overrides: local.overrides,
    });
  }

  private publish(local: LocalSubscription): void {
    this.emit({ type: "subscription", subscription: this.view(local) });
  }

  /**
   * Register a stream listener. Returns the snapshot frame to send first and
   * the backlog after `after`; backlog and live registration happen in one
   * synchronous step, so nothing falls between them.
   */
  openStream(
    after: number,
    listener: Listener,
  ): { snapshot: EventsStreamFrame; backlog: EventsFeedEntryView[]; close: () => void } {
    const backlog = this.inbox.read(after, Number.MAX_SAFE_INTEGER).entries;
    this.listeners.add(listener);
    return {
      snapshot: {
        type: "snapshot",
        subscriptions: this.list(),
        nextAfter: Math.max(after, this.head),
      },
      backlog: backlog.map((entry) => feedEntryView(entry)),
      close: () => {
        this.listeners.delete(listener);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  list(serverId?: string): EventsSubscriptionView[] {
    return [...this.subscriptions.values()]
      .filter((local) => !serverId || local.record.serverId === serverId)
      .map((local) => this.view(local));
  }

  get(id: string): EventsSubscriptionView | undefined {
    const local = this.subscriptions.get(id);
    return local ? this.view(local) : undefined;
  }

  private require(id: string): LocalSubscription {
    const local = this.subscriptions.get(id);
    if (!local) throw new LocalEventsError(404, "EVENTS_NOT_FOUND", `No subscription ${id}.`);
    return local;
  }

  /** Idempotent: one LIVE subscription per (server, event, arguments, mode). */
  create(request: EventsCreateSubscriptionRequest): EventsSubscriptionView {
    const overrides: LocalOverride[] = (request.overrides ?? []).filter(
      (value): value is LocalOverride => value === "insecure-local-receiver",
    );
    if (request.mode === "webhook" && !overrides.includes("insecure-local-receiver")) {
      throw new LocalEventsError(
        400,
        "EVENTS_UNAVAILABLE",
        "Local webhook delivery uses the plain-http development receiver on this inspector's own port. " +
          'It is never a conformance pass; acknowledge it with overrides: ["insecure-local-receiver"].',
      );
    }
    const argumentsHash = computeArgumentsHash(request.arguments);
    for (const existing of this.subscriptions.values()) {
      if (
        existing.record.desiredState !== "removed" &&
        existing.record.serverId === request.serverId &&
        existing.record.eventName === request.eventName &&
        existing.record.mode === request.mode &&
        existing.argumentsHash === argumentsHash
      ) {
        return this.view(existing);
      }
    }
    const now = this.clock.now();
    const record: SubscriptionRecord = {
      id: `esub_${randomUUID().replace(/-/g, "")}`,
      projectId: LOCAL_EVENTS_PROJECT_ID,
      environmentId: null,
      bindingKey: computeBindingKey({
        serverId: request.serverId,
        credentialOwnerUserId: LOCAL_CREDENTIAL_OWNER,
        credentialFingerprint: null,
      }),
      serverId: request.serverId,
      profile: request.profile,
      eventName: request.eventName,
      arguments: request.arguments,
      mode: request.mode,
      desiredState: "active",
      observedState: "pending",
      generation: 1,
      nextActionAt: now,
      consecutiveFailures: 0,
      ...(request.maxAgeMs !== undefined ? { maxAgeMs: request.maxAgeMs } : {}),
      ...(request.ttlMs !== undefined ? { ttlMs: request.ttlMs } : {}),
    };
    const local: LocalSubscription = {
      record,
      overrides: request.mode === "webhook" ? overrides : [],
      argumentsHash,
    };
    this.subscriptions.set(record.id, local);
    if (record.mode === "push") this.startPush(local);
    this.publish(local);
    this.kick();
    return this.view(local);
  }

  /** A user edit: bumps the generation, which fences any in-flight step. */
  setDesiredState(
    id: string,
    desiredState: "active" | "paused" | "removed",
  ): EventsSubscriptionView {
    const local = this.require(id);
    const now = this.clock.now();
    let next: SubscriptionRecord = {
      ...local.record,
      desiredState,
      generation: local.record.generation + 1,
      nextActionAt: now,
    };
    if (desiredState === "removed") {
      // Tombstone first (C4): deliveries racing the removal are journalled
      // and schedule nothing.
      if (next.observedState !== "removed") next.observedState = "removing";
    } else if (
      desiredState === "active" &&
      ["paused_auth", "error", "terminated"].includes(next.observedState)
    ) {
      // Resuming from a state that waits for the user is the local
      // equivalent of "reauthorize": start over from pending.
      next = { ...next, observedState: "pending", consecutiveFailures: 0 };
      delete next.lastError;
      delete next.terminatedError;
    }
    local.record = next;
    if (local.record.mode === "push") {
      if (desiredState === "active") this.startPush(local);
      else this.stopPush(local);
    }
    this.publish(local);
    this.kick();
    return this.view(local);
  }

  /** Ask for a webhook secret rotation (C3); the next step performs it. */
  rotate(id: string): EventsSubscriptionView {
    const local = this.require(id);
    if (local.record.mode !== "webhook") {
      throw new LocalEventsError(400, "EVENTS_UNAVAILABLE", "Only webhook subscriptions have a secret to rotate.");
    }
    if (local.record.desiredState === "removed") {
      throw new LocalEventsError(400, "EVENTS_UNAVAILABLE", "The subscription was removed.");
    }
    const now = this.clock.now();
    local.record = {
      ...local.record,
      rotation: { phase: "requested", at: now },
      nextActionAt: now,
    };
    this.publish(local);
    this.kick();
    return this.view(local);
  }

  /**
   * Append one simulated event: origin and namespace `simulation` (C2), so
   * it shows in the feed and can never collide with or suppress a live one.
   */
  async simulate(request: EventsSimulateRequest): Promise<EventsFeedEntryView> {
    const local = this.require(request.subscriptionId);
    const record = local.record;
    const eventId = request.event.eventId ?? `sim_${randomUUID()}`;
    await this.inbox.append({
      logicalSubscriptionId: record.id,
      projectId: record.projectId,
      environmentId: record.environmentId,
      bindingKey: record.bindingKey,
      batchId: `sim_${randomUUID()}`,
      origin: "simulation",
      namespace: "simulation",
      entries: [
        {
          eventId,
          name: request.event.name ?? record.eventName,
          timestamp: request.event.timestamp ?? new Date(this.clock.now()).toISOString(),
          data: request.event.data,
        } as never,
      ],
    });
    const entry = this.inbox
      .read(0, Number.MAX_SAFE_INTEGER)
      .entries.filter(
        (row) =>
          row.logicalSubscriptionId === record.id &&
          row.namespace === "simulation" &&
          row.eventId === eventId,
      )
      .at(-1);
    if (!entry) throw new Error("The simulated event was not journalled.");
    return feedEntryView(entry);
  }

  feed(after = 0, limit = 200): { entries: EventsFeedEntryView[]; nextAfter: number } {
    const { entries, nextAfter } = this.inbox.read(after, Math.min(Math.max(limit, 1), 1000));
    return { entries: entries.map((entry) => feedEntryView(entry)), nextAfter };
  }

  /**
   * The development receiver: one webhook POST for `slotId`, RAW body, the
   * C3 acceptance table. New rejections are broadcast as frames.
   */
  async receive(args: {
    inboxId: string;
    slotId: string;
    headers: Headers;
    body: Uint8Array;
  }): Promise<ReceiveResult> {
    if (args.inboxId !== this.inbox.inboxId) {
      return { status: 410, body: { error: "unknown_inbox" } };
    }
    const before = this.inbox.rejections.length;
    const lastBefore = this.inbox.rejections[before - 1];
    const result = await this.inbox.receive({
      slotId: args.slotId,
      headers: args.headers,
      body: args.body,
    });
    const rejections = this.inbox.rejections;
    // The rejection list is capped (oldest shifted out), so find where the
    // new ones start by identity rather than by length alone.
    const start = lastBefore ? rejections.lastIndexOf(lastBefore) + 1 : 0;
    for (const rejection of rejections.slice(start)) {
      this.emit({ type: "rejection", rejection: rejectionView(rejection) });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  private startPush(local: LocalSubscription): void {
    if (local.push || local.record.desiredState !== "active") return;
    const id = local.record.id;
    local.push = this.pushRuntimeFor(local.record.serverId).start(local.record, {
      onCursor: (cursor) => {
        const current = this.subscriptions.get(id);
        if (!current) return;
        current.record = { ...current.record, lastCursor: cursor };
        this.publish(current);
      },
      onState: ({ observedState, failure }) => {
        const current = this.subscriptions.get(id);
        if (!current || current.record.desiredState !== "active") return;
        const next: SubscriptionRecord = { ...current.record, observedState };
        if (failure) {
          next.lastError = failure;
          next.consecutiveFailures = current.record.consecutiveFailures + 1;
        } else if (observedState === "active") {
          delete next.lastError;
          next.consecutiveFailures = 0;
        }
        current.record = next;
        if (observedState === "terminated" || observedState === "paused_auth" || observedState === "error") {
          this.stopPush(current);
        }
        this.publish(current);
      },
    });
  }

  private stopPush(local: LocalSubscription): void {
    local.push?.stop();
    local.push = undefined;
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /** Re-evaluate what is due now. */
  kick(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 0);
    this.timer.unref?.();
  }

  private arm(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let earliest = IDLE_NEXT_ACTION_AT;
    for (const local of this.subscriptions.values()) {
      if (this.inFlight.has(local.record.id)) continue;
      earliest = Math.min(earliest, local.record.nextActionAt);
    }
    if (earliest >= IDLE_NEXT_ACTION_AT) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, earliest - this.clock.now()));
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = undefined;
    if (this.closed) return;
    const now = this.clock.now();
    const due = [...this.subscriptions.values()]
      .filter((local) => !this.inFlight.has(local.record.id) && local.record.nextActionAt <= now)
      .sort((a, b) => a.record.nextActionAt - b.record.nextActionAt);
    const slots = this.concurrency - this.inFlight.size;
    for (const local of due.slice(0, Math.max(0, slots))) {
      void this.runStep(local.record.id);
    }
    this.arm();
  }

  private async runStep(id: string): Promise<void> {
    const local = this.subscriptions.get(id);
    if (!local) return;
    this.inFlight.add(id);
    const snapshot = local.record;
    try {
      const outcome = await this.coordinator.step(snapshot);
      const current = this.subscriptions.get(id);
      if (!current || this.closed) return;
      if (current.record.generation !== snapshot.generation) {
        // A user edit landed mid-step (the local CAS): drop the patch and
        // re-evaluate against the edited record right away.
        current.record = { ...current.record, nextActionAt: this.clock.now() };
      } else {
        // The patch lands on the CURRENT record — like the hosted commit on
        // the current row — so fields written outside the step while it ran
        // (a push stream's cursor and state) survive. A rotation requested
        // mid-step is kept even if the step retired the previous one.
        const next = applySubscriptionPatch(current.record, outcome);
        if (current.record.rotation !== snapshot.rotation) {
          if (current.record.rotation) next.rotation = current.record.rotation;
          next.nextActionAt = Math.min(next.nextActionAt, this.clock.now());
        }
        current.record = next;
        if (outcome.action === "failed" && outcome.failure) {
          logger.debug("[events-local] step failed", {
            subscription: id,
            kind: outcome.failure.kind,
          });
        }
      }
      this.publish(current);
    } catch (error) {
      // Only a port that failed before any call escapes the coordinator;
      // back off rather than spin.
      const current = this.subscriptions.get(id);
      if (current) {
        const failures = current.record.consecutiveFailures + 1;
        current.record = {
          ...current.record,
          consecutiveFailures: failures,
          lastError: {
            kind: "transient",
            message: error instanceof Error ? error.message.slice(0, 300) : String(error),
            at: this.clock.now(),
            retryable: true,
          },
          nextActionAt: this.clock.now() + Math.min(30 * 60_000, 5_000 * 2 ** Math.min(failures - 1, 10)),
        };
        this.publish(current);
      }
    } finally {
      this.inFlight.delete(id);
      this.arm();
    }
  }

  /** Wait until nothing is in flight (tests). */
  async settle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      if (Date.now() > deadline) throw new Error("LocalEventsRuntime did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const local of this.subscriptions.values()) this.stopPush(local);
    for (const runtime of this.pushRuntimes.values()) runtime.close();
    this.pushRuntimes.clear();
    this.listeners.clear();
    this.unsubscribeJournal();
  }
}
