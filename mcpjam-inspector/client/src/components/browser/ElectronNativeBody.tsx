import { useCallback, useEffect, useRef, useState } from "react";
import { PaneMessage } from "@/components/computer/PaneMessage";
import {
  PaneControlBar,
  type PaneControl,
} from "@/components/browser/PaneControlBar";
import { StatsOverlay } from "@/components/browser/StatsOverlay";
import { paneFrameStats } from "@/lib/browser-pane/frame-stats";

/**
 * The agent's browser, as the browser — not a picture of it.
 *
 * On the desktop app the page is a `WebContentsView` running in this very
 * process, so the JPEG path is a round trip through encode, base64, parse,
 * decode and paint to show somebody a page their own machine already has.
 * Here the main process parents that view into the app's own window at this
 * pane's bounds, and what the person looks at IS Chromium: no encoder, no
 * socket, no decode, and input latency that is a repaint rather than a round
 * trip.
 *
 * ── What this component does NOT have ────────────────────────────────────
 * No `<img>`, no `<canvas>`, no pointer handlers and no keyboard handlers.
 * The view is a real browser; it takes its own input from the OS, which is the
 * whole reason the latency goes away. So this file renders the CONTROL BAR
 * (shared with every other engine, from `PaneControlBar`) and a measured empty
 * slot the view is placed over — the pane's job is to say where, not to draw.
 *
 * ── Why the empty slot still matters ─────────────────────────────────────
 * A `WebContentsView` is a sibling of the renderer, not a DOM node in it: it
 * paints OVER whatever the app draws in that rectangle, and it does not scroll,
 * clip or z-index with the page. So the slot has to be measured continuously
 * (a rail drag, a window resize, a sidebar toggle) and the view has to be taken
 * back out the moment this pane stops being the visible tab — otherwise a live
 * browser sits over the app's UI while somebody is reading their logs.
 *
 * ── The lease is still the daemon's ──────────────────────────────────────
 * `visible: true` is a REQUEST. The main process asks the surface, and the
 * surface answers to the daemon's lease — the same authority that refuses the
 * model's commands. A view held by somebody else is hidden rather than merely
 * deafened, because a visible native view of a page another person is typing
 * their password into is an observation.
 */
export function ElectronNativeBody({
  session,
  holder,
  control,
  holding,
  consentGranted,
  onTakeControl,
  onHandBack,
  placeholder,
  error,
  active = true,
  engine = "local",
}: {
  /** The browser this pane is looking at, or null while none is running. */
  session: { bootId: string } | null;
  /** This pane's lease identity, compared against the daemon's holder. */
  holder: string;
  control: PaneControl;
  /** Does this pane hold the browser? Only used for what the bar says. */
  holding: boolean;
  consentGranted: boolean;
  onTakeControl?: (() => void) | undefined;
  onHandBack?: (() => void) | undefined;
  /** The engine's empty and blocked states — no browser yet, no consent. */
  placeholder?: React.ReactNode;
  error?: string | null;
  /**
   * Is this pane the rail's visible tab?
   *
   * Load-bearing HERE in a way it is not for a canvas: an inactive canvas is
   * simply a hidden DOM node, but an inactive native view would keep painting
   * a browser over whatever the rail switched to.
   */
  active?: boolean;
  engine?: string;
}) {
  const [statsOpen, setStatsOpen] = useState(() => paneFrameStats.enabled());
  const slotRef = useRef<HTMLDivElement | null>(null);
  /** What the main process last said actually happened. */
  const [placed, setPlaced] = useState<{
    shown: boolean;
    reason?: "unknown" | "no_window" | "bad_bounds" | "lease";
  }>({ shown: false });

  /**
   * Does this pane want the page on screen right now?
   *
   * Consent is in here and not only in the placeholder because a native view
   * is not something a placeholder can cover: the view paints OVER the app, so
   * a revoked grant has to take it out of the window, not draw a message in
   * front of it.
   */
  const wantVisible = active && consentGranted && !!session;

  /**
   * The latest ask, coalesced into an animation frame.
   *
   * A `ResizeObserver` during a rail drag fires once per frame and each call
   * crosses a process boundary; without this a drag is hundreds of IPC round
   * trips, and the view lags the rail it is supposed to be inside.
   */
  const pendingRef = useRef<number | null>(null);
  const bootIdRef = useRef<string | null>(null);
  bootIdRef.current = session?.bootId ?? null;
  const holderRef = useRef(holder);
  holderRef.current = holder;
  const wantVisibleRef = useRef(wantVisible);
  wantVisibleRef.current = wantVisible;

  const push = useCallback(() => {
    const api = window.electronAPI?.agentBrowser;
    const bootId = bootIdRef.current;
    if (!api || !bootId) return;
    const element = slotRef.current;
    const visible = wantVisibleRef.current && !!element;
    // The ELEMENT's viewport rectangle, which is the window's content
    // coordinate space: an Electron window's content area and its renderer's
    // viewport share an origin, so no conversion belongs here. The zoom factor
    // does — and it is applied in the MAIN process, which is the side that
    // actually knows it.
    const rect = element?.getBoundingClientRect();
    void api
      .setViewport({
        bootId,
        holder: holderRef.current,
        visible,
        ...(visible && rect
          ? {
              bounds: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              },
            }
          : {}),
      })
      .then((result) => {
        setPlaced(
          result.reason
            ? { shown: result.shown, reason: result.reason }
            : { shown: result.shown },
        );
      })
      .catch(() => {
        // A channel that is not there, or a main process mid-teardown. The
        // pane says nothing rather than showing an error over a browser that
        // may be perfectly fine — `shown: false` is already the honest state.
        setPlaced({ shown: false });
      });
  }, []);

  const schedule = useCallback(() => {
    if (pendingRef.current !== null) return;
    pendingRef.current = requestAnimationFrame(() => {
      pendingRef.current = null;
      push();
    });
  }, [push]);

  // Measure, and keep measuring. A rail drag, a window resize, a sidebar
  // toggle and a scroll all move the slot without React re-rendering this.
  useEffect(() => {
    const element = slotRef.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => schedule())
        : null;
    observer?.observe(element);
    window.addEventListener("resize", schedule);
    // Capturing, because a scroll inside ANY ancestor moves this slot and only
    // the capture phase sees a scroll on a nested container.
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (pendingRef.current !== null) {
        cancelAnimationFrame(pendingRef.current);
        pendingRef.current = null;
      }
    };
  }, [schedule]);

  // Re-ask whenever the ANSWER could change: a different browser, a lease that
  // moved, a pane that stopped being the visible tab, a grant withdrawn.
  useEffect(() => {
    schedule();
  }, [schedule, session?.bootId, holder, control, wantVisible]);

  /**
   * Take the view OUT of the window on the way past.
   *
   * The one piece of teardown that cannot be skipped. A canvas that unmounts
   * takes its pixels with it; a native view that unmounts keeps painting over
   * whatever the app draws next, because it is a sibling of the renderer
   * rather than a node inside it.
   *
   * Its own effect with an empty dependency list, and it reads the boot id
   * from a ref, so a re-render never runs the hide and a bootId that changed
   * during teardown still hides the RIGHT browser.
   */
  useEffect(() => {
    const bootId = bootIdRef.current;
    return () => {
      const api = window.electronAPI?.agentBrowser;
      const last = bootIdRef.current ?? bootId;
      if (!api || !last) return;
      void api.setViewport({ bootId: last, visible: false }).catch(() => {});
    };
  }, []);

  // One sample per pane, so the session summary can say the picture never went
  // through a wire at all — which is the number this whole path exists for.
  useEffect(() => {
    if (!placed.shown) return;
    paneFrameStats.noteEngine(engine);
    paneFrameStats.noteTransport("native");
  }, [placed.shown, engine]);

  /**
   * What the pane says when the page is not on screen.
   *
   * Only ever a MESSAGE, never a picture: there is nothing to draw here, and
   * the one case with something to explain is a lease somebody else holds —
   * where the view is hidden on purpose and a person staring at an empty slot
   * deserves to be told why.
   */
  const message = (() => {
    if (placeholder) return placeholder;
    if (!session) return null;
    if (placed.shown) return null;
    if (placed.reason === "lease") {
      return (
        <PaneMessage dashed>
          <span data-testid="rail-browser-native-lease">
            Someone else has taken control of this browser. The view will come
            back when they hand it back.
          </span>
        </PaneMessage>
      );
    }
    if (placed.reason === "unknown") {
      return (
        <PaneMessage dashed>
          <span data-testid="rail-browser-native-gone">
            This browser is no longer running. Open it again to watch.
          </span>
        </PaneMessage>
      );
    }
    return null;
  })();

  return (
    <>
      <PaneControlBar
        control={control}
        onTakeControl={onTakeControl}
        onHandBack={onHandBack}
        statsOpen={statsOpen}
        onToggleStats={(next) => {
          paneFrameStats.setEnabled(next);
          setStatsOpen(next);
        }}
      />
      <div className="relative min-h-0 flex-1 px-3 pb-3">
        {statsOpen ? <StatsOverlay engine={engine} /> : null}
        <div
          ref={slotRef}
          data-testid="rail-browser-native-slot"
          data-shown={placed.shown ? "true" : "false"}
          data-holding={holding ? "true" : undefined}
          aria-label="The agent's browser"
          // Nothing is drawn in here — the view paints over it — so the slot is
          // an empty box whose only job is to have a rectangle. `h-full w-full`
          // rather than an aspect ratio: the view is a real browser and resizes
          // its own page, so there is no fixed picture to letterbox.
          className="h-full w-full"
        />
        {/*
          OVER the slot rather than beside it. The slot must keep its rectangle
          even while the view is hidden — it is what the pane will ask for the
          moment the lease frees — so a message that pushed it out of the way
          would report a shrinking box on every refusal.
        */}
        {message ? (
          <div className="absolute inset-0 px-3 pb-3">{message}</div>
        ) : null}
      </div>
      {error ? (
        <div className="shrink-0 px-3 pb-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </>
  );
}
