/**
 * The pointer, the keys, and the picture — for any engine's browser pane.
 *
 * Everything here is about a PERSON driving a rendered browser, and nothing in
 * it knows which engine produced the frame or where the events are going. The
 * local pane POSTs them to an in-process daemon, the hosted pane to a replica
 * route that forwards them into a sandbox, and Electron to a `webContents`
 * debugger — the mapping from a click on an `object-contain` image to a page
 * coordinate is the same problem in all three, and getting it slightly
 * different in each is how a drag ends up somewhere nobody aimed.
 *
 * It lived in `lib/local-browser/client.ts` until the hosted pane needed it.
 * That module re-exports it under its old names, so its callers did not move.
 */

import {
  BROWSER_INPUT_BATCH_LIMIT,
  BROWSER_INPUT_TEXT_MAX_CHARS,
  coalesceBrowserPaneInput,
  type BrowserPaneInputEvent,
} from "@/shared/browser-pane-input";

export const INPUT_BATCH_LIMIT = BROWSER_INPUT_BATCH_LIMIT;
export type BrowserInputEvent = BrowserPaneInputEvent;

/**
 * A frame as it arrives: base64 JPEG plus the geometry it measured itself at.
 *
 * The same shape on every engine, because every pane maps a click through it.
 */
export interface PaneFrame {
  /**
   * Base64 JPEG, on the JSON wire.
   *
   * Exactly one of `data` and `bitmap` is set. The JSON envelope is the
   * fallback a client keeps for one release, and the wire a server too old to
   * negotiate `binary` still speaks.
   */
  data?: string;
  /**
   * A picture already decoded off the main thread, on the binary wire.
   *
   * The producing connection owns this and closes it on replacement/teardown.
   * The surface borrows it for drawing; it must not close it a second time.
   */
  bitmap?: ImageBitmap;
  /**
   * How long the decode took, in ms, when the producer measured it.
   *
   * On the JSON wire the surface times its own `Image` load; on the binary
   * wire the decode already happened off the main thread, before the frame
   * ever reached React — so without carrying the number here, the one path
   * every modern viewer takes reported no decode samples at all.
   */
  decodeMs?: number;
  deviceWidth: number;
  deviceHeight: number;
  scale: number;
  /**
   * The SANDBOX's capture clock. Fine for ordering; useless for latency,
   * because on the hosted path it belongs to a different machine than the
   * viewer's.
   */
  ts: number;
  /**
   * When the RELAY saw this frame — the last hop the pane can honestly compare
   * itself against, because it is the hop the pane pings. Absent from a server
   * too old to stamp it.
   */
  relayTs?: number;
  seq: number;
}

/**
 * Where a click on the rendered image lands in the PAGE.
 *
 * Scaling happens here rather than on the server because only the client knows
 * its rendered rectangle and how `object-contain` letterboxes the picture
 * inside it. A click on a letterbox bar is DROPPED rather than mapped to the
 * nearest edge: the page has nothing there, and pretending otherwise puts a
 * click somewhere the person did not aim.
 */
export function toPageCoordinates(
  event: { clientX: number; clientY: number },
  image: { getBoundingClientRect(): DOMRect },
  frame: { deviceWidth: number; deviceHeight: number; scale: number },
  options: {
    /**
     * Clamp to the page instead of dropping, for the events that MUST land.
     *
     * A drag that ends over a letterbox bar is the case: dropping its
     * `mouse_up` leaves the page holding a button down forever, mid-selection.
     * Nothing is guessed about intent — the release is simply attributed to
     * the nearest point the page actually has.
     */
    clampToPage?: boolean;
  } = {},
): { x: number; y: number } | null {
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const cssWidth = frame.deviceWidth / (frame.scale || 1);
  const cssHeight = frame.deviceHeight / (frame.scale || 1);
  if (cssWidth <= 0 || cssHeight <= 0) return null;

  // `object-contain`: the picture is centred and scaled to fit, so the bars
  // are the difference between the element and the fitted picture.
  const fit = Math.min(rect.width / cssWidth, rect.height / cssHeight);
  const renderedWidth = cssWidth * fit;
  const renderedHeight = cssHeight * fit;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;

  const x = (event.clientX - rect.left - offsetX) / fit;
  const y = (event.clientY - rect.top - offsetY) / fit;
  if (x < 0 || y < 0 || x > cssWidth || y > cssHeight) {
    if (!options.clampToPage) return null;
    return {
      x: Math.round(Math.min(Math.max(x, 0), cssWidth)),
      y: Math.round(Math.min(Math.max(y, 0), cssHeight)),
    };
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Batch a person's gestures and get them onto the wire without waiting.
 *
 * WHAT CHANGED IN V-2, and why. This used to serialize: one POST in flight,
 * everything else queued behind it. That was the right shape for HTTP, where N
 * concurrent requests arrive in whatever order the network felt like and an
 * out-of-order drag lands somewhere nobody aimed — but the cost was a full
 * round trip of latency added to every gesture after the first, on a path
 * where the round trip is the thing being complained about.
 *
 * A WebSocket is ORDERED, so the ordering the queue was buying is free. What
 * remains worth doing on the client is batching: a drag fires a `mousemove`
 * per animation frame and there is no point sending each one as its own
 * message. So gestures accumulate for one frame and go together, EXCEPT the
 * ones a person can feel — a button or key transition flushes immediately,
 * because a click that waits for the next frame is a click that feels late.
 *
 * Ordering is still enforced BEHIND the socket (`browser-pane-input-forwarder`
 * on the relay keeps one dispatch in flight to the daemon), which is where it
 * has to live: the hop that can reorder is the one that must not.
 *
 * A queue is also a way to send input under a permission that has since gone.
 * `cancel()` is what the pane calls when the lease is handed back or the
 * project changes: whatever is still queued belonged to the hold that just
 * ended, and delivering it afterwards types into somebody else's page.
 */
export function createInputForwarder(
  send: (events: BrowserInputEvent[], seq: number) => Promise<unknown> | void,
  options: {
    /**
     * Deliver batches on an animation frame rather than per gesture.
     *
     * Injected so tests can drive it; also the seam for a jsdom environment,
     * which has `requestAnimationFrame` but not a real display refresh.
     */
    schedule?: (fn: () => void) => void;
    /**
     * Serialize, as the POST fallback must — see `send`'s contract.
     *
     * A FUNCTION, not a flag: the socket's `hello` arrives after the pane has
     * already built its forwarder, so whether this send can be concurrent is
     * not known when the forwarder is made. Read at flush time.
     */
    serialize?: () => boolean;
  } = {},
) {
  const schedule =
    options.schedule ??
    ((fn: () => void) => {
      if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(fn);
      else setTimeout(fn, 16);
    });
  let queue: BrowserInputEvent[] = [];
  let scheduled = false;
  let inFlight = 0;
  /**
   * Was the outstanding send one that has to be waited on?
   *
   * The transport can change WHILE a send is in flight — a `hello` arrives, a
   * socket reconnects — and a socket message sent while an older POST is still
   * travelling can reach the daemon first. So the wait outlives the condition
   * that caused it: whatever started serialized stays serialized until it
   * settles.
   */
  let inFlightSerialized = 0;
  let cancelled = false;
  /** The id this pane stamps on each batch, so an ack can name one. */
  let seq = 0;

  const flush = () => {
    scheduled = false;
    // A LOOP, not one batch: a send that completes synchronously (the socket)
    // must be able to drain what is queued in the same tick, and the batch
    // limit below can leave a tail behind. Deferring that tail to the next
    // animation frame is exactly the latency this is meant to remove.
    for (;;) {
      if (cancelled || queue.length === 0) return;
      // Serialized only on the POST fallback: concurrent POSTs are unordered,
      // and an unordered drag lands where nobody aimed. On the socket this is
      // false, because the socket is ordered and waiting would put a round
      // trip back into every gesture.
      if (
        inFlight >= 16 ||
        (inFlight > 0 && (inFlightSerialized > 0 || options.serialize?.()))
      )
        return;
      // Chunked at the server's own batch limit. The routes SLICE what they
      // will accept, so a single oversized message silently drops its tail —
      // which for key and button events means a page left holding a key
      // nobody is pressing.
      const coalesced = coalesceInput(queue);
      const batch = coalesced.splice(0, INPUT_BATCH_LIMIT);
      queue = coalesced;
      const mine = (seq += 1);
      inFlight += 1;
      const serialized = options.serialize?.() ?? false;
      if (serialized) inFlightSerialized += 1;
      const outcome = send(batch, mine);
      if (
        !outcome ||
        typeof (outcome as Promise<unknown>).then !== "function"
      ) {
        inFlight -= 1;
        if (serialized) inFlightSerialized -= 1;
        continue;
      }
      void (outcome as Promise<unknown>)
        .catch(() => {
          // A refused batch is not worth a banner; the ack or the lease read
          // says why.
        })
        .finally(() => {
          inFlight -= 1;
          if (serialized) inFlightSerialized -= 1;
          // Directly, not on the next frame: this batch already waited a
          // whole round trip for its turn.
          if (queue.length > 0) flush();
        });
      return;
    }
  };

  const armFlush = () => {
    if (scheduled || cancelled) return;
    scheduled = true;
    schedule(flush);
  };

  return {
    push(events: BrowserInputEvent[]) {
      if (cancelled || events.length === 0) return;
      let urgent = false;
      for (const event of events) {
        // The transitions a person can FEEL. A move is one of a stream and
        // nobody notices which frame it went in; a press, a release or a key
        // is a discrete act, and holding it for the next animation frame is
        // exactly the lag this whole wave is about.
        if (
          event.type === "mouse_down" ||
          event.type === "mouse_up" ||
          event.type === "key_down" ||
          event.type === "key_up" ||
          event.type === "text"
        ) {
          urgent = true;
        }
        if (event.type === "text") {
          // Never split a surrogate pair between insertText calls.
          for (let start = 0; start < event.text.length;) {
            let end = Math.min(
              start + BROWSER_INPUT_TEXT_MAX_CHARS,
              event.text.length,
            );
            const last = event.text.charCodeAt(end - 1);
            if (end < event.text.length && last >= 0xd800 && last <= 0xdbff)
              end--;
            queue.push({ type: "text", text: event.text.slice(start, end) });
            start = end;
          }
        } else {
          const tail = queue.pop();
          queue.push(
            ...coalesceBrowserPaneInput(tail ? [tail, event] : [event], true),
          );
        }
      }
      if (urgent) {
        flush();
        return;
      }
      armFlush();
    },
    /** Drop what is queued and refuse more. Not reusable afterwards. */
    cancel() {
      cancelled = true;
      queue = [];
    },
  };
}

/** Drop a move that another move immediately replaces. */
export function coalesceInput(
  events: readonly BrowserInputEvent[],
): BrowserInputEvent[] {
  return coalesceBrowserPaneInput(events, true);
}

/** CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}
