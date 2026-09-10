import { createImagePresenter } from "@/lib/browser-pane/image-presenter";
import {
  useCallback,
  useEffect,
  useMemo,
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
 * Authority is explicit: shared inspection permits human input alongside tool
 * invocation; leased sessions delegate acquisition and enforcement to adapters.
 */

export type { PaneControl };

export interface BrowserPaneSurfaceProps {
  /** The latest frame, or null while none has arrived. */
  frame: PaneFrame | null;
  /** Local inspection shares input; leased engines require an actual hold. */
  authority: { kind: "lease"; holding: boolean } | { kind: "shared" };
  label?: string;
  interactionLabel?: string;
  onViewportSize?: (size: { width: number; height: number }) => void;
  onPainted?: (frame: PaneFrame, decodeMs?: number) => void;
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
  /**
   * Draw the take-control bar above the picture, or not.
   *
   * `"none"` is for a pane wrapped in `BrowserShell`, whose two rows already
   * carry the ownership status and the resume control — a bar above them would
   * be a third row repeating both. Everything else this component does is
   * unchanged: it is still the picture, the pointer, the keys and the
   * letterbox arithmetic, and those are what make it worth sharing.
   */
  chrome?: "bar" | "none";
  /**
   * Whether the stats overlay is up, when somebody else owns that decision.
   *
   * A pane wrapped in `BrowserShell` moves the toggle into the shell's menu,
   * and the menu writing only its own state left this component drawing the
   * value it happened to mount with: the item showed a tick and the overlay
   * never moved. Omitted, the surface keeps its own state, which is what the
   * standalone pane still wants.
   */
  statsOpen?: boolean;
  /**
   * Handle a pointer or key event as a TAKEOVER when this pane does not hold
   * the browser.
   *
   * Without it, `holding: false` simply drops input, which is what the surface
   * did when taking control was a button. With it, the first click into the
   * picture acquires the lease and is then delivered — or dropped with a
   * notice, if the page moved while acquiring. The surface does not decide
   * any of that; it reports the interaction and the body's coordinator does.
   */
  onTakeoverInput?: ((events: BrowserInputEvent[]) => void) | undefined;
}

/**
 * Keys that are never somebody typing.
 *
 * A lone modifier is a hand resting or a host shortcut beginning, and taking
 * the browser from the agent for one would be the keyboard's version of taking
 * it on a hover.
 */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
]);

/**
 * Is this keystroke a character being typed, rather than a shortcut?
 *
 * A single-character `key` is not enough on its own. `Alt+F` reports `key: "f"`
 * on Linux and Windows and `key: "ƒ"` on macOS — both length 1 — so a test that
 * only excluded Ctrl and Meta sent an Alt shortcut down the text path, which
 * drops the modifier entirely: the page never sees `Alt+F` and gets a stray "f"
 * or "ƒ" typed into it instead.
 *
 * Shift is deliberately NOT here. `Shift+a` is how you type "A", and the `key`
 * already carries the capital.
 */
function isTypedCharacter(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

/** The DOM's button numbering, in the daemon's names. */
function buttonOf(event: { button?: number }): "left" | "middle" | "right" {
  if (event.button === 1) return "middle";
  if (event.button === 2) return "right";
  return "left";
}

export function BrowserPaneSurface({
  frame,
  authority,
  label = "The agent's browser",
  onPainted,
  onViewportSize,
  interactionLabel,
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
  chrome = "bar",
  statsOpen: statsOpenProp,
  onTakeoverInput,
}: BrowserPaneSurfaceProps) {
  /**
   * Is the overlay up?
   *
   * Seeded from the stats flag, so somebody who set `browser:frame-stats` in
   * the console gets the overlay without hunting for the menu — and the menu
   * writes the same key back, so the choice survives a reload either way.
   */
  const holding =
    authority.kind === "shared" ||
    (authority.kind === "lease" && authority.holding);
  const [ownStatsOpen, setStatsOpen] = useState(() => paneFrameStats.enabled());
  // The prop WINS when it is given, and there is no syncing between the two:
  // one owner per value, chosen by whether a caller supplied one.
  const statsOpen = statsOpenProp ?? ownStatsOpen;
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
  const heldKeys = useRef(new Map<string, { key: string; code: string }>());
  const withheldKeys = useRef(new Set<string>());
  const lastPoint = useRef({ x: 0, y: 0 });

  // Taking control moves the KEYBOARD, not just the lease: the click that
  // acquired it left focus on the button, so everything typed afterwards went
  // to the button and nothing reached the page.
  useEffect(() => {
    if (!holding || !active || authority.kind === "shared") return;
    paneRef.current?.focus();
  }, [holding, active, authority.kind]);

  // A hold that ends mid-drag must not leave the page holding a button. The
  // release cannot be sent — the lease is gone and the server would refuse it
  // — so this only forgets, which is what stops the NEXT press from being
  // treated as the continuation of a drag nobody is making.
  useEffect(() => {
    if (!holding) {
      draggingRef.current = null;
      heldKeys.current.clear();
      withheldKeys.current.clear();
    }
  }, [holding]);

  const send = useCallback(
    (events: BrowserInputEvent[]) => {
      if (!holding || events.length === 0) return;
      onInput(events);
    },
    [holding, onInput],
  );

  /**
   * The interaction that TAKES the browser.
   *
   * Deliberately not routed through `send`. Taking is a round trip, and the
   * events that would be forwarded on the way — a bare `mouse_down` whose
   * `mouse_up` arrives while the acquire is still in flight — would leave the
   * page holding a button nobody is pressing. So a takeover carries a COMPLETE
   * interaction: a whole click, a whole wheel tick, a whole keystroke.
   */
  const takeover = useCallback(
    (events: BrowserInputEvent[]) => {
      if (holding || events.length === 0) return;
      onTakeoverInput?.(events);
    },
    [holding, onTakeoverInput],
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
  const displayedFrame = useRef<PaneFrame | null>(null);
  const images = useMemo(
    () =>
      createImagePresenter<{
        src: string;
        frame: PaneFrame;
        record(decodeMs?: number): void;
      }>((image, packet, decodeMs) => {
        const canvas = canvasRef.current;
        if (!canvas?.isConnected) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        if (canvas.width !== packet.frame.deviceWidth)
          canvas.width = packet.frame.deviceWidth;
        if (canvas.height !== packet.frame.deviceHeight)
          canvas.height = packet.frame.deviceHeight;
        context.drawImage(image, 0, 0);
        displayedFrame.current = packet.frame;
        packet.record(decodeMs);
      }),
    [],
  );
  useEffect(() => () => images.clear(), [images]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) {
      images.clear();
      displayedFrame.current = null;
      return;
    }

    const record = (decodeMs?: number) => {
      paneFrameStats.noteDisplayed?.(canvas.getBoundingClientRect());
      if (onPainted) {
        onPainted(frame, decodeMs);
        return;
      }
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
      images.clear();
      // The producer's own measurement: the decode happened off the main
      // thread before this frame existed, so there is nothing to time here.
      if (paintFrame(canvas, { ...frame, bitmap })) {
        displayedFrame.current = frame;
        record(frame.decodeMs);
      }
      return;
    }
    if (!frame.data && !frame.src) return;
    images.push({
      src: frame.src ?? `data:image/jpeg;base64,${frame.data}`,
      frame,
      record,
    });
  }, [frame, onPainted, images]);

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
      const point = toPageCoordinates(
        event,
        canvas,
        displayedFrame.current ?? frame,
        options,
      );
      if (point) lastPoint.current = point;
      return point;
    },
    [frame],
  );

  const releaseHeld = useCallback(() => {
    const button = draggingRef.current;
    draggingRef.current = null;
    composingRef.current = false;
    if (button)
      send([{ type: "mouse_up", ...lastPoint.current, button, modifiers: 0 }]);
    for (const key of heldKeys.current.values())
      send([{ type: "key_up", ...key, modifiers: 0 }]);
    heldKeys.current.clear();
    withheldKeys.current.clear();
  }, [send]);

  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});
  wheelRef.current = (event) => {
    const point = pointAt(event);
    if (!point || (!holding && !onTakeoverInput)) return;
    event.preventDefault();
    const input: BrowserInputEvent[] = [
      {
        type: "wheel",
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifiersOf(event),
      },
    ];
    if (holding) send(input);
    else takeover(input);
  };
  useEffect(() => {
    const pane = paneRef.current;
    const wheel = (event: WheelEvent) => wheelRef.current(event);
    pane?.addEventListener("wheel", wheel, { passive: false });
    return () => pane?.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    const element = paneRef.current;
    if (!element || !onViewportSize || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const width =
        rect.width -
        parseFloat(style.paddingLeft || "0") -
        parseFloat(style.paddingRight || "0");
      const height =
        rect.height -
        parseFloat(style.paddingTop || "0") -
        parseFloat(style.paddingBottom || "0");
      if (width > 0 && height > 0)
        onViewportSize({
          width: Math.round(width),
          height: Math.round(height),
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onViewportSize]);

  const releaseRef = useRef(releaseHeld);
  releaseRef.current = releaseHeld;
  useEffect(() => () => releaseRef.current(), []);

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
        aria-label={label}
        role="img"
        className="max-h-full max-w-full select-none object-contain"
        onPointerMove={(event) => {
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
        onPointerDown={(event) => {
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
          event.currentTarget.setPointerCapture?.(event.pointerId);
          paneRef.current?.focus();
        }}
        // Pointer events own capture; compatibility mouse events carry the
        // browser's click count (PointerEvent.detail is always zero).
        onMouseDown={(event) => {
          if (!holding) return;
          const point = pointAt(event);
          if (!point) return;
          draggingRef.current = buttonOf(event);
          send([
            {
              type: "mouse_down",
              ...point,
              button: buttonOf(event),
              clickCount: Math.min(3, event.detail || 1),
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
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
              clickCount: Math.min(3, event.detail || 1),
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onPointerCancel={() => releaseHeld()}
        onContextMenu={(event) => {
          // The page gets the right-click; the host's own menu would cover it.
          if (holding) event.preventDefault();
        }}
        onClick={(event) => {
          // THE CLICK, not the mousedown, is what takes the browser. A
          // takeover is a round trip; forwarding a lone `mouse_down` into it
          // would leave the page holding a button whose release arrived while
          // the acquire was still running. A click is complete by definition.
          if (holding) return;
          const point = pointAt(event);
          if (!point) return;
          takeover([
            { type: "mouse_move", ...point, modifiers: modifiersOf(event) },
            {
              type: "mouse_down",
              ...point,
              button: buttonOf(event),
              clickCount: Math.min(3, event.detail || 1),
              modifiers: modifiersOf(event),
            },
            {
              type: "mouse_up",
              ...point,
              button: buttonOf(event),
              clickCount: Math.min(3, event.detail || 1),
              modifiers: modifiersOf(event),
            },
          ]);
        }}
      />
    );
  };

  return (
    <>
      {chrome === "none" || authority.kind === "shared" ? null : (
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
      )}
      <div
        ref={paneRef}
        aria-label={interactionLabel}
        className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        // FOCUSABLE EVEN WHEN THE AGENT IS DRIVING, because typing is now one
        // of the things that takes the browser. It used to be `-1` while not
        // holding, which was right when taking control was a button: there was
        // nothing a keystroke here could do. Now there is.
        tabIndex={0}
        onPaste={(event) => {
          // Paste has no keystrokes to replay. `Ctrl+V` forwarded as a key
          // pair asks the PAGE to paste from a clipboard the sandbox does not
          // share, so nothing arrived at all; the text has to travel itself.
          event.preventDefault();
          const text = event.clipboardData?.getData("text");
          if (!text) return;
          // TAKEOVER TOO, exactly as a keystroke does. Pasting into the page
          // is somebody using the browser, and returning early here dropped
          // the paste silently while the agent held the lease — no text, no
          // takeover, and nothing on screen to say why.
          if (holding) send([{ type: "text", text }]);
          else takeover([{ type: "text", text }]);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          // The composed text, once — not the Latin keystrokes that built it.
          composingRef.current = false;
          if (!event.data) return;
          // TAKEOVER TOO, not only `send`. Composing is typing, and typing is
          // how a person takes the browser; dropping it while the agent held
          // the lease meant an IME user's first sentence went nowhere and took
          // nothing.
          if (holding) send([{ type: "text", text: event.data }]);
          else takeover([{ type: "text", text: event.data }]);
        }}
        onBlur={() => releaseHeld()}
        onKeyUp={(event) => {
          const identity = event.code || event.key.toLowerCase();
          if (withheldKeys.current.delete(identity)) return;
          const pressed = heldKeys.current.get(identity);
          if (!pressed) return;
          heldKeys.current.delete(identity);
          event.preventDefault();
          send([
            {
              type: "key_up",
              ...pressed,
              modifiers: modifiersOf(event),
            },
          ]);
        }}
        onKeyDown={(event) => {
          if (
            event.key.toLowerCase() === "v" &&
            (event.ctrlKey || event.metaKey) &&
            !event.altKey
          ) {
            withheldKeys.current.add(event.code || event.key.toLowerCase());
            return;
          }
          if (!holding) {
            // MID-COMPOSITION KEYSTROKES ARE NOT TEXT. They are the Latin keys
            // building a character that has not been chosen yet, and sending
            // them as well as the committed `event.data` types the scaffolding
            // and the result. Ignored here rather than in `takeover`, because
            // the browser is taken by the composition ending — which is the
            // moment the person actually meant something.
            if (composingRef.current || event.key === "Process") return;
            // A modifier on its own is not somebody typing — it is somebody
            // about to use a host shortcut, or resting a hand. Taking the
            // browser away from the agent for a lone Shift would be the
            // keyboard version of taking it on a hover.
            if (MODIFIER_KEYS.has(event.key)) return;
            if (event.key === "Tab") return; // Leaving the pane, not typing.
            event.preventDefault();
            takeover(
              isTypedCharacter(event)
                ? [{ type: "text", text: event.key }]
                : [
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
                  ],
            );
            return;
          }
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
          if (isTypedCharacter(event)) {
            send([{ type: "text", text: event.key }]);
            return;
          }
          heldKeys.current.set(event.code || event.key.toLowerCase(), {
            key: event.key,
            code: event.code,
          });
          send([
            {
              type: "key_down",
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
            // ANNOUNCED. The agent switching tabs changes everything on
            // screen, and a person using a screen reader has no picture to
            // notice it in.
            role="status"
            aria-live="polite"
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
