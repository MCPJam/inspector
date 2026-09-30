/**
 * An in-memory event inbox — the LOCAL adapter of contract C5.
 *
 * The production inbox is a Worker + Durable Object on hooks.mcpjam.com
 * (mcpjam-backend `events-inbox/`). This class implements the same rules for
 * the places that cannot reach it: the local app's poll loop, the CLI, the
 * non-conformant plain-http development receiver, and every lifecycle test.
 * It is deliberately the same shape — slots, journal with a monotonic `seq`,
 * dedupe on the C2 delivery key, rotation overlap, the C3 acceptance table —
 * so a behaviour proven here is the behaviour the Durable Object must have.
 *
 * What it does NOT promise: durability. Everything lives in this process.
 */

import {
  computeControlKey,
  computeDeliveryKey,
  type EventRunNamespace,
} from "./identity.js";
import {
  classifyWebhookBody,
  isInvalidEventsPayloadError,
} from "../mcp-client-manager/events-ext-guards.js";
import { generateWebhookSecret } from "../mcp-client-manager/events-ext.js";
import { normalizeCursor } from "../mcp-client-manager/events-ext-schemas.js";
import { verifyWebhookDelivery } from "./standard-webhooks.js";
import {
  InboxBackpressureError,
  type EventEnvelope,
  type EventOrigin,
  type InboxAppendEntry,
  type InboxPort,
  type InboxSlotAllocation,
} from "./types.js";

export const MAX_DELIVERY_BODY_BYTES = 262_144;

export type SlotState = "pending" | "active" | "removed" | "expired";

interface Slot {
  slotId: string;
  logicalSubscriptionId: string;
  projectId: string;
  environmentId: string | null;
  bindingKey: string;
  dispatch: boolean;
  state: SlotState;
  secret: string;
  previousSecret?: string;
  previousSecretUntil?: number;
  serverSubscriptionId?: string;
  observedSubscriptionIds: string[];
  pendingExpiresAt?: number;
}

export interface JournalEntry extends EventEnvelope {
  seq: number;
  deliveryKey: string;
  dispatch: "pending" | "acked" | "none";
  idConflict?: boolean;
  webhookIdMismatch?: boolean;
  quarantined?: boolean;
}

export interface Rejection {
  reason: string;
  slotId?: string;
  at: number;
  headerNames: string[];
  bodyBytes: number;
}

export interface MemoryInboxOptions {
  inboxId?: string;
  /** Origin callback URLs are minted under. */
  publicOrigin: string;
  clock?: { now(): number };
  pendingTtlMs?: number;
  overlapMs?: number;
  maxUndispatched?: number;
}

export interface ReceiveResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

export class MemoryEventInbox implements InboxPort {
  readonly inboxId: string;
  private readonly slots = new Map<string, Slot>();
  private readonly journal: JournalEntry[] = [];
  private readonly dedupe = new Map<string, number>();
  private readonly batches = new Map<string, { accepted: number; duplicates: number }>();
  private readonly listeners = new Set<(entry: JournalEntry) => void>();
  readonly rejections: Rejection[] = [];
  private seq = 0;
  private readonly clock: { now(): number };
  private readonly options: Required<Omit<MemoryInboxOptions, "clock" | "inboxId">>;

  constructor(options: MemoryInboxOptions) {
    this.inboxId = options.inboxId ?? randomId();
    this.clock = options.clock ?? { now: () => Date.now() };
    this.options = {
      publicOrigin: options.publicOrigin.replace(/\/$/, ""),
      pendingTtlMs: options.pendingTtlMs ?? 15 * 60 * 1000,
      overlapMs: options.overlapMs ?? 10 * 60 * 1000,
      maxUndispatched: options.maxUndispatched ?? 1000,
    };
  }

  callbackUrlFor(slotId: string): string {
    return `${this.options.publicOrigin}/i/${this.inboxId}/s/${slotId}`;
  }

  // --- InboxPort ----------------------------------------------------------

  async allocateSlot(args: {
    logicalSubscriptionId: string;
    projectId: string;
    environmentId: string | null;
    bindingKey: string;
    dispatch: boolean;
  }): Promise<InboxSlotAllocation> {
    const slotId = randomId();
    const secret = generateWebhookSecret();
    this.slots.set(slotId, {
      slotId,
      ...args,
      state: "pending",
      secret,
      observedSubscriptionIds: [],
      pendingExpiresAt: this.clock.now() + this.options.pendingTtlMs,
    });
    return {
      inboxId: this.inboxId,
      slotId,
      callbackUrl: this.callbackUrlFor(slotId),
      secret,
    };
  }

  async getSecret(slotId: string) {
    const slot = this.requireSlot(slotId);
    return {
      secret: slot.secret,
      ...(this.previousSecretLive(slot) ? { previousSecret: slot.previousSecret! } : {}),
      state: this.effectiveState(slot),
    };
  }

  async reconcile(slotId: string, serverSubscriptionId: string) {
    const slot = this.requireLiveSlot(slotId);
    if (slot.serverSubscriptionId && slot.serverSubscriptionId !== serverSubscriptionId) {
      return {
        state: slot.state,
        conflict: { existing: slot.serverSubscriptionId, proposed: serverSubscriptionId },
      };
    }
    slot.serverSubscriptionId = serverSubscriptionId;
    if (slot.state === "pending") {
      slot.state = "active";
      delete slot.pendingExpiresAt;
    }
    return { state: slot.state };
  }

  async unbind(slotId: string) {
    // Pause (C3): the unsubscribed server id no longer binds this slot. It
    // waits, pending but never expiring, for resume's id — new or reused.
    const slot = this.requireLiveSlot(slotId);
    slot.state = "pending";
    delete slot.serverSubscriptionId;
    delete slot.pendingExpiresAt;
  }

  async rotate(slotId: string) {
    const slot = this.requireSlot(slotId);
    slot.previousSecret = slot.secret;
    slot.previousSecretUntil = this.clock.now() + this.options.overlapMs;
    slot.secret = generateWebhookSecret();
    return { secret: slot.secret };
  }

  async retirePrevious(slotId: string) {
    const slot = this.requireSlot(slotId);
    delete slot.previousSecret;
    delete slot.previousSecretUntil;
  }

  async remove(slotId: string) {
    const slot = this.slots.get(slotId);
    if (slot) slot.state = "removed";
  }

  async append(args: {
    slotId?: string;
    logicalSubscriptionId: string;
    projectId: string;
    environmentId: string | null;
    bindingKey: string;
    batchId: string;
    origin: EventOrigin;
    namespace?: EventRunNamespace;
    entries: InboxAppendEntry[];
  }) {
    const cached = this.batches.get(args.batchId);
    if (cached) return cached;
    if (this.undispatchedCount() + args.entries.length > this.options.maxUndispatched) {
      throw new InboxBackpressureError(5_000);
    }
    const namespace = args.namespace ?? "live";
    let accepted = 0;
    let duplicates = 0;
    // Build every row first, then commit: an invalid entry rejects the whole
    // batch with nothing written, which is what "atomic" means here.
    const rows: Array<Omit<JournalEntry, "seq">> = args.entries.map((raw, index) => {
      const control = (raw as { type?: unknown }).type;
      if (control === "gap" || control === "terminated") {
        const entry = raw as
          | { type: "gap"; cursor: string | null }
          | { type: "terminated"; error: NonNullable<EventEnvelope["error"]> };
        const key = this.namespaced(
          computeControlKey({
            projectId: args.projectId,
            environmentId: args.environmentId,
            bindingKey: args.bindingKey,
            logicalSubscriptionId: args.logicalSubscriptionId,
            webhookId: `${args.batchId}:${index}`,
          }),
          namespace
        );
        return {
          kind: entry.type,
          origin: args.origin,
          namespace,
          logicalSubscriptionId: args.logicalSubscriptionId,
          ...(args.slotId ? { slotId: args.slotId } : {}),
          cursor: entry.type === "gap" ? normalizeCursor(entry.cursor) : null,
          ...(entry.type === "terminated" ? { error: entry.error } : {}),
          receivedAt: this.clock.now(),
          deliveryKey: key,
          dispatch: "pending",
        };
      }
      const entry = raw as Extract<InboxAppendEntry, { eventId: string }>;
      return {
        kind: "event",
        origin: args.origin,
        namespace,
        logicalSubscriptionId: args.logicalSubscriptionId,
        ...(args.slotId ? { slotId: args.slotId } : {}),
        eventId: entry.eventId,
        name: entry.name,
        timestamp: entry.timestamp,
        data: entry.data as Record<string, unknown>,
        cursor: normalizeCursor(entry.cursor),
        receivedAt: this.clock.now(),
        deliveryKey: this.namespaced(
          computeDeliveryKey({
            projectId: args.projectId,
            environmentId: args.environmentId,
            bindingKey: args.bindingKey,
            logicalSubscriptionId: args.logicalSubscriptionId,
            eventId: entry.eventId,
          }),
          namespace
        ),
        dispatch: "pending",
      };
    });
    for (const row of rows) {
      if (this.dedupe.has(row.deliveryKey)) {
        duplicates += 1;
        continue;
      }
      this.commit(row);
      accepted += 1;
    }
    const result = { accepted, duplicates };
    this.batches.set(args.batchId, result);
    return result;
  }

  // --- Receiver (the C3 acceptance table) ----------------------------------

  /**
   * Handle one webhook POST for `slotId`. The caller routes by path and
   * passes the RAW body; nothing here re-serializes it before verification.
   */
  async receive(args: {
    slotId: string;
    headers: Headers | Record<string, string | undefined>;
    body: string | Uint8Array;
  }): Promise<ReceiveResult> {
    const now = this.clock.now();
    const bodyBytes =
      typeof args.body === "string"
        ? new TextEncoder().encode(args.body).length
        : args.body.length;
    const headerNames: string[] = [];
    if (args.headers instanceof Headers) {
      args.headers.forEach((_value, key) => headerNames.push(key));
    } else {
      headerNames.push(...Object.keys(args.headers));
    }
    const reject = (status: number, reason: string, slotId?: string): ReceiveResult => {
      this.rejections.push({
        reason,
        ...(slotId ? { slotId } : {}),
        at: now,
        headerNames,
        bodyBytes,
      });
      if (this.rejections.length > 200) this.rejections.shift();
      return { status, body: { error: reason } };
    };

    if (bodyBytes > MAX_DELIVERY_BODY_BYTES) {
      return reject(413, "body_too_large", args.slotId);
    }
    const slot = this.slots.get(args.slotId);
    if (!slot) return reject(410, "unknown_slot");
    if (this.effectiveState(slot) === "expired")
      return reject(410, "expired_slot", slot.slotId);

    const secrets = [slot.secret];
    if (this.previousSecretLive(slot)) secrets.push(slot.previousSecret!);
    const verified = await verifyWebhookDelivery({
      secrets,
      headers: args.headers,
      body: args.body,
      nowSeconds: Math.floor(now / 1000),
    });
    if (!verified.ok) return reject(401, verified.reason, slot.slotId);

    const text =
      typeof args.body === "string" ? args.body : new TextDecoder().decode(args.body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.quarantine(slot, verified.webhookId, "malformed_json", now);
    }
    let classified;
    try {
      classified = classifyWebhookBody(parsed);
    } catch (error) {
      if (isInvalidEventsPayloadError(error)) {
        return this.quarantine(slot, verified.webhookId, "malformed_event", now);
      }
      throw error;
    }

    const headerSubscriptionId = headerValue(args.headers, "x-mcp-subscription-id");
    if (classified.kind === "verification") {
      // Answered only when correctly signed (above) — never journalled.
      return { status: 200, body: { challenge: classified.envelope.challenge } };
    }
    if (this.undispatchedCount() >= this.options.maxUndispatched) {
      return {
        status: 503,
        body: { error: "inbox_full" },
        headers: { "retry-after": "5" },
      };
    }
    if (slot.state === "pending" && headerSubscriptionId) {
      if (!slot.observedSubscriptionIds.includes(headerSubscriptionId)) {
        slot.observedSubscriptionIds.push(headerSubscriptionId);
        if (slot.observedSubscriptionIds.length > 8) slot.observedSubscriptionIds.shift();
      }
    }
    const idConflict =
      slot.state === "active" &&
      headerSubscriptionId !== undefined &&
      slot.serverSubscriptionId !== undefined &&
      headerSubscriptionId !== slot.serverSubscriptionId;
    const tenant = {
      projectId: slot.projectId,
      environmentId: slot.environmentId,
      bindingKey: slot.bindingKey,
      logicalSubscriptionId: slot.logicalSubscriptionId,
    };
    const dispatch: JournalEntry["dispatch"] =
      slot.state === "removed" || !slot.dispatch ? "none" : "pending";
    let row: Omit<JournalEntry, "seq">;
    if (classified.kind === "event") {
      const event = classified.event;
      row = {
        kind: "event",
        origin: "webhook",
        namespace: "live",
        logicalSubscriptionId: slot.logicalSubscriptionId,
        slotId: slot.slotId,
        serverSubscriptionId: headerSubscriptionId ?? null,
        eventId: event.eventId,
        name: event.name,
        timestamp: event.timestamp,
        data: event.data as Record<string, unknown>,
        cursor: normalizeCursor(event.cursor),
        webhookId: verified.webhookId,
        receivedAt: now,
        deliveryKey: computeDeliveryKey({ ...tenant, eventId: event.eventId }),
        dispatch,
        ...(idConflict ? { idConflict: true } : {}),
        ...(verified.webhookId !== event.eventId ? { webhookIdMismatch: true } : {}),
      };
    } else if (classified.kind === "gap" || classified.kind === "terminated") {
      row = {
        kind: classified.kind,
        origin: "webhook",
        namespace: "live",
        logicalSubscriptionId: slot.logicalSubscriptionId,
        slotId: slot.slotId,
        serverSubscriptionId: headerSubscriptionId ?? null,
        cursor:
          classified.kind === "gap"
            ? normalizeCursor(classified.envelope.cursor)
            : null,
        ...(classified.kind === "terminated"
          ? { error: classified.envelope.error }
          : {}),
        webhookId: verified.webhookId,
        receivedAt: now,
        deliveryKey: computeControlKey({ ...tenant, webhookId: verified.webhookId }),
        dispatch,
      };
    } else {
      return this.quarantine(slot, verified.webhookId, "unknown_control", now);
    }
    if (this.dedupe.has(row.deliveryKey)) {
      return { status: 200, body: { duplicate: true } };
    }
    const committed = this.commit(row);
    return { status: 200, body: { accepted: true, seq: committed.seq } };
  }

  // --- Feed ----------------------------------------------------------------

  read(after = 0, limit = 200): { entries: JournalEntry[]; nextAfter: number } {
    const entries = this.journal.filter((entry) => entry.seq > after).slice(0, limit);
    const last = entries[entries.length - 1];
    return { entries: entries.map((entry) => ({ ...entry })), nextAfter: last?.seq ?? after };
  }

  /**
   * Backlog and live in one synchronous step: nothing can be committed
   * between reading the backlog and registering the listener, because both
   * happen before this function returns (single-threaded, like the DO).
   */
  subscribe(
    after: number,
    listener: (entry: JournalEntry) => void
  ): { backlog: JournalEntry[]; unsubscribe: () => void } {
    const backlog = this.journal
      .filter((entry) => entry.seq > after)
      .map((entry) => ({ ...entry }));
    this.listeners.add(listener);
    return { backlog, unsubscribe: () => this.listeners.delete(listener) };
  }

  /** Entries awaiting dispatch — the trigger runner's queue, not a viewer's. */
  pendingDispatch(limit = 25): JournalEntry[] {
    return this.journal
      .filter((entry) => entry.dispatch === "pending")
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  ackDispatch(seq: number): void {
    const entry = this.journal.find((row) => row.seq === seq);
    if (entry && entry.dispatch === "pending") entry.dispatch = "acked";
  }

  slotState(slotId: string):
    | {
        state: SlotState;
        serverSubscriptionId?: string;
        observedSubscriptionIds: string[];
        hasPreviousSecret: boolean;
      }
    | undefined {
    const slot = this.slots.get(slotId);
    if (!slot) return undefined;
    return {
      state: this.effectiveState(slot),
      ...(slot.serverSubscriptionId ? { serverSubscriptionId: slot.serverSubscriptionId } : {}),
      observedSubscriptionIds: [...slot.observedSubscriptionIds],
      hasPreviousSecret: this.previousSecretLive(slot),
    };
  }

  // --- internals -------------------------------------------------------------

  private commit(row: Omit<JournalEntry, "seq">): JournalEntry {
    const entry = { ...row, seq: ++this.seq } as JournalEntry;
    this.journal.push(entry);
    this.dedupe.set(entry.deliveryKey, entry.seq);
    for (const listener of this.listeners) {
      try {
        listener({ ...entry });
      } catch {
        // A broken listener must not undo a committed delivery.
      }
    }
    return entry;
  }

  private quarantine(
    slot: Slot,
    webhookId: string,
    reason: string,
    now: number
  ): ReceiveResult {
    // Quarantined, not dropped (C9): kept for the Events tab, never
    // dispatched, and acknowledged so the sender does not retry forever.
    const deliveryKey = computeControlKey({
      projectId: slot.projectId,
      environmentId: slot.environmentId,
      bindingKey: slot.bindingKey,
      logicalSubscriptionId: slot.logicalSubscriptionId,
      webhookId,
    });
    if (!this.dedupe.has(deliveryKey)) {
      this.commit({
        kind: "event",
        origin: "webhook",
        namespace: "live",
        logicalSubscriptionId: slot.logicalSubscriptionId,
        slotId: slot.slotId,
        cursor: null,
        webhookId,
        receivedAt: now,
        deliveryKey,
        dispatch: "none",
        quarantined: true,
      });
    }
    return { status: 202, body: { quarantined: reason } };
  }

  private namespaced(key: string, namespace: EventRunNamespace): string {
    return namespace === "live" ? key : `${namespace}:${key}`;
  }

  private undispatchedCount(): number {
    let count = 0;
    for (const entry of this.journal) if (entry.dispatch === "pending") count += 1;
    return count;
  }

  private previousSecretLive(slot: Slot): boolean {
    return (
      slot.previousSecret !== undefined &&
      slot.previousSecretUntil !== undefined &&
      this.clock.now() <= slot.previousSecretUntil
    );
  }

  private requireSlot(slotId: string): Slot {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`Unknown receiver slot ${slotId}`);
    return slot;
  }

  /** Like the Durable Object: a removed or expired slot is never re-bound. */
  private requireLiveSlot(slotId: string): Slot {
    const slot = this.requireSlot(slotId);
    const state = this.effectiveState(slot);
    if (state === "removed" || state === "expired") {
      throw new Error(`Receiver slot ${slotId} is ${state}`);
    }
    return slot;
  }

  /** A pending slot past its TTL is `expired` (C3), from then on. */
  private effectiveState(slot: Slot): SlotState {
    if (
      slot.state === "pending" &&
      slot.pendingExpiresAt !== undefined &&
      this.clock.now() >= slot.pendingExpiresAt
    ) {
      slot.state = "expired";
    }
    return slot.state;
  }
}

function headerValue(
  headers: Headers | Record<string, string | undefined>,
  name: string
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}
