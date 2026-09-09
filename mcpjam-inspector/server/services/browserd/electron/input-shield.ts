/**
 * The native input shield.
 *
 * A `WebContentsView` is a sibling of the renderer, not a node in it: it
 * paints over whatever the app draws in that rectangle, it does not
 * participate in z-index, and it takes its input straight from the OS. So the
 * obvious way to say "clicking here takes the browser" — a React overlay with
 * a pointer handler — is drawn UNDERNEATH the thing it is meant to cover, and
 * the click it was supposed to intercept lands in the page instead. Every
 * other engine shows a canvas and can simply not forward what it receives;
 * here there is nothing to not forward.
 *
 * So the shield is a second native view, empty and transparent, parented above
 * the browser at the same rectangle. It is invisible and it is not a picture
 * of anything: its whole job is to be what the OS delivers the click to.
 *
 * ── Why no preload, and no page script ──────────────────────────────────
 * `webContents.on("input-event")` fires in the MAIN process for every input
 * event routed to a `webContents` — mouse, wheel and keyboard alike. That is
 * the trusted observation this needs, and it needs no script in the page, no
 * preload, no IPC channel and no bridge. A shield that ran a script would be a
 * renderer this app has to reason about; this one loads `about:blank` and
 * never executes anything.
 *
 * ── What it deliberately does not do ────────────────────────────────────
 * It does not synthesize the intercepted event into the page afterwards. On
 * every other engine the pane holds the initiating interaction and delivers it
 * once the lease lands, because it knows exactly where the click was in the
 * page's own coordinates. Here it does not: the shield sees the event in ITS
 * view's space, the acquire is a round trip, and a page that scrolled or
 * navigated during it would receive a click aimed at what used to be there —
 * precisely the failure `stale_observation` exists to catch. So the shield
 * takes the browser and gets out of the way, and the person's next click, a
 * fraction of a second later into a page they can see, is the one that lands.
 * One extra click in exchange for never clicking the wrong thing.
 *
 * ── No Electron import ──────────────────────────────────────────────────
 * The constructor arrives as an argument, like every other Electron
 * constructor in this directory: `electron-context.ts` is the one module that
 * loads Electron, and it does so behind a dynamic import so the server graph
 * can be required on a machine that has none.
 */

import type { SurfaceBounds, SurfaceShield } from "./agent-surface";

/**
 * The events that mean somebody is USING the page.
 *
 * `mouseMove` is deliberately absent: a pointer crossing the window on the way
 * to the chat box is not an intervention, and taking the agent's browser for
 * one would be the native version of taking it on a hover. `mouseEnter` and
 * `mouseLeave` likewise.
 *
 * `keyUp` is absent too, for a different reason: the key that went down
 * already took the browser, and counting its release would be a second gesture
 * for one keystroke.
 */
const ACQUIRING_EVENTS: ReadonlySet<string> = new Set([
  "mouseDown",
  "mouseWheel",
  "keyDown",
]);

/**
 * Keys that are never somebody typing.
 *
 * The same set the web pane uses, and for the same reason: a resting hand or a
 * host shortcut beginning must not take the browser.
 */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
]);

/** The `WebContentsView` surface this module touches. */
export interface ShieldView {
  setBounds(bounds: SurfaceBounds): void;
  setBackgroundColor?(color: string): void;
  webContents: {
    loadURL(url: string): Promise<unknown> | unknown;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
    close?(): void;
    isDestroyed?(): boolean;
  };
}

/** The window a shield is parented into. */
export interface ShieldWindow {
  contentView: {
    addChildView(view: ShieldView): void;
    removeChildView(view: ShieldView): void;
  };
  isDestroyed(): boolean;
}

export type ShieldViewConstructor = new (options: {
  webPreferences: Record<string, unknown>;
}) => ShieldView;

/**
 * Build a shield over `window`, or null when it cannot be built.
 *
 * Null rather than a throw: a platform without the constructor falls back to
 * the frame stream, and the surface already treats an absent shield as "a
 * click reaches the page directly and does not take the browser" — the
 * behaviour that existed before the shield did.
 */
export function createElectronInputShield(
  View: ShieldViewConstructor,
  window: ShieldWindow,
  onGesture: () => void,
): SurfaceShield | null {
  if (typeof View !== "function") return null;
  let view: ShieldView | null = null;
  let attached = false;
  let disposed = false;

  const ensure = (): ShieldView | null => {
    if (disposed) return null;
    if (view && !view.webContents.isDestroyed?.()) return view;
    try {
      view = new View({
        webPreferences: {
          // Nothing runs in here. No preload, no Node, its own partition, and
          // a page that is literally blank — the shield observes through the
          // main process and never needs a script.
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: "mcpjam-agent-browser-shield",
          // A shielded browser is one nobody is driving, so there is nothing
          // to keep painting; but a throttled renderer also stops delivering
          // `input-event`, which is the one thing this view exists for.
          backgroundThrottling: false,
        },
      });
      // TRANSPARENT, so the page underneath is fully visible. The shield is
      // not a scrim and must not look like one: a person watching the agent
      // work should see the page exactly as it is, and discover the shield
      // only by clicking through it.
      view.setBackgroundColor?.("#00000000");
      void view.webContents.loadURL("about:blank");
      view.webContents.on("input-event", (...args: unknown[]) => {
        // Electron passes `(event, input)`; a fake may pass the input alone.
        const input = (args.length > 1 ? args[1] : args[0]) as
          | { type?: string; key?: string }
          | undefined;
        if (!input?.type || !ACQUIRING_EVENTS.has(input.type)) return;
        if (input.type === "keyDown" && MODIFIER_KEYS.has(input.key ?? "")) {
          return;
        }
        try {
          onGesture();
        } catch {
          // A listener that throws must not break the shield, which is the
          // only thing between a stray click and the agent's page.
        }
      });
    } catch {
      view = null;
    }
    return view;
  };

  const shield: SurfaceShield = {
    cover(bounds: SurfaceBounds) {
      const shieldView = ensure();
      if (!shieldView || window.isDestroyed()) return;
      if (!attached) {
        try {
          window.contentView.addChildView(shieldView);
          attached = true;
        } catch {
          return;
        }
      }
      // ADDED LAST, which is what puts it on top: `addChildView` appends, and
      // the browser view was parented before this. A shield underneath the
      // page intercepts nothing — and looks identical from the outside, which
      // is why the ordering is stated here rather than left to be inferred.
      shieldView.setBounds(bounds);
    },
    remove() {
      if (!attached || !view) return;
      attached = false;
      if (window.isDestroyed()) return;
      try {
        window.contentView.removeChildView(view);
      } catch {
        // Already out, or a window mid-teardown.
      }
    },
    dispose() {
      disposed = true;
      shield.remove();
      const contents = view?.webContents;
      // `WebContentsView` has no `destroy()`; closing its contents releases
      // the renderer process. Left open, an invisible view outlives the
      // browser it was covering and goes on eating clicks in that rectangle.
      if (contents && !contents.isDestroyed?.()) contents.close?.();
      view = null;
    },
  };
  return shield;
}
