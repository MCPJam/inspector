/**
 * The agent's browser as a REAL window, not a picture of one.
 *
 * On Electron the browser is already local: a `WebContentsView` is Chromium,
 * running in this process, a few hundred microseconds from the pixels. Sending
 * it to the pane as JPEGs over a socket — encode, base64, parse, decode, paint —
 * is a round trip through three format changes to show somebody a page their own
 * machine already has. Parenting the view into the window instead is the whole
 * point of this file: no frames, no socket, no input latency.
 *
 * IMPORT-FREE AT MODULE SCOPE, exactly like `agent-windows.ts` and for the same
 * reason: `src/main.ts`'s IPC layer reads this registry, and its own header
 * forbids reaching into the server graph at load time — importing the context
 * would drag in the page, the CDP adapter and `utils/logger.ts`, which
 * initialises Sentry and Axiom as a side effect of being loaded. Constructors
 * arrive through `install()`.
 *
 * THE INPUT GATE IS SERVER-AUTHORITATIVE. A picture cannot be clicked into; a
 * real view can. So the view's visibility and its acceptance of input are
 * driven by the DAEMON's lease (`daemon/lease.ts`'s `onChange`), never by the
 * renderer — a client-side gate is not a gate. And a view held by somebody
 * ELSE is hidden rather than merely deafened: a visible native view showing a
 * page while another person types their password into it is an observation,
 * which is the one thing the lease exists to prevent.
 */

import { DEFAULT_SESSION_VIEWPORT } from "../../../../shared/browser-viewport";

/** A `WebContentsView`, narrowed to what this module touches. */
export interface SurfaceView {
  setBounds(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): void;
  setVisible?(visible: boolean): void;
  webContents: {
    id?: number;
    setIgnoreMenuShortcuts?(ignore: boolean): void;
    isDestroyed?(): boolean;
  };
}

/** A `BaseWindow`'s child-view container. */
export interface SurfaceContainer {
  addChildView(view: SurfaceView): void;
  removeChildView(view: SurfaceView): void;
}

export interface SurfaceWindow {
  id?: number;
  contentView: SurfaceContainer;
  getContentSize?(): [number, number];
  isDestroyed(): boolean;
  destroy(): void;
}

/** Where the pane wants the view, in the main window's content coordinates. */
export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The size the views are actually rendering at.
 *
 * SEPARATE from `SurfaceBounds`, and the separation is the whole point of this
 * type existing. On Electron a `WebContentsView`'s bounds ARE its CSS
 * viewport, so the old code — which set bounds straight from whatever the pane
 * measured — meant that dragging the app window, scrolling the rail, or a
 * layout reflow anywhere else in the app silently changed the coordinate space
 * the agent was reasoning in. A model that had just read a screenshot at
 * 1024x768 would aim at a page that was now 998 wide, and nothing anywhere
 * said so: no revision bump, no stale-observation refusal, just a click a few
 * pixels off.
 *
 * So position and size are now different operations. `show` moves the view and
 * never resizes it. Size changes go through the session barrier — coalesced,
 * ordered against in-flight work, and carrying a revision — and arrive back
 * here as `setViewport` once they have actually been applied.
 */
export interface SurfaceViewport {
  width: number;
  height: number;
}

export interface ContextSurface {
  /** A new tab's view, which becomes the active one. */
  registerTab(view: SurfaceView): void;
  /** The model activated a tab; show that one instead. */
  setActive(view: SurfaceView): void;
  /** A tab closed. Falls back to the most recently active remaining one. */
  forget(view: SurfaceView): void;
  /**
   * Put the active view into a window at these bounds.
   *
   * Idempotent, and re-callable on every resize: the pane sends geometry
   * whenever its rail moves, and a surface that reparented on each of those
   * would tear the page down and rebuild it several times a drag.
   */
  show(target: { holder: SurfaceWindow; bounds: SurfaceBounds }): void;
  /** Take the view back out of the window. */
  hide(): void;
  /**
   * The session viewport moved, and the views must now render at this size.
   *
   * Called by the driver AFTER the barrier has applied the change, never by
   * the pane: the pane asks (through the measurement it sends with `show`),
   * the session decides, and only a decided size reaches the views. That
   * ordering is what makes the revision honest — the number the model is told
   * and the size the page is rendering at change in the same step.
   */
  setViewport(size: SurfaceViewport): void;
  /** The daemon's lease moved. See the module docstring. */
  setLease(state: { state: "free" | "held" | "parked"; holder?: string }): void;
  /** Which holder this pane is, so the lease can be compared against it. */
  setPaneHolder(holder: string | undefined): void;
  /** Is the active view currently parented into a visible window? */
  isShown(): boolean;
  /** May the person's clicks reach the page right now? */
  inputAllowed(): boolean;
  dispose(): void;
}

/** One surface per browser boot. */
const surfaces = new Map<string, ContextSurface>();

export function registerContextSurface(
  bootId: string,
  surface: ContextSurface,
): void {
  surfaces.set(bootId, surface);
}

export function forgetContextSurface(bootId: string): void {
  surfaces.delete(bootId);
}

/**
 * The surface for a boot, or undefined.
 *
 * BY BOOT ID, because that is what the renderer knows and the only thing it
 * may name: a renderer that could address a surface by index could address
 * somebody else's browser by guessing.
 */
export function contextSurfaceFor(bootId: string): ContextSurface | undefined {
  return surfaces.get(bootId);
}

/** How many surfaces exist. For teardown assertions and diagnostics. */
export function contextSurfaceCount(): number {
  return surfaces.size;
}

export function resetContextSurfacesForTests(): void {
  surfaces.clear();
}

export interface CreateContextSurfaceOptions {
  /**
   * Hide a view rather than only refusing its input.
   *
   * Present so a platform where `setVisible` does not exist can fall back to
   * moving the view off-screen; absent, the surface reparents it out entirely,
   * which every platform supports.
   */
  onVisibilityRefused?: (view: SurfaceView) => void;
  /**
   * The pane measured a size the views are not rendering at.
   *
   * A REQUEST, not an instruction: the surface reports it and changes nothing.
   * What happens next is the session's business — a `fixed` session ignores it
   * outright, and a `followPane` session routes it through the barrier, which
   * coalesces the sixty measurements a drag produces into one transition and
   * refuses to run it mid-action.
   */
  onViewportRequest?: (size: SurfaceViewport) => void;
  /**
   * The size the views start at, before anything has resized them.
   *
   * Defaults to the session viewport every browser on every engine has always
   * launched at. Not a fudge: a surface created without one is a surface whose
   * views are rendering at exactly that size, because nothing has told them
   * otherwise.
   */
  viewport?: SurfaceViewport;
}

export function createContextSurface(
  options: CreateContextSurfaceOptions = {},
): ContextSurface {
  /** Most recently active LAST, so a close can fall back by popping. */
  let order: SurfaceView[] = [];
  let holderWindow: SurfaceWindow | undefined;
  let bounds: SurfaceBounds | undefined;
  /**
   * The size the views are rendering at, which is NOT `bounds`'s size.
   *
   * Moved only by `setViewport`, i.e. only by a resize the session actually
   * decided. @see SurfaceViewport
   */
  let viewport: SurfaceViewport = options.viewport ?? {
    width: DEFAULT_SESSION_VIEWPORT.width,
    height: DEFAULT_SESSION_VIEWPORT.height,
  };
  /** The view currently parented into `holderWindow`. */
  let parented: SurfaceView | undefined;
  let paneHolder: string | undefined;
  let lease: { state: "free" | "held" | "parked"; holder?: string } = {
    state: "free",
  };
  let disposed = false;

  const active = (): SurfaceView | undefined => order[order.length - 1];

  /**
   * May this pane's person click into the page?
   *
   * `free` means nobody has taken the browser, and the AGENT may be mid-turn —
   * two drivers on one page is what the lease exists to prevent, so the view is
   * shown and its input refused. Only a hold that is THIS pane's admits input.
   */
  const allowed = (): boolean =>
    lease.state !== "free" && !!paneHolder && lease.holder === paneHolder;

  /**
   * May the view be on screen at all?
   *
   * Everything except a hold belonging to somebody else — including a
   * `script` holder, and including `parked`, which still belongs to whoever
   * took it. A visible native view of a page somebody else is typing into is
   * an observation.
   */
  const visible = (): boolean =>
    lease.state === "free" || (!!paneHolder && lease.holder === paneHolder);

  const detach = (): void => {
    if (!parented || !holderWindow) {
      parented = undefined;
      return;
    }
    if (!holderWindow.isDestroyed()) {
      try {
        holderWindow.contentView.removeChildView(parented);
      } catch {
        // A view already taken out, or a window mid-teardown.
      }
    }
    parented = undefined;
  };

  const apply = (): void => {
    if (disposed) return;
    const view = active();
    if (!holderWindow || !bounds || !view || !visible()) {
      detach();
      return;
    }
    if (parented && parented !== view) detach();
    if (parented !== view) {
      try {
        holderWindow.contentView.addChildView(view);
      } catch {
        // A destroyed window: the pane will send bounds again on its next
        // measure, and nothing here should throw into the lease's listener.
        return;
      }
      parented = view;
    }
    // POSITION from the pane, SIZE from the session. A pane that has moved or
    // been clipped changes x and y here and nothing else; the page keeps the
    // coordinate space the model was told about until a resize the session
    // agreed to says otherwise.
    view.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: viewport.width,
      height: viewport.height,
    });
    // Deafened as well as shown: the view is on screen while the agent drives,
    // because watching is the safe common case — but a click into it while
    // somebody else holds the browser must not reach the page.
    if (!allowed()) options.onVisibilityRefused?.(view);
  };

  return {
    registerTab(view) {
      order = [...order.filter((entry) => entry !== view), view];
      apply();
    },
    setActive(view) {
      if (!order.includes(view)) return;
      order = [...order.filter((entry) => entry !== view), view];
      apply();
    },
    forget(view) {
      if (parented === view) detach();
      order = order.filter((entry) => entry !== view);
      // Falls back to the most recently active REMAINING view, which is what
      // Chromium itself shows after a tab closes.
      apply();
    },
    show(target) {
      holderWindow = target.holder;
      bounds = target.bounds;
      apply();
      // Reported after the placement, so a surface that is about to be resized
      // is at least correctly positioned in the meantime.
      if (
        target.bounds.width !== viewport.width ||
        target.bounds.height !== viewport.height
      ) {
        options.onViewportRequest?.({
          width: target.bounds.width,
          height: target.bounds.height,
        });
      }
    },
    setViewport(size) {
      if (size.width === viewport.width && size.height === viewport.height) {
        return;
      }
      viewport = size;
      apply();
    },
    hide() {
      detach();
      holderWindow = undefined;
      bounds = undefined;
    },
    setLease(state) {
      lease = state;
      apply();
    },
    setPaneHolder(holder) {
      paneHolder = holder;
      apply();
    },
    isShown: () => !!parented,
    inputAllowed: allowed,
    dispose() {
      disposed = true;
      detach();
      order = [];
      holderWindow = undefined;
      bounds = undefined;
    },
  };
}
