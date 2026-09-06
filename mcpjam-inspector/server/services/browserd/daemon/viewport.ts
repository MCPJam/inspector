/**
 * Watching the page, and touching it — over CDP, for every engine.
 *
 * The model gets screenshots through the command queue. A PERSON needs
 * something else: a live picture, and a way to click and type into it, so they
 * can solve the CAPTCHA or the SSO prompt the agent cannot. That is what this
 * is, and it is written against `CdpLike` — the same two-method surface the
 * WebMCP bridge uses — so the local engine's Playwright session, the hosted
 * daemon's, and Electron's `webContents.debugger` all satisfy it without a
 * line of per-engine code.
 *
 * FOUR PROPERTIES, each of which is a bug if dropped. They are the WebMCP
 * inspector's, learned there against a real Chromium (see
 * `docs/webmcp-inspector.md`), and they do not stop being true because the
 * frames now come from browserd:
 *
 *   1. ACK FIRST. Chromium sends the next frame only once the current one is
 *      acknowledged. Acking after consumption lets a slow consumer starve the
 *      stream into stillness — the pane freezes on whatever it was showing
 *      when the consumer fell behind, with nothing to correct it.
 *   2. A BYTE-IDENTICAL FRAME IS DROPPED. Every `Page.captureScreenshot` makes
 *      Chromium produce a compositor frame to satisfy the copy, and the
 *      screencast sends that frame back verbatim. Publishing it would make
 *      each capture induce the next one.
 *   3. THE TRAILING FRAME IS MANDATORY. The last paint of a burst is the one
 *      that shows what the page ended up looking like; a plain drop-inside-the
 *      -window throttle loses exactly that frame and leaves a settled page
 *      stale forever.
 *   4. FRAMES NEVER TICK THE IDLE CLOCK, but SUBSCRIBING does. A CSS spinner
 *      paints forever, and a browser that could not be reaped while animating
 *      would outlive the person who opened it. Asking for the stream is a
 *      person arriving; a frame is not.
 *
 * The stream is demand-driven: Chromium is told to paint only while someone is
 * watching, and told to stop when the last of them leaves.
 */
import { createFrameThrottle } from "../../webmcp-inspector/frame-throttle";
import { readJpegDimensions } from "../../../../shared/jpeg-dimensions";
import type { CdpLike } from "./webmcp-bridge";

/** One frame, as the transports carry it. Base64 so it survives JSON. */
export interface ViewportFrame {
  /** Base64 JPEG. */
  data: string;
  /** The picture's OWN dimensions, read from its SOF marker. */
  deviceWidth: number;
  deviceHeight: number;
  /** Device pixels per CSS pixel, so clicks scale against what is shown. */
  scale: number;
  ts: number;
  seq: number;
}

/** A pointer/keyboard event forwarded from the pane. */
export type ViewportInputEvent =
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

export interface TabViewportOptions {
  /** The CSS-pixel surface the frames describe (the canonical viewport). */
  surface: { width: number; height: number };
  /** JPEG quality. Motion-friendly by default, as the inspector's is. */
  quality?: number;
  /** Floor on the gap between published frames. */
  minIntervalMs?: number;
  /** Frames above this are dropped rather than published. */
  maxFrameBytes?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_QUALITY = 75;
const DEFAULT_MIN_INTERVAL_MS = 100;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

export type ViewportListener = (frame: ViewportFrame) => void;

export interface TabViewport {
  /**
   * Watch this tab. The screencast starts on the FIRST subscriber and stops
   * after the last one leaves, so a browser nobody is looking at is not
   * encoding JPEGs.
   */
  subscribe(listener: ViewportListener): () => void;
  subscriberCount(): number;
  /**
   * Forward a person's input.
   *
   * `stillPermitted` is re-asked before every event rather than once for the
   * batch: 64 keystrokes and pointer moves can span a handoff, and the events
   * after it belong to whoever holds the lease now, not to whoever sent them.
   * Omitted by callers that have no lease to consult (tests, fakes).
   *
   * `holder` names whose input this is. A change of hand drops the button
   * mask, because the release for anything the last hand was holding is never
   * coming — their pane stopped sending the moment they lost the lease.
   */
  dispatchInput(
    events: readonly ViewportInputEvent[],
    stillPermitted?: () => boolean,
    holder?: string,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export function createTabViewport(
  cdp: CdpLike,
  options: TabViewportOptions,
): TabViewport {
  const quality = options.quality ?? DEFAULT_QUALITY;
  const maxBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const now = options.now ?? Date.now;
  const listeners = new Set<ViewportListener>();
  let streaming = false;
  let streamGeneration = 0;
  let disposed = false;
  /**
   * Which mouse buttons are down RIGHT NOW.
   *
   * CDP's `buttons` is the mask of buttons still held, not the button this
   * event is about — so sending the released button's bit on `mouseReleased`
   * tells Chromium the drag is still going, and omitting the mask on
   * `mouseMoved` tells it a drag is not happening at all. One is a page stuck
   * mid-selection, the other is a drag that never moves anything.
   */
  let buttonMask = 0;
  /**
   * Batches dispatch one after another, never interleaved.
   *
   * `buttonMask` is read, modified and written across an await PER EVENT, so
   * two batches in flight together shred it: the losing one's release clears a
   * bit the winning one just set. The lease makes that likely rather than
   * exotic — the outgoing holder's queued batch and the incoming holder's
   * first click overlap by construction — and the visible result is a drag
   * that turns into a hover halfway through someone's gesture. Input is a
   * sequence; this is what makes it one.
   */
  let inputChain: Promise<void> = Promise.resolve();
  /** Whose input the current `buttonMask` describes. */
  let inputHolder: string | undefined;
  let lastData: string | undefined;
  let seq = 0;

  const publish = (frame: ViewportFrame) => {
    for (const listener of listeners) {
      try {
        listener(frame);
      } catch {
        // One bad subscriber must not take the stream down for the others.
      }
    }
  };

  const throttle = createFrameThrottle<ViewportFrame>({
    minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    emit: publish,
    ...(options.now ? { now: options.now } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
  });

  cdp.on("Page.screencastFrame", (payload) => {
    const frame = payload as {
      data?: string;
      sessionId?: number;
      metadata?: { deviceWidth?: number; deviceHeight?: number };
    };
    // ACK FIRST — before the size check, before the throttle, before anything
    // that could fail or defer. See property 1.
    if (frame.sessionId !== undefined) {
      void cdp
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => {});
    }
    if (!streaming || disposed || !frame.data) return;
    // Property 2.
    if (frame.data === lastData) return;
    lastData = frame.data;

    // A frame is transient — the next paint replaces it — so an oversized one
    // is dropped rather than re-encoded in the hot path.
    const bytes = Math.floor((frame.data.length * 3) / 4);
    if (bytes > maxBytes) return;

    const measured = measure(frame.data, options.surface);
    throttle.push({
      data: frame.data,
      deviceWidth: measured.width,
      deviceHeight: measured.height,
      scale: measured.scale,
      ts: now(),
      seq: (seq += 1),
    });
  });

  const start = async () => {
    if (streaming || disposed) return;
    streaming = true;
    // Which start/stop pair this is. A subscriber who leaves and comes
    // straight back issues stop→start while the previous `startScreencast`
    // is still in flight; without this its failure handler would clear
    // `streaming` for the NEW stream and leave the watcher with a still
    // picture and no way to ask again.
    const generation = ++streamGeneration;
    // The first frame of a (re)started cast is the current picture, and must
    // not be dropped as a duplicate of the last frame of the previous one —
    // that frame is exactly what a newly arrived watcher is waiting for.
    lastData = undefined;
    await cdp
      .send("Page.startScreencast", {
        format: "jpeg",
        quality,
        // Not multiplied by any device scale: Chromium clamps a screencast to
        // the CSS size of the surface, so asking for more is a no-op that only
        // makes this line look like a promise.
        maxWidth: options.surface.width,
        maxHeight: options.surface.height,
      })
      .catch(() => {
        // Reported by falling back to "not streaming" rather than thrown: a
        // browser that cannot screencast should degrade to a still-image pane,
        // not fail the session that asked to watch it. Only the CURRENT
        // attempt may draw that conclusion.
        if (generation === streamGeneration) streaming = false;
      });
  };

  const stop = async () => {
    if (!streaming) return;
    streaming = false;
    streamGeneration += 1;
    throttle.reset();
    await cdp.send("Page.stopScreencast").catch(() => {});
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void start();
      return () => {
        listeners.delete(listener);
        // Property 4's other half: nobody is watching, so stop painting.
        if (listeners.size === 0) void stop();
      };
    },
    subscriberCount: () => listeners.size,
    async dispatchInput(events, stillPermitted, holder) {
      const run = inputChain.then(() =>
        dispatchBatch(events, stillPermitted, holder),
      );
      // The chain must never carry a rejection forward, or one failed batch
      // would refuse every batch after it for the life of the viewport.
      inputChain = run.catch(() => {});
      return run;
    },
    async dispose() {
      disposed = true;
      buttonMask = 0;
      listeners.clear();
      await stop();
    },
  };

  async function dispatchBatch(
    events: readonly ViewportInputEvent[],
    stillPermitted?: () => boolean,
    holder?: string,
  ): Promise<void> {
    if (holder !== inputHolder) {
      // A different hand. The refusal path below only fires when a batch is
      // interrupted, and the common handoff is not interrupted at all: the
      // outgoing holder's `mouse_down` completes cleanly under a lease they
      // still had, and the `mouse_up` that would clear it is never sent —
      // their pane stopped the moment they lost the browser. The bit would
      // then sit here until someone happened to press and release that same
      // button, so the next holder's first hover reaches Chromium as a drag.
      buttonMask = 0;
      inputHolder = holder;
    }
    // Re-asked HERE, not at the call, because a batch that waited its turn in
    // the chain may have been queued under a lease that has since changed
    // hands — and a disposed viewport's page is gone: its tab was closed,
    // replaced, or the whole browser is coming down. Its CDP session speaks
    // for nothing, and the dispose that retired it also dropped the button
    // mask, so anything sent here would carry a mask describing no page.
    if (disposed) return;
    for (const event of events) {
      if (stillPermitted && !stillPermitted()) {
        // The batch stops mid-gesture, so the release for anything held will
        // never arrive. Forget it: the mask is shared by whoever holds the
        // browser NEXT, and a bit left set means their first hover reaches
        // Chromium as a drag, selecting text they never grabbed.
        buttonMask = 0;
        return;
      }
      // Computed, dispatched, and only THEN committed. `dispatchOne` can
      // reject (a closed target, a detached session) and its rejection is
      // swallowed here; committing first would leave the local mask claiming
      // a button Chromium never received.
      const next =
        event.type === "mouse_down"
          ? buttonMask | (BUTTON_MASK[event.button] ?? 1)
          : event.type === "mouse_up"
            ? buttonMask & ~(BUTTON_MASK[event.button] ?? 1)
            : buttonMask;
      try {
        // Each event under its own catch: one exotic key must not swallow
        // the click behind it.
        await dispatchOne(cdp, event, next);
        buttonMask = next;
      } catch {
        // A failed event does not advance what we believe the page holds.
      }
    }
  }
}

/**
 * A frame's own geometry.
 *
 * From the JPEG's SOF marker, never from CDP's metadata: the client scales
 * pointer coordinates against what a frame CLAIMS to be, and metadata reports
 * DIP whatever the device scale factor is, so any disagreement puts every
 * click in the wrong place. `scale` is derived the same way — device pixels
 * per CSS pixel of the surface we asked Chromium to paint.
 */
function measure(
  base64: string,
  surface: { width: number; height: number },
): { width: number; height: number; scale: number } {
  const dimensions = readJpegDimensions(decodeBase64(base64));
  if (!dimensions) {
    return { width: surface.width, height: surface.height, scale: 1 };
  }
  const scale = dimensions.width > 0 ? dimensions.width / surface.width : 1;
  return {
    width: dimensions.width,
    height: dimensions.height,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

function decodeBase64(value: string): Uint8Array {
  // Only the first bytes matter — the SOF marker is near the front — so decode
  // a prefix rather than the whole frame on every paint.
  const prefix = value.slice(0, 4096);
  const binary = Buffer.from(prefix, "base64");
  return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
}

/** CDP button names, and the bitmask Chromium wants alongside them. */
const BUTTON_MASK: Record<string, number> = { left: 1, middle: 4, right: 2 };

async function dispatchOne(
  cdp: CdpLike,
  event: ViewportInputEvent,
  /** Buttons held after this event — see `buttonMask` at the call site. */
  buttons: number,
): Promise<void> {
  switch (event.type) {
    case "mouse_move":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: event.x,
        y: event.y,
        // Carried on MOVES too: this is how Chromium tells a drag from a
        // hover, and a drag with no buttons held moves nothing.
        buttons,
        modifiers: event.modifiers ?? 0,
      });
      return;
    case "mouse_down":
    case "mouse_up":
      await cdp.send("Input.dispatchMouseEvent", {
        type: event.type === "mouse_down" ? "mousePressed" : "mouseReleased",
        x: event.x,
        y: event.y,
        button: event.button,
        buttons,
        clickCount: event.clickCount ?? 1,
        modifiers: event.modifiers ?? 0,
      });
      return;
    case "wheel":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        buttons,
        modifiers: event.modifiers ?? 0,
      });
      return;
    case "text":
      // Paste and IME composition have no keystrokes to replay, so text is
      // inserted rather than typed.
      await cdp.send("Input.insertText", { text: event.text });
      return;
    case "key_down":
    case "key_up": {
      const descriptor = describeKey(event.key, event.code);
      await cdp.send("Input.dispatchKeyEvent", {
        type: event.type === "key_down" ? "keyDown" : "keyUp",
        modifiers: event.modifiers ?? 0,
        key: event.key,
        ...descriptor,
      });
      return;
    }
  }
}

/**
 * What Chromium needs beyond the key NAME.
 *
 * A printable character arrives as text (`Input.insertText`), so this table
 * only has to carry the editing and navigation keys a person uses to get
 * through a login form. Anything unlisted is dispatched with its name alone,
 * which Chromium handles for most keys and ignores for the rest — a wrong
 * keycode would be worse than a missing one.
 */
const KEY_CODES: Record<
  string,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { code: "Home", windowsVirtualKeyCode: 36 },
  End: { code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
};

function describeKey(
  key: string,
  code: string | undefined,
): Record<string, unknown> {
  const known = KEY_CODES[key];
  if (known) return known;
  return code ? { code } : {};
}
