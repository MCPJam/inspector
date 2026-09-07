import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  PaneControlBar,
  type PaneControl,
} from "@/components/browser/PaneControlBar";
import { StatsOverlay } from "@/components/browser/StatsOverlay";
import { paneFrameStats } from "@/lib/browser-pane/frame-stats";
import { paintFrame } from "@/lib/browser-pane/frame-wire";
import type { QualityTier } from "@/lib/browser-pane/tier";
import {
  modifiersOf,
  toPageCoordinates,
  type BrowserInputEvent,
  type PaneFrame,
} from "@/lib/browser-pane/input";

/**
 * The picture, the pointer, the keys, and the take-control bar.
 *
 * ONE surface for every engine. What a person does to a rendered browser does
 * not depend on where that browser runs: a click on an `object-contain`
 * letterbox bar is not a click on the page whether the frame came from a local
 * Chromium, an Electron `BrowserWindow` or a Playwright in a sandbox, and a
 * release that drifted onto a bar has to land in all three or the page is left
 * holding a button down forever. Each engine's body owns what is genuinely
 * different — how it starts a browser, mints its credentials and reaches its
 * lease — and hands the result here.
 *
 * Taking over is a BUTTON, not a click into the picture. While nobody holds
 * the browser the agent may be mid-turn, and two drivers on one page is what
 * the lease exists to prevent; every server behind this refuses input that
 * arrives without one, so the button is the honest shape of the rule rather
 * than decoration over it.
 */

export type { PaneControl };

export interface BrowserPaneSurfaceProps {
  /** The latest frame, or null while none has arrived. */
  frame: PaneFrame | null;
  /**
   * Does this pane hold the browser?
   *
   * Gates every input path AND the keyboard. Not derived from `control`,
   * because an engine may know it holds the lease before it can say whose the
   * frame is.
   */
  holding: boolean;
  control: PaneControl;
  /** Offer "Take control". Omitted when there is nothing to take. */
  onTakeControl?: (() => void) | undefined;
  /** Offer "Hand back". Omitted when this pane is not the holder. */
  onHandBack?: (() => void) | undefined;
  /**
   * Forward a batch. Never called unless `holding` — but the servers behind
   * this check the lease again anyway, because a client-side gate is not one.
   */
  onInput: (events: BrowserInputEvent[]) => void;
  /**
   * Shown instead of the picture: the engine's own empty or blocked states —
   * an unauthorized machine, a missing Chromium, no browser started yet.
   * Omitted while merely waiting for the first frame, which every engine does
   * the same way.
   */
  placeholder?: ReactNode;
  /** Shown under the pane, in the destructive colour. */
  error?: string | null;
  /**
   * Is this pane the rail's visible tab?
   *
   * The pane stays MOUNTED behind the other tabs — dropping the socket would
   * stop the screencast and make the browser go dark on every glance — so
   * `document.visibilityState` cannot answer this: the document is still
   * visible, it is this pane that is not. Only the keyboard focus is decided
   * here; what a hidden pane must stop CLAIMING is each engine's own business.
   */
  active?: boolean;
  /** Which engine drew this, for the stats overlay and the session summary. */
  engine?: string;
  /**
   * Engine-specific controls for the bar — the hosted pane's tab strip.
   *
   * The pane draws one because kiosk mode takes Chromium's away, and kiosk is
   * what makes the video encoder's premise ("the display IS the page") true.
   */
  controls?: ReactNode;
  /**
   * A transient note about something that happened TO the picture.
   *
   * Kept apart from `error`, which describes the pane's own state: "the agent
   * switched tabs" is not a fault, and showing it in the destructive colour
   * would read as one.
   */
  notice?: string | null;
  /** The quality menu, when this engine has tiers to offer. */
  tier?: QualityTier;
  onTier?: (next: QualityTier) => void;
  tiers?: readonly QualityTier[];
}

/** The DOM's button numbering, in the daemon's names. */
function buttonOf(event: { button?: number }): "left" | "middle" | "right" {
  if (event.button === 1) return "middle";
  if (event.button === 2) return "right";
  return "left";
}

export function BrowserPaneSurface({
  frame,
  holding,
  control,
  onTakeControl,
  onHandBack,
  onInput,
  placeholder,
  error,
  active = true,
  engine = "unknown",
  controls,
  notice,
  tier,
  onTier,
  tiers,
}: BrowserPaneSurfaceProps) {
  /**
   * Is the overlay up?
   *
   * Seeded from the stats flag, so somebody who set `browser:frame-stats` in
   * the console gets the overlay without hunting for the menu — and the menu
   * writes the same key back, so the choice survives a reload either way.
   */
  const [statsOpen, setStatsOpen] = useState(() => paneFrameStats.enabled());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  /**
   * Which button this pane is holding down, if any.
   *
   * The BUTTON, not a boolean: a drag started with the middle or right button
   * has to be released with that same one, or the page is left holding it
   * while a left-release it never saw goes somewhere else.
   */
  const draggingRef = useRef<"left" | "middle" | "right" | null>(null);
  /**
   * Is an IME composing right now?
   *
   * Between `compositionstart` and `compositionend` the browser fires keydowns
   * for keys that are building a character rather than typing one — forwarding
   * them puts the raw Latin keystrokes of a Japanese or Chinese entry into the
   * page and then the composed text on top.
   */
  const composingRef = useRef(false);

  // Taking control moves the KEYBOARD, not just the lease: the click that
  // acquired it left focus on the button, so everything typed afterwards went
  // to the button and nothing reached the page.
  useEffect(() => {
    if (!holding || !active) return;
    paneRef.current?.focus();
  }, [holding, active]);

  // A hold that ends mid-drag must not leave the page holding a button. The
  // release cannot be sent — the lease is gone and the server would refuse it
  // — so this only forgets, which is what stops the NEXT press from being
  // treated as the continuation of a drag nobody is making.
  useEffect(() => {
    if (!holding) draggingRef.current = null;
  }, [holding]);

  const send = useCallback(
    (events: BrowserInputEvent[]) => {
      if (!holding || events.length === 0) return;
      onInput(events);
    },
    [holding, onInput],
  );

  /**
   * The frame currently on the canvas.
   *
   * Kept so a NEW frame can release the one it replaces. An `ImageBitmap`
   * holds a decoded surface — several megabytes at 1024×768 — and the garbage
   * collector has no idea how expensive it is, so a pane at 30 fps that never
   * closed them would hold a second of decoded video at all times.
   *
   * Released here rather than in an effect CLEANUP on purpose. React's
   * StrictMode runs mount effects twice with a cleanup in between; a cleanup
   * that closed the bitmap would leave the second run drawing a closed one,
   * and the pane would go blank for a frame every time it mounted in
   * development. The last frame's bitmap is closed by the body that owns the
   * socket, which is also the thing that knows when the stream is over.
   */
  const paintedRef = useRef<PaneFrame | null>(null);

  /**
   * Paint the latest frame, and record that it was painted.
   *
   * An EFFECT rather than a render, because drawing is a side effect on a
   * backing store the React tree does not own — and because the honest moment
   * to record a paint is after `drawImage` returns. `setFrame` means a frame
   * exists; it says nothing about anybody having seen it.
   *
   * Two wires meet here. On the binary wire the picture arrived decoded and
   * the draw is synchronous. On the JSON wire it is base64 that still has to
   * become an image, which the browser does asynchronously — so that path
   * checks it is still the current frame before drawing, or a slow decode from
   * two frames ago would paint over a newer picture.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const previous = paintedRef.current;
    if (previous && previous !== frame) previous.bitmap?.close();
    paintedRef.current = frame;

    const record = (decodeMs?: number) => {
      paneFrameStats.notePainted({
        ...(frame.relayTs !== undefined ? { relayTs: frame.relayTs } : {}),
        ts: frame.ts,
        seq: frame.seq,
        width: frame.deviceWidth,
        height: frame.deviceHeight,
        ...(decodeMs !== undefined ? { decodeMs } : {}),
      });
    };

    const bitmap = frame.bitmap;
    if (bitmap) {
      if (paintFrame(canvas, { ...frame, bitmap })) record();
      return;
    }
    if (!frame.data) return;
    let stale = false;
    const startedAt = performance.now();
    const image = new Image();
    image.onload = () => {
      if (stale) return;
      canvas.width = frame.deviceWidth;
      canvas.height = frame.deviceHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0);
      record(performance.now() - startedAt);
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
    return () => {
      stale = true;
    };
  }, [frame]);

  const pointAt = useCallback(
    (
      event: { clientX: number; clientY: number },
      options: { clampToPage?: boolean } = {},
    ) => {
      const canvas = canvasRef.current;
      if (!canvas || !frame) return null;
      // The ELEMENT's rectangle and the frame's own geometry, never the backing
      // store: the canvas is sized to the picture and CSS scales it to fit, so
      // the letterbox arithmetic is exactly what it was for the `<img>`.
      return toPageCoordinates(event, canvas, frame, options);
    },
    [frame],
  );

  const paneBody = () => {
    if (!frame) {
      return (
        placeholder ?? (
          <PaneMessage>
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for the first frame…
            </span>
          </PaneMessage>
        )
      );
    }
    return (
      <canvas
        ref={canvasRef}
        data-testid="rail-browser-frame"
        aria-label="The agent's browser"
        role="img"
        className="h-full w-full select-none object-contain"
        onMouseMove={(event) => {
          // Mid-drag a move must still land, even over a letterbox bar: the
          // page is tracking the pointer and a gap reads as a jump.
          const point = pointAt(event, {
            clampToPage: draggingRef.current !== null,
          });
          if (point)
            send([
              { type: "mouse_move", ...point, modifiers: modifiersOf(event) },
            ]);
        }}
        onMouseDown={(event) => {
          // BEFORE the drag state is seeded, not just before the send. A press
          // while the agent is driving sends nothing either way — `send` drops
          // it — but recording the button anyway leaves this pane believing a
          // drag is in progress. Take control afterwards and the next move or
          // release off the picture is CLAMPED onto the page as the
          // continuation of a drag whose press the page never saw.
          if (!holding) return;
          // A press that starts on a bar is still dropped: the page has
          // nothing there, and inventing a target clicks where nobody aimed.
          const point = pointAt(event);
          if (!point) return;
          draggingRef.current = buttonOf(event);
          send([
            {
              type: "mouse_down",
              ...point,
              button: buttonOf(event),
              clickCount: event.detail || 1,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onMouseUp={(event) => {
          // The release always lands. Dropping it because the pointer drifted
          // onto a bar leaves the page holding the button down forever, stuck
          // mid-selection with no way for the person to let go.
          const point = pointAt(event, {
            clampToPage: draggingRef.current !== null,
          });
          draggingRef.current = null;
          if (!point) return;
          send([
            {
              type: "mouse_up",
              ...point,
              button: buttonOf(event),
              clickCount: event.detail || 1,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onMouseLeave={(event) => {
          // Leaving the element mid-drag ends it, for the same reason — with
          // the button that was actually pressed, not always the left one.
          const held = draggingRef.current;
          if (!held) return;
          const point = pointAt(event, { clampToPage: true });
          draggingRef.current = null;
          if (point) {
            send([
              {
                type: "mouse_up",
                ...point,
                button: held,
                modifiers: modifiersOf(event),
              },
            ]);
          }
        }}
        onContextMenu={(event) => {
          // The page gets the right-click; the host's own menu would cover it.
          if (holding) event.preventDefault();
        }}
        onWheel={(event) => {
          const point = pointAt(event);
          if (!point) return;
          send([
            {
              type: "wheel",
              ...point,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
      />
    );
  };

  return (
    <>
      <PaneControlBar
        control={control}
        onTakeControl={onTakeControl}
        onHandBack={onHandBack}
        {...(controls ? { extra: controls } : {})}
        {...(tier ? { tier } : {})}
        {...(onTier ? { onTier } : {})}
        {...(tiers ? { tiers } : {})}
        statsOpen={statsOpen}
        onToggleStats={(next) => {
          // The menu is the flag: turning the overlay on from here is what a
          // person who has never heard of `localStorage` can do, and turning it
          // on has to START the recording, not merely reveal a set of zeros.
          paneFrameStats.setEnabled(next);
          setStatsOpen(next);
        }}
      />
      <div
        ref={paneRef}
        className="relative min-h-0 flex-1 px-3 pb-3 outline-none"
        // Keys go to the page only while this pane holds the browser.
        tabIndex={holding ? 0 : -1}
        onPaste={(event) => {
          // Paste has no keystrokes to replay. `Ctrl+V` forwarded as a key
          // pair asks the PAGE to paste from a clipboard the sandbox does not
          // share, so nothing arrived at all; the text has to travel itself.
          if (!holding) return;
          event.preventDefault();
          const text = event.clipboardData?.getData("text");
          if (text) send([{ type: "text", text }]);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          // The composed text, once — not the Latin keystrokes that built it.
          composingRef.current = false;
          if (!holding) return;
          if (event.data) send([{ type: "text", text: event.data }]);
        }}
        onKeyDown={(event) => {
          if (!holding) return;
          // ESCAPE HATCH, and it has to be a key: taking control moves focus
          // into this pane and every other key goes to the page, so a person
          // navigating by keyboard had no way back to "Hand back" — including
          // Tab, which the page legitimately wants. Shift+Escape leaves; a
          // bare Escape still belongs to the page, which uses it for dialogs.
          if (event.key === "Escape" && event.shiftKey) {
            event.preventDefault();
            paneRef.current?.blur();
            return;
          }
          // While an IME is composing, the keydowns are building a character
          // rather than typing one. `compositionend` delivers the result.
          if (composingRef.current || event.key === "Process") return;
          event.preventDefault();
          // A printable character is inserted as TEXT: paste and IME
          // composition have no keystrokes to replay, and a key table that
          // tried would be wrong for every non-US layout.
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
            send([{ type: "text", text: event.key }]);
            return;
          }
          send([
            {
              type: "key_down",
              key: event.key,
              code: event.code,
              modifiers: modifiersOf(event),
            },
            {
              type: "key_up",
              key: event.key,
              code: event.code,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
      >
        {statsOpen ? <StatsOverlay engine={engine} /> : null}
        {notice ? (
          <div
            data-testid="pane-notice"
            className="pointer-events-none absolute inset-x-0 top-2 z-10 mx-auto w-fit rounded-md bg-foreground/85 px-2 py-1 text-[11px] text-background"
          >
            {notice}
          </div>
        ) : null}
        {paneBody()}
      </div>
      {error ? (
        <div className="shrink-0 px-3 pb-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </>
  );
}
