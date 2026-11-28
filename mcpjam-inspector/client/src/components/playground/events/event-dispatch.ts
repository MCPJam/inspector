import type {
  EventsFeedEntryView,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { renderPlaygroundEventTurn } from "@/shared/event-turn-parts";
import {
  eventAtTurnFromFeedEntry,
  type EventAtTurn,
} from "@/shared/event-at-turn";
import { renderUserContextText } from "@/shared/user-context-message";

export interface EventBinding {
  id: string;
  subscriptionId: string;
  logicalId: string;
  serverName: string;
  eventName: string;
  instructions: string;
  enabled: boolean;
  afterSeq: number;
  agentScope: string;
  /** `mode` gives a test event the subscription's delivery mode. */
  subscription?: Pick<EventsSubscriptionView, "desiredState" | "observedState"> &
    Partial<Pick<EventsSubscriptionView, "mode">>;
}

function acceptsEvents(binding: EventBinding): boolean {
  const subscription = binding.subscription;
  return (
    !subscription ||
    (subscription.desiredState === "active" &&
      !["removing", "removed", "terminated"].includes(
        subscription.observedState,
      ))
  );
}

export interface EventAgent {
  /** The conversation and client: an event runs only where its watch belongs. */
  scope: string;
  /** The conversation (`chatSessionId`) whose saved watches load. */
  conversationId?: string;
  /** Whether the conversation has a turn, so it can be reopened after a reload. */
  hasMessages?: boolean;
  blockedReason: string | null;
  /**
   * `event` is what the turn records about the occurrence that started it.
   * Resolves true once the turn is admitted, and false, or throws, when it
   * refused before any turn started.
   */
  send: (
    text: string,
    isCurrent: () => boolean,
    event?: EventAtTurn,
  ) => Promise<boolean>;
}

/**
 * What became of one occurrence. `queued` is waiting to run, and its message
 * says why; `skipped` never reached the agent.
 */
export interface EventOutcome {
  status: "queued" | "sent" | "skipped" | "failed";
  message: string;
}

/** A saved watch's claim on an entry (`eventWatches:claimEvent`). */
export interface EventClaimResult {
  claimed: boolean;
  previousAfterSeq: number;
  reason?: "handled" | "paused" | "removed";
}

/** What a waiting connection needs from the user, if anything. */
export interface EventQueueAction {
  kind: "catch-up" | "retry";
  count: number;
}

/**
 * User-authored instructions and received data have distinct, visible roles.
 * The event context header makes the chat show the turn as an event card, not
 * as a message the user typed, both live and after the chat is reopened.
 */
export function eventTurn(
  binding: EventBinding,
  entry: EventsFeedEntryView,
): string {
  return renderUserContextText({
    kind: "event",
    subject: binding.eventName,
    body: renderPlaygroundEventTurn({
      eventName: binding.eventName,
      serverName: binding.serverName,
      instructions: binding.instructions,
      event: entry,
    }),
  });
}

/** More than this many events that waited while away need the user's go. */
export const CATCH_UP_LIMIT = 3;
/** The feedback-loop guard: event turns per connection per rolling hour. */
export const HOURLY_LIMIT = 30;
/** Refused starts before an event needs the user. */
export const MAX_ATTEMPTS = 5;
const HOUR_MS = 3_600_000;
/**
 * Lets a replayed backlog arrive before deciding whether it needs a go: the
 * feed connects after the saved connections load, then replays.
 */
const CATCH_UP_SETTLE_MS = 5_000;
const RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const LOCKED_RETRY_MS = 2_000;
/** A turn shows as busy within this; after it, assume it already ended. */
const TURN_START_MS = 3_000;
const TURN_MAX_MS = 10 * 60_000;
const TURN_POLL_MS = 250;

interface Queued {
  id: string;
  entry: EventsFeedEntryView;
  localTest: boolean;
  key: string;
  /** This tab holds the claim: a retry sends without claiming again. */
  claimed?: boolean;
  attempts: number;
  /** Set after MAX_ATTEMPTS refusals; the connection waits for Try again. */
  attention?: string;
  /** The reason last shown, so it is set once per change. */
  reason?: string;
}

const LOCKED = Symbol("locked");

/**
 * One event turn at a time per conversation across this browser's tabs, held
 * until the turn ends. Without Web Locks (tests, old browsers) each tab runs
 * on its own, as before.
 */
async function withTurnLock<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T | typeof LOCKED> {
  // jsdom and older browsers have no Web Locks.
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : (navigator.locks as LockManager | undefined);
  if (!locks) return run();
  return await locks.request(name, { ifAvailable: true }, async (lock) =>
    lock ? await run() : LOCKED,
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One open Playground owns this dispatcher. It never creates hosted agent jobs.
 *
 * Occurrences wait in one queue and run one turn at a time, oldest first among
 * the connections that can run now, so order holds per connection and one
 * waiting connection never holds up another. A connection runs when its
 * conversation is open, the agent is free and its server is connected.
 * Nothing is skipped for being busy; pause is the only skip.
 *
 * A saved connection claims each entry before its turn (`claim`), so another
 * tab, or this one after a reload, never runs it twice. The tab that claimed
 * an entry keeps it through refusals and retries it itself; after
 * MAX_ATTEMPTS the connection asks for Try again. More than CATCH_UP_LIMIT
 * events that waited while the conversation was closed (`loadedAt`) wait for
 * the user's go, and HOURLY_LIMIT bounds a feedback loop.
 */
export function createEventDispatcher(options: {
  binding: (id: string) => EventBinding | undefined;
  agent: () => EventAgent | null;
  connected: (binding: EventBinding) => boolean;
  /** A new occurrence reached this binding, before it waits or runs. */
  received: (id: string, entry: EventsFeedEntryView) => void;
  /** What became of that occurrence, including why it is waiting. */
  result: (
    id: string,
    entry: EventsFeedEntryView,
    outcome: EventOutcome,
  ) => void;
  /** Resolves null for a binding that isn't saved; rejects when unreachable. */
  claim?: (
    binding: EventBinding,
    entry: EventsFeedEntryView,
  ) => Promise<EventClaimResult | null>;
  /** When a saved binding's conversation opened here; earlier entries waited. */
  loadedAt?: (binding: EventBinding) => number | undefined;
  /** The queue changed, for the counts and actions. */
  changed?: () => void;
}) {
  let disposed = false;
  let lifecycle = 0;
  let running = false;
  let queue: Queued[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Infinity;
  let retryMs = 0;
  const seen = new Set<string>();
  const revisions = new Map<string, number>();
  const runs = new Map<string, number[]>();
  const approvedBefore = new Map<string, number>();

  /** Wakes the queue at `ms` from now, keeping an earlier wake. */
  const later = (ms: number) => {
    const at = Date.now() + ms;
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = undefined;
      timerAt = Infinity;
      void pump();
    }, ms);
  };
  const remove = (item: Queued, forget = false) => {
    queue = queue.filter((queued) => queued !== item);
    if (forget) seen.delete(item.key);
    options.changed?.();
  };
  const settle = (item: Queued, outcome: EventOutcome) => {
    remove(item);
    options.result(item.id, item.entry, outcome);
  };
  const show = (item: Queued, reason: string) => {
    if (item.reason === reason) return;
    item.reason = reason;
    options.result(item.id, item.entry, { status: "queued", message: reason });
  };
  const recentRuns = (id: string, now: number) => {
    const kept = (runs.get(id) ?? []).filter((at) => now - at < HOUR_MS);
    runs.set(id, kept);
    return kept;
  };
  const isBacklog = (binding: EventBinding, item: Queued) => {
    const since = options.loadedAt?.(binding);
    return (
      !item.localTest &&
      since !== undefined &&
      item.entry.receivedAt < since &&
      item.entry.receivedAt >= (approvedBefore.get(binding.id) ?? -Infinity)
    );
  };
  /** Why the occurrence can no longer run, or null. */
  const stale = (binding: EventBinding, item: Queued): EventOutcome | null =>
    !binding.enabled
      ? { status: "skipped", message: "Paused before this event ran." }
      : !acceptsEvents(binding)
        ? {
            status: "skipped",
            message: "The subscription stopped before this event ran.",
          }
        : item.entry.logicalSubscriptionId !== binding.logicalId ||
            item.entry.name !== binding.eventName
          ? {
              status: "skipped",
              message: "The event connection changed before this event ran.",
            }
          : !item.localTest && !item.claimed && item.entry.seq <= binding.afterSeq
            ? { status: "sent", message: "Ran in another tab." }
            : null;
  /** Why everything waits, whichever connection it is for. */
  const agentReason = (binding: EventBinding, agent: EventAgent | null) =>
    !agent || agent.scope !== binding.agentScope
      ? "Waiting for this conversation to be open."
      : agent.blockedReason;
  /** Why this connection waits, or null if its head can run now. */
  const connectionReason = (
    binding: EventBinding,
    item: Queued,
    now: number,
  ): string | null => {
    if (item.attention) return item.attention;
    if (!options.connected(binding))
      return `Waiting for ${binding.serverName} to connect.`;
    const recent = recentRuns(binding.id, now);
    if (!item.localTest && recent.length >= HOURLY_LIMIT) {
      const next = recent[0] + HOUR_MS;
      later(next - now);
      return `This event connection ran ${HOURLY_LIMIT} events in the last hour. The next one can run at ${new Date(next).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    }
    if (isBacklog(binding, item)) {
      const since = options.loadedAt?.(binding) ?? now;
      if (now < since + CATCH_UP_SETTLE_MS) {
        later(since + CATCH_UP_SETTLE_MS - now);
        return "Checking for events that arrived while this conversation was closed.";
      }
      const waited = queue.filter(
        (queued) => queued.id === binding.id && isBacklog(binding, queued),
      ).length;
      if (waited > CATCH_UP_LIMIT)
        return `${waited} events arrived while this conversation was closed. Run them, or pause and resume this event connection to skip them.`;
    }
    return null;
  };

  /**
   * A refused start: keep the claim and try again later, or, after
   * MAX_ATTEMPTS, ask the user and let other connections run ("next").
   */
  const refused = (item: Queued, reason: string): "next" | "wait" => {
    item.attempts += 1;
    if (item.attempts >= MAX_ATTEMPTS) {
      item.attention = `This event couldn't start: ${reason} Use Try again to run it.`;
      show(item, item.attention);
      options.changed?.();
      return "next";
    }
    show(item, reason);
    retryMs = retryMs ? Math.min(retryMs * 2, MAX_RETRY_MS) : RETRY_MS;
    later(retryMs);
    return "wait";
  };

  /** Waits for an admitted turn to show as busy and then finish. */
  async function turnEnded() {
    const start = Date.now();
    let sawBusy = false;
    while (!disposed) {
      const busy = !!options.agent()?.blockedReason;
      if (busy) sawBusy = true;
      const elapsed = Date.now() - start;
      if (
        (sawBusy && !busy) ||
        (!sawBusy && elapsed > TURN_START_MS) ||
        elapsed > TURN_MAX_MS
      )
        return;
      await sleep(TURN_POLL_MS);
    }
  }

  async function runItem(
    item: Queued,
    binding: EventBinding,
    agent: EventAgent,
  ): Promise<"next" | "wait"> {
    if (options.claim && !item.localTest && !item.claimed) {
      let claim: EventClaimResult | null;
      try {
        claim = await options.claim(binding, item.entry);
      } catch {
        return refused(item, "Couldn't reach MCPJam to start this event.");
      }
      if (claim && !claim.claimed) {
        if (claim.reason === "removed") remove(item, true);
        else
          settle(
            item,
            claim.reason === "paused"
              ? { status: "skipped", message: "Paused before this event ran." }
              : { status: "sent", message: "Ran in another tab." },
          );
        return "next";
      }
      item.claimed = claim?.claimed === true;
    }
    const revision = revisions.get(item.id) ?? 0;
    const generation = lifecycle;
    const isCurrent = () => {
      const latest = options.binding(item.id);
      return (
        !disposed &&
        lifecycle === generation &&
        latest?.enabled === true &&
        acceptsEvents(latest) &&
        (revisions.get(item.id) ?? 0) === revision &&
        options.connected(latest) &&
        options.agent()?.scope === agent.scope
      );
    };
    let sent = false;
    let error: unknown;
    try {
      sent = await agent.send(
        eventTurn(binding, item.entry),
        isCurrent,
        eventAtTurnFromFeedEntry(item.entry, binding.subscription?.mode),
      );
    } catch (thrown) {
      // A send throws before it admits a turn, so this is a refusal too.
      error = thrown;
    }
    if (!sent)
      return refused(
        item,
        error instanceof Error
          ? error.message
          : (options.agent()?.blockedReason ??
              "Waiting for the conversation to be ready."),
      );
    retryMs = 0;
    if (!item.localTest) recentRuns(binding.id, Date.now()).push(Date.now());
    settle(item, { status: "sent", message: "Event sent to agent" });
    await turnEnded();
    return "next";
  }

  /** The oldest occurrence that can run now; shows the rest why they wait. */
  function pick() {
    const agent = options.agent();
    const now = Date.now();
    const blocked = new Map<string, string>();
    const ordered = [
      ...queue.filter((item) => item.localTest),
      ...queue.filter((item) => !item.localTest),
    ];
    let next: { item: Queued; binding: EventBinding; agent: EventAgent } | null =
      null;
    for (const item of ordered) {
      const binding = options.binding(item.id);
      if (!binding) {
        // Removed, or another conversation's saved watch: a saved one
        // replays from the inbox when its conversation opens.
        remove(item, true);
        continue;
      }
      const gone = stale(binding, item);
      if (gone) {
        settle(item, gone);
        continue;
      }
      const reason =
        blocked.get(item.id) ??
        agentReason(binding, agent) ??
        connectionReason(binding, item, now);
      if (reason) {
        blocked.set(item.id, reason);
        show(item, reason);
        continue;
      }
      if (!next && agent) next = { item, binding, agent };
      else if (next && next.item !== item)
        show(item, "Waiting for the event before it to finish.");
    }
    return next;
  }

  async function pump() {
    if (disposed || running) return;
    running = true;
    try {
      while (!disposed) {
        const next = pick();
        if (!next) return;
        const { item, binding, agent } = next;
        const outcome = await withTurnLock(
          `mcpjam-event-turn:${binding.agentScope}`,
          () => runItem(item, binding, agent),
        );
        if (outcome === LOCKED) {
          show(item, "Running an event in another tab.");
          later(LOCKED_RETRY_MS);
          return;
        }
        if (outcome === "wait") return;
      }
    } finally {
      running = false;
    }
  }

  return {
    activate() {
      disposed = false;
      void pump();
    },
    invalidate(id: string) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
    },
    dispose() {
      disposed = true;
      lifecycle += 1;
      if (timer) clearTimeout(timer);
      timer = undefined;
      timerAt = Infinity;
    },
    /** Run what can run now: call when the agent, a server or a watch changes. */
    pump: () => void pump(),
    /** How many occurrences of this binding wait to run. */
    queued: (id: string) => queue.filter((item) => item.id === id).length,
    /** What the user can do for a waiting binding: run a held backlog or retry. */
    action(id: string): EventQueueAction | null {
      const binding = options.binding(id);
      const items = queue.filter((item) => item.id === id);
      if (items.some((item) => item.attention))
        return { kind: "retry", count: items.length };
      const waited = binding
        ? items.filter((item) => isBacklog(binding, item)).length
        : 0;
      return waited > CATCH_UP_LIMIT ? { kind: "catch-up", count: waited } : null;
    },
    /** The user's go: runs a held backlog and retries an event that needs it. */
    runQueued(id: string) {
      approvedBefore.set(id, Date.now());
      for (const item of queue)
        if (item.id === id) {
          item.attempts = 0;
          item.attention = undefined;
        }
      retryMs = 0;
      options.changed?.();
      void pump();
    },
    /**
     * Queues an occurrence for its binding. False when it doesn't belong to
     * it, was seen already, or the binding is paused.
     */
    async dispatch(
      id: string,
      entry: EventsFeedEntryView,
      localTest = false,
    ): Promise<boolean> {
      const binding = options.binding(id);
      if (
        disposed ||
        !binding?.enabled ||
        !acceptsEvents(binding) ||
        entry.kind !== "event" ||
        entry.quarantined ||
        entry.idConflict ||
        entry.afterRemoval ||
        entry.logicalSubscriptionId !== binding.logicalId ||
        entry.name !== binding.eventName ||
        (!localTest && entry.seq <= binding.afterSeq)
      )
        return false;
      const key = JSON.stringify([
        id,
        entry.namespace,
        entry.eventId ?? entry.seq,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      // Bounded replay guard. The feed separately deduplicates sequence numbers.
      if (seen.size > 5000) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      options.received(id, entry);
      const item: Queued = { id, entry, localTest, key, attempts: 0 };
      // Inbox order behind the head, which may be running.
      const at = localTest
        ? -1
        : queue.findIndex(
            (queued, index) =>
              index > 0 && !queued.localTest && queued.entry.seq > entry.seq,
          );
      if (at === -1) queue.push(item);
      else queue.splice(at, 0, item);
      options.changed?.();
      void pump();
      return true;
    },
  };
}
