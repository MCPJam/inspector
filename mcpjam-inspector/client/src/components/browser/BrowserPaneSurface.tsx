import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Hand, Loader2, MousePointer2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
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

/** Who is driving, in the words the header says. */
export type PaneControl = "agent" | "you" | "script" | "other";

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
}

/** The DOM's button numbering, in the daemon's names. */
function buttonOf(event: { button?: number }): "left" | "middle" | "right" {
  if (event.button === 1) return "middle";
  if (event.button === 2) return "right";
  return "left";
}

/** The header's sentence, for each way a browser can be driven. */
function controlLabel(control: PaneControl): string {
  switch (control) {
    case "you":
      return "You have control";
    case "script":
      return "A script has control";
    case "other":
      return "Someone else has control";
    default:
      return "The agent is driving";
  }
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
}: BrowserPaneSurfaceProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  /**
   * Which button this pane is holding down, if any.
   *
   * The BUTTON, not a boolean: a drag started with the middle or right button
   * has to be released with that same one, or the page is left holding it
   * while a left-release it never saw goes somewhere else.
   */
  const draggingRef = useRef<"left" | "middle" | "right" | null>(null);

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

  const pointAt = useCallback(
    (
      event: { clientX: number; clientY: number },
      options: { clampToPage?: boolean } = {},
    ) => {
      const image = imageRef.current;
      if (!image || !frame) return null;
      return toPageCoordinates(event, image, frame, options);
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
      <img
        ref={imageRef}
        data-testid="rail-browser-frame"
        alt="The agent's browser"
        src={`data:image/jpeg;base64,${frame.data}`}
        className="h-full w-full select-none object-contain"
        draggable={false}
        onMouseMove={(event) => {
          // Mid-drag a move must still land, even over a letterbox bar: the
          // page is tracking the pointer and a gap reads as a jump.
          const point = pointAt(event, {
            clampToPage: draggingRef.current !== null,
          });
          if (point)
            send([{ type: "mouse_move", ...point, modifiers: modifiersOf(event) }]);
        }}
        onMouseDown={(event) => {
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
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {controlLabel(control)}
        </span>
        {onHandBack ? (
          <Button size="sm" variant="outline" onClick={onHandBack}>
            <Hand className="mr-1.5 h-3.5 w-3.5" />
            Hand back
          </Button>
        ) : onTakeControl ? (
          <Button size="sm" onClick={onTakeControl}>
            <MousePointer2 className="mr-1.5 h-3.5 w-3.5" />
            Take control
          </Button>
        ) : null}
      </div>
      <div
        ref={paneRef}
        className="min-h-0 flex-1 px-3 pb-3 outline-none"
        // Keys go to the page only while this pane holds the browser.
        tabIndex={holding ? 0 : -1}
        onKeyDown={(event) => {
          if (!holding) return;
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
