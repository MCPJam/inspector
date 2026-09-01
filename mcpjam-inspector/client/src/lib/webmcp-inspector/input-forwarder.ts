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
  /** The frame's surface, in device pixels. */
  frame: { width: number; height: number };
}

export interface InputForwarderOptions {
  /** Deliver one batch. Rejections are swallowed by the caller's own handling. */
  send: (events: WebMcpInputEvent[]) => void;
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
    const batch = buffer;
    buffer = [];
    options.send(batch);
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
    } else {
      buffer.push(event);
    }

    if (immediate) {
      flush();
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
      for (let i = 0; i < text.length; i += WEBMCP_INPUT_TEXT_MAX_CHARS) {
        queue(
          {
            kind: "text",
            text: text.slice(i, i + WEBMCP_INPUT_TEXT_MAX_CHARS),
          },
          true,
        );
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
      buffer = [];
      heldKeys.clear();
      heldButtons.clear();
    },
  };
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
