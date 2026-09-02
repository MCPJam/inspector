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
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: "key_down" | "key_up"; key: string; code?: string; modifiers?: number }
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
  /** Forward a person's input. Refused by the caller unless they hold the lease. */
  dispatchInput(events: readonly ViewportInputEvent[]): Promise<void>;
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
  let disposed = false;
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
        // not fail the session that asked to watch it.
        streaming = false;
      });
  };

  const stop = async () => {
    if (!streaming) return;
    streaming = false;
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
    async dispatchInput(events) {
      for (const event of events) {
        // Each event under its own catch: one exotic key must not swallow the
        // click behind it.
        await dispatchOne(cdp, event).catch(() => {});
      }
    },
    async dispose() {
      disposed = true;
      listeners.clear();
      await stop();
    },
  };
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
): Promise<void> {
  switch (event.type) {
    case "mouse_move":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: event.x,
        y: event.y,
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
        buttons: BUTTON_MASK[event.button] ?? 1,
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
const KEY_CODES: Record<string, { code: string; windowsVirtualKeyCode: number }> =
  {
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
