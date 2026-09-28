/**
 * Ordered input forwarding for a frame socket.
 *
 * A WebSocket is ordered; the hops behind it are not. The hosted relay
 * forwards to the daemon over HTTP, and N concurrent POSTs arrive in whatever
 * order the network felt like — which for a drag means the pointer lands
 * somewhere it never went, and for a press/release pair means a page left
 * holding a button down. So: ONE dispatch in flight per socket, and whatever
 * queues behind it is COALESCED rather than replayed. An intermediate pointer
 * position nobody saw is not worth a round trip; the one they stopped at
 * always is, and a wheel's distance is summed rather than lost.
 *
 * The same shape serves the local relay, whose dispatch is in-process. It has
 * no network to reorder it, but it does have the same "a slow page must not
 * make the queue grow without bound" problem, and one implementation of the
 * queue is one place for that to be right.
 *
 * A REFUSAL IS AN ACK, NEVER A CLOSE. "Somebody else has the browser" is the
 * ordinary state of affairs while the agent is driving; a socket that closed
 * on it would make the pane reconnect in a loop against a browser that is
 * working exactly as designed.
 */
import {
  BROWSER_INPUT_BATCH_LIMIT,
  coalesceBrowserPaneInput,
  type BrowserPaneInputEvent,
} from "../../../shared/browser-pane-input.js";

/**
 * How many tab groups may wait behind one dispatch.
 *
 * Coalescing bounds a single tab's queue — a hundred pointer moves become one
 * — but input that ALTERNATES tabs starts a new group every message, and a
 * slow page then lets an authenticated pane grow this relay's memory without
 * limit. Generous enough that no real gesture reaches it, small enough that
 * nothing here is a memory story.
 */
const MAX_PENDING_GROUPS = 32;

/**
 * How many release-only groups may ride past that bound.
 *
 * A release is the one event a queue may not throw away: dispatch is FIFO, so
 * by the time a group is evicted the press it ends may already be on the page,
 * and a dropped `mouse_up` or `key_up` leaves that page holding a button
 * nobody is pressing with no later event able to end it. Small, because only
 * so many buttons and keys can be down at once — and finite, so a pane that
 * sends nothing but releases still cannot grow this relay without limit.
 */
const MAX_RELEASE_CARRY = 8;

/** The events that END something the page is now holding. */
const RELEASE_TYPES: ReadonlySet<string> = new Set(["mouse_up", "key_up"]);

/** Why a batch did not reach the page. The daemon's own vocabulary. */
export type InputRefusal =
  | "lease_required"
  | "lease_held"
  | "lease_parked"
  | "unknown_tab"
  | "no_browser_session"
  | "upstream_error"
  /** Dropped by the relay: too much queued behind a dispatch that is slow. */
  | "overloaded";

export interface RelayInputForwarder {
  /** Queue one client message. Ordering and coalescing are this module's job. */
  submit(message: {
    seq: number;
    tabId?: string;
    events: readonly BrowserPaneInputEvent[];
  }): void;
  /** Drop what is queued and refuse more. Not reusable afterwards. */
  cancel(): void;
  /** Wait for the messages already accepted, without waiting for future input. */
  drain(): Promise<void>;
  /** For tests: is a dispatch outstanding? */
  busy(): boolean;
  /** For tests: how many groups are queued, carried releases included. */
  pendingGroups(): number;
}

export interface RelayInputForwarderOptions {
  /** Opt-in for Node WebMCP; existing local/hosted callers retain their policy. */
  preserveGestureBoundaries?: boolean;
  dispatch(args: {
    tabId?: string;
    events: readonly BrowserPaneInputEvent[];
  }): Promise<{ ok: true } | { ok: false; refused: InputRefusal }>;
  /**
   * Answer one client message.
   *
   * `dispatched` is that message's OWN event count on a flush that landed, and
   * 0 on a refusal — not the size of the coalesced batch, which is a number
   * about the relay rather than about the caller's gesture.
   *
   * A group that is refused PART WAY THROUGH is the one case with no exact
   * answer: coalescing has already merged the messages, so no event can be
   * traced back to the message that produced it. What is delivered is credited
   * to the earliest messages in the group, which is the order they were sent
   * in — and every message in the group still carries the refusal, because the
   * gesture as a whole did not land.
   */
  ack(payload: {
    seq: number;
    dispatched: number;
    refused?: InputRefusal;
  }): void;
  /** Called once per flush that actually reached the page. */
  onDispatched?: () => void;
}

export function createRelayInputForwarder(
  supplied: RelayInputForwarderOptions,
): RelayInputForwarder {
  const settlements = new Map<
    number,
    { promise: Promise<void>; resolve(): void }
  >();
  const options: RelayInputForwarderOptions = {
    ...supplied,
    ack(payload) {
      settlements.get(payload.seq)?.resolve();
      settlements.delete(payload.seq);
      supplied.ack(payload);
    },
  };
  /**
   * Batches waiting for the in-flight dispatch, grouped by tab.
   *
   * Grouped rather than flat because coalescing is only sound WITHIN one page:
   * two tabs' pointer events merged into a single dispatch would put half the
   * gesture on the wrong one. A tab change simply starts a new group, and the
   * groups go out in order.
   */
  let pending: Array<{
    tabId?: string;
    events: BrowserPaneInputEvent[];
    acks: Array<{ seq: number; count: number }>;
  }> = [];
  let inFlight = false;
  let cancelled = false;

  /**
   * Send one group, in pieces the daemon will accept.
   *
   * CHUNKED, because `/v1/input` answers 413 to an oversized batch and
   * dispatches NOTHING of it. A long burst — a fast drag, a key sequence that
   * did not coalesce — therefore refused the whole gesture, RELEASES INCLUDED,
   * and left the page holding a button nobody was pressing.
   */
  const dispatchGroup = async (
    tabId: string | undefined,
    events: readonly BrowserPaneInputEvent[],
  ): Promise<
    { ok: true } | { ok: false; refused: InputRefusal; sent: number }
  > => {
    let sent = 0;
    for (let at = 0; at < events.length; at += BROWSER_INPUT_BATCH_LIMIT) {
      // CHECKED PER CHUNK, not once. `cancel()` runs when the socket goes
      // away, and a long gesture can still have chunks left in this loop when
      // it does — chunks that would reach the page on behalf of a pane that
      // is no longer there, and possibly after the lease has moved to
      // somebody else.
      if (cancelled) return { ok: false, refused: "overloaded", sent };
      const chunk = events.slice(at, at + BROWSER_INPUT_BATCH_LIMIT);
      const outcome = await options.dispatch({
        ...(tabId ? { tabId } : {}),
        events: chunk,
      });
      // In ORDER and stopping at the first refusal: carrying on would put the
      // tail of a gesture into a page that stopped accepting it half way.
      if (!outcome.ok) return { ...outcome, sent };
      sent += chunk.length;
    }
    return { ok: true };
  };

  const flush = (): void => {
    if (inFlight || cancelled || pending.length === 0) return;
    const group = pending.shift()!;
    const events = coalesceBrowserPaneInput(
      group.events,
      options.preserveGestureBoundaries,
    );
    inFlight = true;
    void dispatchGroup(group.tabId, events)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          for (const entry of group.acks) {
            options.ack({ seq: entry.seq, dispatched: entry.count });
          }
          options.onDispatched?.();
          return;
        }
        // A PREFIX THAT LANDED IS STILL USE. `onDispatched` is what defers
        // the idle sweep on a metered machine, and a gesture whose first half
        // reached the page is somebody working, not somebody idle.
        if (outcome.sent > 0) options.onDispatched?.();
        let credit = outcome.sent;
        for (const entry of group.acks) {
          const dispatched = Math.min(entry.count, credit);
          credit -= dispatched;
          options.ack({
            seq: entry.seq,
            dispatched,
            refused: outcome.refused,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        for (const entry of group.acks) {
          options.ack({
            seq: entry.seq,
            dispatched: 0,
            refused: "upstream_error",
          });
        }
      })
      .finally(() => {
        inFlight = false;
        flush();
      });
  };

  return {
    submit(message) {
      if (cancelled || message.events.length === 0) return;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      settlements.set(message.seq, { promise, resolve });
      const tail = pending[pending.length - 1];
      if (tail && tail.tabId === message.tabId) {
        tail.events.push(...message.events);
        tail.acks.push({ seq: message.seq, count: message.events.length });
      } else {
        // The OLDEST goes, not the newest: a pane whose queue has run away is
        // one whose old positions are already wrong, and the gesture somebody
        // is making now is the one worth keeping. Every dropped batch is
        // acked, because a message with no answer is a pane that waits forever.
        const carried: typeof pending = [];
        // COUNTING THE CARRIED ONES TOO. They go back on the front, and the
        // new group goes on the end, so a bound that only looked at what was
        // left in `pending` would settle at the limit PLUS the carry rather
        // than at the limit. This terminates: `carried` stops growing at
        // `MAX_RELEASE_CARRY`, and every turn of the loop takes one out of
        // `pending`.
        while (
          pending.length > 0 &&
          pending.length + carried.length >= MAX_PENDING_GROUPS
        ) {
          const dropped = pending.shift()!;
          for (const entry of dropped.acks) {
            options.ack({
              seq: entry.seq,
              dispatched: 0,
              refused: "overloaded",
            });
          }
          // Its POSITIONS are already wrong and go; its releases do not.
          // Answered as `overloaded` either way — the caller's batch did not
          // land as a batch — but what is left of it still has to reach the
          // page, or a drag that overflowed the queue ends with the button
          // still down.
          const releases = dropped.events.filter((event) =>
            RELEASE_TYPES.has(event.type),
          );
          if (releases.length > 0 && carried.length < MAX_RELEASE_CARRY) {
            carried.push({ ...dropped, events: releases, acks: [] });
          }
        }
        // AHEAD of what is still queued, in the order they were made: they are
        // older than everything left, and a release that arrives after the
        // next press would end the wrong one.
        if (carried.length > 0) pending = [...carried, ...pending];
        pending.push({
          ...(message.tabId !== undefined ? { tabId: message.tabId } : {}),
          events: [...message.events],
          acks: [{ seq: message.seq, count: message.events.length }],
        });
      }
      flush();
    },
    cancel() {
      cancelled = true;
      pending = [];
      for (const settlement of settlements.values()) settlement.resolve();
      settlements.clear();
    },
    async drain() {
      await Promise.all(
        [...settlements.values()].map((entry) => entry.promise),
      );
    },
    busy: () => inFlight,
    pendingGroups: () => pending.length,
  };
}
