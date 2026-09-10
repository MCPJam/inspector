/**
 * What counts as an input event, and how a batch of them collapses.
 *
 * ONE definition, read by four callers that must agree: the pane that produces
 * events, the hosted relay and the local relay that validate them, and (by
 * structural identity) the daemon's own dispatcher. They used to be three
 * copies — `computer-browser-panel.ts`'s `isInputEvent`, `browser-pane/input`'s
 * `coalesceInput`, and the local route's bare `slice` — and the failure mode of
 * three copies is silent: an event type added in one place is dropped by the
 * others with a 200 and no page change, which is indistinguishable from a click
 * that hit a dead area.
 *
 * Deliberately SHAPE-ONLY. What the coordinates mean is the daemon's business
 * (`isPointInViewport` refuses out-of-range points and never clamps); this only
 * refuses to call something an event when it has no type, or a type with none
 * of the fields that type needs.
 *
 * WHY VALIDATION MATTERS BEYOND TIDINESS. The daemon's dispatcher ignores a
 * type it does not recognise, so a batch of nonsense came back 200 having done
 * nothing — and was then counted as REAL USE, which defers the idle sweep on a
 * metered machine. A caller with a valid token could hold a box awake
 * indefinitely without touching the browser at all.
 */

/** A pointer or key event, in the browser's own CSS-pixel space. */
export type BrowserPaneInputEvent =
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
 * The most events one input message may carry.
 *
 * The daemon enforces the same number (`MAX_INPUT_EVENTS`) and is the real
 * gate; this keeps a well-behaved pane's batches from being rejected wholesale
 * at the far end, and bounds what one socket message can cost.
 */
export const BROWSER_INPUT_BATCH_LIMIT = 64;

/**
 * An optional field is either absent or the right kind of value.
 *
 * NOT "absent or anything": a `modifiers: "ctrl"` passed the guard, reached
 * CDP as a string where a bitmask belongs, and the dispatch failed there — on a
 * batch this relay had already acknowledged as delivered. Silently.
 *
 * INTEGER, not merely finite. The two fields this guards — `modifiers` and
 * `clickCount` — are both declared `integer` in CDP, and `modifiers` is a
 * BITMASK besides: 1.5 is not a weaker version of 1, it is a value with no
 * meaning at all. A fraction fails at the same place a string did, one hop
 * past the acknowledgement.
 */
function optionalInteger(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isInteger(value))
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isBrowserPaneInputEvent(
  value: unknown,
): value is BrowserPaneInputEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  const xy =
    typeof event.x === "number" &&
    Number.isFinite(event.x) &&
    typeof event.y === "number" &&
    Number.isFinite(event.y);
  if (!optionalInteger(event.modifiers)) return false;
  switch (event.type) {
    case "mouse_move":
      return xy;
    case "mouse_down":
    case "mouse_up":
      return (
        xy &&
        optionalInteger(event.clickCount) &&
        (event.button === "left" ||
          event.button === "middle" ||
          event.button === "right")
      );
    case "wheel":
      return (
        xy &&
        typeof event.deltaX === "number" &&
        Number.isFinite(event.deltaX) &&
        typeof event.deltaY === "number" &&
        Number.isFinite(event.deltaY)
      );
    case "key_down":
    case "key_up":
      return (
        typeof event.key === "string" &&
        event.key.length > 0 &&
        optionalString(event.code)
      );
    case "text":
      return typeof event.text === "string";
    default:
      return false;
  }
}

/**
 * Collapse a batch to what still has to be delivered.
 *
 * A move that another move immediately replaces is dropped: only the position
 * matters, and an intermediate one nobody saw is not worth a hop. A WHEEL is
 * the opposite — each one is a delta, so dropping any of them loses distance
 * and replaying them one at a time makes the page go on scrolling long after
 * the person stopped. Adjacent wheels at the same point and modifiers are
 * SUMMED, which keeps the distance exact and delivers it as one movement.
 *
 * Only adjacent, and only with the same modifiers: Ctrl+wheel is a zoom rather
 * than a scroll, and merging across a click would move the page under a press
 * that had already landed.
 */
export function coalesceBrowserPaneInput(
  events: readonly BrowserPaneInputEvent[],
  preserveGestureBoundaries = false,
): BrowserPaneInputEvent[] {
  const out: BrowserPaneInputEvent[] = [];
  for (const event of events) {
    const previous = out[out.length - 1];
    if (
      event.type === "mouse_move" &&
      previous?.type === "mouse_move" &&
      (!preserveGestureBoundaries || event.modifiers === previous.modifiers)
    ) {
      out[out.length - 1] = event;
      continue;
    }
    if (
      event.type === "wheel" &&
      previous?.type === "wheel" &&
      event.modifiers === previous.modifiers &&
      event.x === previous.x &&
      event.y === previous.y &&
      (!preserveGestureBoundaries ||
        (Math.sign(event.deltaX) === Math.sign(previous.deltaX) &&
          Math.sign(event.deltaY) === Math.sign(previous.deltaY)))
    ) {
      out[out.length - 1] = {
        ...event,
        deltaX: previous.deltaX + event.deltaX,
        deltaY: previous.deltaY + event.deltaY,
      };
      continue;
    }
    out.push(event);
  }
  return out;
}

/**
 * Read an `{type:"input"}` message off the wire.
 *
 * Refused WHOLE rather than filtered: dropping the bad ones would deliver a
 * batch missing, say, the `mouse_up` of a drag, and the page would be left
 * holding a button down with nothing to say why.
 */
export function parseBrowserPaneInputMessage(
  message: unknown,
):
  | { ok: true; seq: number; tabId?: string; events: BrowserPaneInputEvent[] }
  | { ok: false; error: "invalid_input" } {
  if (typeof message !== "object" || message === null) {
    return { ok: false, error: "invalid_input" };
  }
  const parsed = message as {
    seq?: unknown;
    tabId?: unknown;
    events?: unknown;
  };
  const seq =
    typeof parsed.seq === "number" && Number.isFinite(parsed.seq)
      ? parsed.seq
      : undefined;
  if (seq === undefined || !Array.isArray(parsed.events)) {
    return { ok: false, error: "invalid_input" };
  }
  const batch = parsed.events;
  // REFUSED, not truncated. Slicing here silently discarded the tail of a
  // batch this relay then acknowledged as delivered — and a burst that ends
  // with a release leaves the page holding a button or a key nobody is
  // pressing, with the ack saying it all arrived. Every pane chunks at this
  // same number before it sends, so nothing well-behaved ever meets this.
  if (
    batch.length === 0 ||
    batch.length > BROWSER_INPUT_BATCH_LIMIT ||
    !batch.every(isBrowserPaneInputEvent)
  ) {
    return { ok: false, error: "invalid_input" };
  }
  return {
    ok: true,
    seq,
    ...(typeof parsed.tabId === "string" ? { tabId: parsed.tabId } : {}),
    events: batch as BrowserPaneInputEvent[],
  };
}
