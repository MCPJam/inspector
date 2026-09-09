/**
 * Turn what a person does to the pane into events the page can be driven with.
 *
 * Three jobs, each of which is a visible bug when it is missing:
 *
 *   - SCALING. The pane is whatever size the layout gives it and the frame is
 *     1280x800; a click at the pane's centre has to land at the page's centre.
 *     This happens on the CLIENT because only the client knows its own rendered
 *     rectangle and how the picture is letterboxed inside it, and it scales
 *     against the dimensions of the frame currently on screen so the mapping
 *     stays exact even while a resize is in flight.
 *   - BATCHING. A drag produces pointer events faster than any transport wants
 *     requests. Moves coalesce to the latest and flush on a short timer; button
 *     transitions flush IMMEDIATELY, because a click that waits out a batch
 *     window feels broken in a way a slightly-late mouse trail never does.
 *     Wheels are their own case: a scroll is as latency-sensitive as a click,
 *     so the first one of a gesture ships at once, and the ones behind it
 *     COALESCE BY SUMMING their deltas while a request is in flight. That
 *     bounds the flood by the transport's real capacity — one request per
 *     completed round trip — rather than by a fixed timer that can pile up
 *     behind a slow one, and it loses nothing: scroll distance is additive.
 *   - RELEASING HELD KEYS. The pane can lose focus mid-chord — alt-tab between
 *     keydown and keyup — and the browser never sends the keyup. Without an
 *     explicit release, that modifier stays down in the page forever and every
 *     later click is a ctrl-click.
 *
 * Deliberately free of React and of the store: it takes a send function and a
 * way to read the current geometry, which is what makes all of the above
 * testable without rendering anything.
 */
import { WEBMCP_INPUT_TEXT_MAX_CHARS } from "@/shared/webmcp-inspector-protocol";
import type {
  WebMcpInputEvent,
  WebMcpInputModifiers,
  WebMcpMouseButton,
} from "@/shared/webmcp-inspector-protocol";

/** How long moves may accumulate before a flush. ~20 batches a second. */
export const INPUT_FLUSH_MS = 50;

/** The pane's rendered box, and the frame being rendered inside it. */
export interface ViewportGeometry {
  /** The `<img>`'s own rectangle, in CSS pixels. */
  rect: { left: number; top: number; width: number; height: number };
  /**
   * The frame's surface in CSS PIXELS — the page's own coordinate space.
   *
   * Not the frame's device pixels: a session may render at more than one
   * device pixel per CSS pixel, and the events this produces are dispatched
   * against the page, which knows nothing about that.
   */
  frame: { width: number; height: number };
}

export interface InputForwarderOptions {
  /**
   * Deliver one batch.
   *
   * A returned promise is the in-flight CLOCK for wheel flushing: it must
   * settle when the batch has actually reached the server, which for the
   * store's `sendInput` means after its serialized chain and its POST. A
   * `void` return is still accepted — the forwarder then behaves as it always
   * has, flushing each wheel immediately — so a caller that cannot report
   * completion is not broken by this.
   */
  send: (events: WebMcpInputEvent[]) => void | Promise<void>;
  /** Read the CURRENT geometry — it changes with every layout and every frame. */
  geometry: () => ViewportGeometry | undefined;
  flushMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Map a point in the pane to a point on the page.
 *
 * `object-contain` letterboxes: the picture keeps its aspect ratio and is
 * centred, so the bars are dead space that must NOT be scaled into the page.
 * Returns undefined for a point inside the pane but outside the picture —
 * clicking a letterbox bar is clicking nothing, and mapping it to the nearest
 * edge would fire events on page content the person never pointed at.
 */
export function toFrameCoordinates(
  clientX: number,
  clientY: number,
  geometry: ViewportGeometry,
): { x: number; y: number } | undefined {
  const { rect, frame } = geometry;
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  if (frame.width <= 0 || frame.height <= 0) return undefined;

  // The rendered picture, once `object-contain` has fitted it.
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  const renderedWidth = frame.width * scale;
  const renderedHeight = frame.height * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;

  const withinX = clientX - rect.left - offsetX;
  const withinY = clientY - rect.top - offsetY;
  if (
    withinX < 0 ||
    withinY < 0 ||
    withinX > renderedWidth ||
    withinY > renderedHeight
  ) {
    return undefined;
  }

  return {
    // Rounded, and held one pixel inside the far edge: a click exactly on the
    // boundary would otherwise map to `frame.width`, which is one past the last
    // addressable pixel.
    x: Math.min(Math.round(withinX / scale), frame.width - 1),
    y: Math.min(Math.round(withinY / scale), frame.height - 1),
  };
}

/**
 * Where to cut a string so the piece is at most `max` UTF-16 units AND the cut
 * never lands between a surrogate pair.
 *
 * The halves of a split paste travel as SEPARATE events, in separate requests,
 * and each is handed to `keyboard.insertText` on its own — so a pair broken at
 * the boundary reaches the page as a lone high surrogate followed by a lone low
 * one, and the character is lost rather than merely delayed. Every emoji and
 * every astral-plane script is a pair, so this is ordinary pasted text rather
 * than an exotic case.
 */
export function cutBefore(text: string, start: number, max: number): number {
  const end = Math.min(start + max, text.length);
  if (end >= text.length) return end;
  // A high surrogate at the end means its low half is the very next unit.
  const last = text.charCodeAt(end - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  // Never return `start`: a cut that made no progress would loop forever.
  return splitsPair && end - 1 > start ? end - 1 : end;
}

/** Read the modifier flags off a DOM event, omitting the ones that are off. */
export function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): WebMcpInputModifiers | undefined {
  const modifiers: WebMcpInputModifiers = {};
  if (event.altKey) modifiers.alt = true;
  if (event.ctrlKey) modifiers.ctrl = true;
  if (event.metaKey) modifiers.meta = true;
  if (event.shiftKey) modifiers.shift = true;
  return Object.keys(modifiers).length > 0 ? modifiers : undefined;
}

/**
 * DOM `button` numbers, as the protocol names them.
 *
 * Undefined for the auxiliary buttons (back, forward, and whatever a gaming
 * mouse reports). Folding those into "left" would turn a thumb-button press
 * into a click on whatever the pointer happened to be over, which is a page
 * mutation the person did not ask for — far worse than the button doing
 * nothing.
 */
export function buttonOf(button: number): WebMcpMouseButton | undefined {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return undefined;
}

export interface InputForwarder {
  mouseMove(event: PointerLikeEvent): void;
  mouseDown(event: PointerLikeEvent): void;
  mouseUp(event: PointerLikeEvent): void;
  wheel(event: WheelLikeEvent): void;
  keyDown(event: KeyLikeEvent): void;
  keyUp(event: KeyLikeEvent): void;
  /** Paste and IME composition, which have no keystrokes to replay. */
  text(text: string): void;
  /**
   * Release everything still held, and flush.
   *
   * Called on blur and on unmount. The page cannot see that focus left, so
   * without this a modifier held at that moment stays held in the page for the
   * rest of the session.
   */
  releaseHeld(): void;
  /** Send whatever is buffered right now. */
  flush(): void;
  /** Drop the buffer and the timer without sending. */
  dispose(): void;
}

export interface PointerLikeEvent {
  clientX: number;
  clientY: number;
  button: number;
  detail?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface WheelLikeEvent extends PointerLikeEvent {
  deltaX: number;
  deltaY: number;
}

export interface KeyLikeEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function createInputForwarder(
  options: InputForwarderOptions,
): InputForwarder {
  const flushMs = options.flushMs ?? INPUT_FLUSH_MS;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let buffer: WebMcpInputEvent[] = [];
  let timer: unknown;
  /**
   * Batches handed to `send` that have not settled yet.
   *
   * The wheel path's clock. Zero means the transport is idle and a wheel can
   * go right now; above zero means one is already on the wire, and the newest
   * wheel waits — by merging into the one already queued — rather than adding
   * to a queue that grows for as long as the person keeps scrolling.
   */
  let sendsInFlight = 0;
  /** A wheel arrived while busy; flush as soon as the transport frees up. */
  let flushOnSettle = false;
  /** Keys and buttons the page believes are down because we told it so. */
  const heldKeys = new Set<string>();
  const heldButtons = new Set<WebMcpMouseButton>();
  /**
   * The last point inside the picture, so a release can always be delivered
   * SOMEWHERE. A drag that ends over a letterbox bar or off the pane still has
   * to end in the page; a swallowed mouse-up leaves the button held there and
   * every later movement reads as a continuing drag.
   */
  let lastPoint = { x: 0, y: 0 };

  const flush = () => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    if (buffer.length === 0) return;
    flushOnSettle = false;
    const batch = buffer;
    buffer = [];
    const sent = options.send(batch);
    // A caller that reports nothing leaves `sendsInFlight` at zero, which is
    // exactly the old behaviour: every wheel flushes immediately.
    if (!sent || typeof sent.then !== "function") return;
    sendsInFlight += 1;
    const settle = () => {
      sendsInFlight -= 1;
      // Also on REJECTION. A failed request that left the count raised would
      // wedge the wheel path for the rest of the session — every later scroll
      // silently coalescing into a batch nothing would ever flush.
      if (sendsInFlight === 0 && flushOnSettle) flush();
    };
    sent.then(settle, settle);
  };

  /**
   * Queue an event.
   *
   * `immediate` is for button and key transitions. A click held back by even
   * one flush window reads as a dropped click, whereas a mouse trail arriving
   * 50ms late reads as nothing at all.
   */
  const queue = (event: WebMcpInputEvent, immediate = false) => {
    if (event.kind === "mouse_move") {
      // Coalesce to the latest: the intermediate positions of a drag are not
      // information the page can use, and sending them is the flood.
      const last = buffer[buffer.length - 1];
      if (last?.kind === "mouse_move") buffer[buffer.length - 1] = event;
      else buffer.push(event);
    } else if (event.kind === "wheel") {
      const last = buffer[buffer.length - 1];
      if (last?.kind === "wheel" && sameModifiers(last, event)) {
        // SUM the deltas rather than keep the latest: scroll distance is
        // additive, and keeping only the newest would make a fast flick move
        // the page less than a slow one. The newest coordinate wins, because
        // that is where the pointer is now.
        buffer[buffer.length - 1] = {
          ...event,
          deltaX: last.deltaX + event.deltaX,
          deltaY: last.deltaY + event.deltaY,
        };
      } else {
        // Modifiers differ, so these are different gestures: a ctrl-wheel is a
        // ZOOM, and folding it into a plain scroll would change what the page
        // is being asked to do.
        buffer.push(event);
      }
    } else {
      buffer.push(event);
    }

    if (immediate) {
      flush();
      return;
    }
    if (event.kind === "wheel") {
      // Nothing on the wire: go now, so the FIRST wheel of a gesture costs no
      // added latency at all. Otherwise mark it and let the settle flush it —
      // the flood bound becomes the transport's real capacity rather than a
      // fixed rate that can pile up behind a slow request.
      if (sendsInFlight === 0) flush();
      else flushOnSettle = true;
      return;
    }
    if (timer === undefined) timer = setTimer(flush, flushMs);
  };

  const at = (event: PointerLikeEvent) => {
    const geometry = options.geometry();
    if (!geometry) return undefined;
    const point = toFrameCoordinates(event.clientX, event.clientY, geometry);
    if (point) lastPoint = point;
    return point;
  };

  return {
    mouseMove(event) {
      const point = at(event);
      if (!point) return;
      queue({ kind: "mouse_move", ...point, ...withModifiers(event) });
    },

    mouseDown(event) {
      const button = buttonOf(event.button);
      if (!button) return;
      const point = at(event);
      if (!point) return;
      heldButtons.add(button);
      queue(
        {
          kind: "mouse_down",
          ...point,
          button,
          // `detail` is the browser's own click counter, which is what turns a
          // second click into a double-click and a third into a text-selecting
          // triple. Recomputing it from timestamps here would get the platform's
          // own threshold wrong.
          ...(event.detail && event.detail > 1
            ? { clickCount: Math.min(event.detail, 3) }
            : {}),
          ...withModifiers(event),
        },
        true,
      );
    },

    mouseUp(event) {
      const button = buttonOf(event.button);
      if (!button) return;
      // Falls back to the last point inside the picture rather than dropping
      // the release. A drag released over a letterbox bar or outside the pane
      // still delivers its mouse-up here — otherwise the page keeps the button
      // held forever and every later move is an ongoing drag.
      const point = at(event) ?? lastPoint;
      heldButtons.delete(button);
      queue(
        {
          kind: "mouse_up",
          ...point,
          button,
          ...(event.detail && event.detail > 1
            ? { clickCount: Math.min(event.detail, 3) }
            : {}),
          ...withModifiers(event),
        },
        true,
      );
    },

    wheel(event) {
      const point = at(event);
      if (!point) return;
      queue({
        kind: "wheel",
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        ...withModifiers(event),
      });
    },

    keyDown(event) {
      heldKeys.add(event.key);
      queue(
        { kind: "key_down", key: event.key, ...withModifiers(event) },
        true,
      );
    },

    keyUp(event) {
      heldKeys.delete(event.key);
      queue({ kind: "key_up", key: event.key, ...withModifiers(event) }, true);
    },

    text(text) {
      if (!text) return;
      // Split rather than sent whole and refused: the route caps one `text`
      // event, and a long paste arriving as an invalid command would lose the
      // whole paste rather than arrive as two.
      for (let i = 0; i < text.length;) {
        const end = cutBefore(text, i, WEBMCP_INPUT_TEXT_MAX_CHARS);
        queue({ kind: "text", text: text.slice(i, end) }, true);
        i = end;
      }
    },

    releaseHeld() {
      for (const key of heldKeys) buffer.push({ kind: "key_up", key });
      heldKeys.clear();
      for (const button of heldButtons) {
        // Released where the pointer last WAS, not at the origin: a drag
        // interrupted by an alt-tab should end where the person left it, and
        // releasing at (0,0) would drag the page's content there first.
        buffer.push({ kind: "mouse_up", ...lastPoint, button });
      }
      heldButtons.clear();
      flush();
    },

    flush,

    dispose() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      // Emptying the buffer is also what neutralises a settle still to come:
      // its flush finds nothing to send. `sendsInFlight` is deliberately left
      // alone — those requests are still on the wire and their settles are
      // still the right bookkeeping.
      buffer = [];
      heldKeys.clear();
      heldButtons.clear();
    },
  };
}

/**
 * Whether two events were produced with the same modifiers held.
 *
 * Compared field by field rather than by reference or JSON: the snapshots are
 * built fresh per event and omit the flags that are off, so two "nothing held"
 * events are both `undefined` and two shift-held ones are distinct objects.
 */
function sameModifiers(
  a: { modifiers?: WebMcpInputModifiers },
  b: { modifiers?: WebMcpInputModifiers },
): boolean {
  const left = a.modifiers ?? {};
  const right = b.modifiers ?? {};
  return (
    !!left.alt === !!right.alt &&
    !!left.ctrl === !!right.ctrl &&
    !!left.meta === !!right.meta &&
    !!left.shift === !!right.shift
  );
}

function withModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): { modifiers?: WebMcpInputModifiers } {
  const modifiers = modifiersOf(event);
  return modifiers ? { modifiers } : {};
}
