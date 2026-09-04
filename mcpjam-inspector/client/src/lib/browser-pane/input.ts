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

/**
 * The most events one input request may carry.
 *
 * Mirrors the limit both input routes slice at — `routes/mcp/computers.ts`
 * for the local engine, `routes/web/computer-browser-panel.ts` for the hosted
 * one — and the daemon's own `MAX_INPUT_EVENTS` behind them. Kept in step by
 * hand, since the client cannot import a server module, and pinned by a test
 * on each side.
 */
export const INPUT_BATCH_LIMIT = 64;

/** A pointer or key event, in the browser's own CSS-pixel space. */
export type BrowserInputEvent =
  | { type: "mouse_move"; x: number; y: number; modifiers?: number }
  | {
      type: "mouse_down" | "mouse_up";
      x: number;
      y: number;
      button: "left" | "middle" | "right";
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: "key_down" | "key_up";
      key: string;
      code?: string;
      modifiers?: number;
    }
  | { type: "text"; text: string };


/**
 * A frame as it arrives: base64 JPEG plus the geometry it measured itself at.
 *
 * The same shape on every engine, because every pane maps a click through it.
 */
export interface PaneFrame {
  data: string;
  deviceWidth: number;
  deviceHeight: number;
  scale: number;
  ts: number;
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
 * Bound how much pointer traffic is in flight at once.
 *
 * A person dragging generates a `mousemove` per frame, and one POST each meant
 * dozens of concurrent unordered requests: input arriving out of order puts a
 * drag somewhere it never went. One request is in flight at a time, the rest
 * queue, and consecutive moves in the queue collapse — an intermediate
 * position nobody saw is not worth a round trip, but the one they stopped at
 * always is.
 *
 * A queue is also a way to send input under a permission that has since gone.
 * `cancel()` is what the pane calls when the lease is handed back or the
 * project changes: whatever is still queued belonged to the hold that just
 * ended, and delivering it afterwards types into somebody else's page.
 */
export function createInputForwarder(
  send: (events: BrowserInputEvent[]) => Promise<unknown>,
) {
  let queue: BrowserInputEvent[] = [];
  let inFlight = false;
  let cancelled = false;

  const flush = () => {
    if (inFlight || cancelled || queue.length === 0) return;
    // Chunked at the server's own batch limit. A slow POST can leave more than
    // this queued, and the route SLICES what it will accept — so a single
    // oversized request silently drops its tail, which for key and button
    // events means a page left holding a key nobody is pressing.
    const coalesced = coalesceInput(queue);
    const batch = coalesced.splice(0, INPUT_BATCH_LIMIT);
    queue = coalesced;
    inFlight = true;
    void send(batch)
      .catch(() => {
        // A refused batch is not worth a banner; the lease read says why.
      })
      .finally(() => {
        inFlight = false;
        flush();
      });
  };

  return {
    push(events: BrowserInputEvent[]) {
      if (cancelled || events.length === 0) return;
      queue.push(...events);
      flush();
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
  const out: BrowserInputEvent[] = [];
  for (const event of events) {
    if (
      event.type === "mouse_move" &&
      out.length > 0 &&
      out[out.length - 1]?.type === "mouse_move"
    ) {
      out[out.length - 1] = event;
      continue;
    }
    out.push(event);
  }
  return out;
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
