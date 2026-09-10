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

/**
 * A transparent view that sits OVER the browser and eats input.
 *
 * Electron's problem, and it has no DOM solution. A `WebContentsView` is a
 * sibling of the renderer rather than a node in it: it paints over whatever
 * the app draws in that rectangle, it does not participate in z-index, and it
 * takes its input straight from the OS. So a React overlay — the obvious way
 * to say "clicking here takes the browser" — is drawn UNDERNEATH the thing it
 * is meant to cover, and the click it was supposed to intercept lands in the
 * page instead. On every other engine the picture is a canvas and the pane can
 * simply not forward what it receives; here there is nothing to not forward.
 *
 * The shield is therefore a second native view, owned by the main process,
 * parented above the browser and covering exactly the same rectangle. It is
 * empty and transparent, so it is invisible; what it does is receive the
 * pointer and key events that would otherwise reach the page, and report the
 * first of them as a request to take the browser.
 *
 * WHILE THE AGENT DRIVES, NOT ONLY DURING THE TRANSITION. A shield that
 * appeared only after somebody clicked would be a shield that never
 * intercepted the click it exists for.
 */
/**
 * Builds a shield over one window.
 *
 * Takes the window because a shield belongs to the window it covers, and the
 * surface only learns which window that is when the pane calls `show`. Returns
 * null when this platform cannot build one, which the surface treats as "a
 * click reaches the page directly" — the behaviour it had before shields
 * existed.
 */
export type ShieldFactory = (deps: {
  window: SurfaceWindow;
  /** Somebody used the page. Take the browser. */
  onGesture: () => void;
}) => SurfaceShield | null;

export interface SurfaceShield {
  /** Cover this rectangle, in the holder window's coordinates. */
  cover(bounds: SurfaceBounds): void;
  /** Take it back out. */
  remove(): void;
  /** Destroy it for good. */
  dispose(): void;
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
  /** Is the input shield covering the page right now? For diagnostics. */
  isShielded(): boolean;
  /**
   * Teach this surface to build an input shield.
   *
   * LATE, because the ordering is not ours to choose: the surface has to exist
   * before the Electron context (the context registers each tab with it as the
   * tab is made) and only the context has Electron loaded. Calling this a
   * second time replaces the factory and destroys whatever the old one built.
   */
  setShieldFactory(factory: ShieldFactory | null): void;
  /** Which holder this pane is, so the lease can be compared against it. */
  setPaneHolder(holder: string | undefined, takeoverEnabled?: boolean): void;
  /**
   * The holder this pane last identified itself as.
   *
   * Read by the shield's gesture path, which knows somebody clicked and
   * deliberately does not know who: a shield that carried an identity would be
   * a renderer-supplied one reaching the lease through the path that exists to
   * be trusted. This is the id the IPC channel already checked the sender of.
   */
  paneHolder(): string | undefined;
  /** Is the active view currently parented into a visible window? */
  isShown(): boolean;
  /** Does the lease permit this pane to see the page, even before a tab exists? */
  visibilityAllowed(): boolean;
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
   * Build the input shield, when this platform can.
   *
   * Injected rather than constructed here for the same reason the window
   * constructors are: this module is import-free at module scope, and reaching
   * for `WebContentsView` would drag Electron into every unit test of it.
   *
   * Absent means NO SHIELD, and the consequence is stated plainly rather than
   * hidden: a click into the native view reaches the page directly and does
   * not take the browser. That is the behaviour this surface had before the
   * shield existed, and it is what a platform without a second view can offer.
   */
  createShield?: ShieldFactory;
  /**
   * Somebody interacted with a shielded page.
   *
   * The surface does not acquire the lease itself — it has no client, and the
   * lease belongs to the daemon. It reports, and whoever wired it decides.
   */
  onShieldGesture?: () => void;
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
  /**
   * The shield, built lazily on the first time it is actually needed.
   *
   * Lazy because building it creates a real view and a real renderer process,
   * and a surface whose lease is never free — an eval, an unattended run —
   * never needs one.
   */
  let shield: SurfaceShield | null | undefined;
  let shielded = false;
  let shieldFactory: ShieldFactory | undefined = options.createShield;
  /** Which window the current shield was built for. */
  let shieldWindow: SurfaceWindow | undefined;
  let viewport: SurfaceViewport = options.viewport ?? {
    width: DEFAULT_SESSION_VIEWPORT.width,
    height: DEFAULT_SESSION_VIEWPORT.height,
  };
  /** The view currently parented into `holderWindow`. */
  let parented: SurfaceView | undefined;
  let paneHolder: string | undefined;
  let takeoverEnabled = true;
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

  /**
   * Take the shield down, wherever we are coming from.
   *
   * One definition because there are three ways out — the pane hides, the
   * surface stops being visible, the lease comes back — and a copy that one of
   * them forgot is an invisible rectangle left over an app that has moved on.
   */
  /**
   * The rectangle the native view actually occupies.
   *
   * THE SHIELD MUST COVER THIS, not the pane's `bounds`. The two are not the
   * same rectangle: position comes from the pane and size from the session, so
   * a session viewport larger than the pane — a `fixed` session beside a
   * narrow panel, or a pane the layout has clipped — leaves the view sticking
   * out beyond `bounds`. A shield cut to `bounds` covers the middle and leaves
   * that overhang live, so a click there reaches the agent's page while the
   * lease says nobody may drive it. That is the shield failing at the one job
   * it has, in the case that looks like it is working.
   */
  const viewRect = (): SurfaceBounds | null =>
    bounds
      ? {
          x: bounds.x,
          y: bounds.y,
          width: viewport.width,
          height: viewport.height,
        }
      : null;

  const uncover = (): void => {
    if (!shielded) return;
    shield?.remove();
    shielded = false;
  };

  const apply = (): void => {
    if (disposed) return;
    const view = active();
    if (!holderWindow || !bounds || !view || !visible()) {
      detach();
      // THE SHIELD FOLLOWS THE VIEW OUT. `applyShield()` at the end of this
      // function is the only other place it comes down, and this path never
      // reaches it — so a pane that was showing the page when somebody else
      // took the lease left an invisible rectangle parented over the app, with
      // the browser view removed from under it. It goes on eating clicks meant
      // for whatever is behind it, exactly as `hide()` guards against, and
      // nothing clears it until the pane hides or the lease comes back.
      uncover();
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
    view.setBounds(viewRect()!);
    // Deafened as well as shown: the view is on screen while the agent drives,
    // because watching is the safe common case — but a click into it while
    // somebody else holds the browser must not reach the page.
    if (!allowed()) options.onVisibilityRefused?.(view);
    applyShield();
  };

  /**
   * Cover the page while this pane may not drive it, and uncover it when it may.
   *
   * The predicate is `allowed()`, exactly the one the input gate uses, so the
   * shield and the refusal can never disagree — which is the failure that
   * would matter: a shield up while input is allowed makes the browser
   * unusable, and one down while it is not makes the lease decorative.
   */
  const applyShield = (): void => {
    const wanted = !!holderWindow && !!bounds && !!parented && !allowed();
    if (!wanted) {
      uncover();
      return;
    }
    // Rebuilt when the WINDOW changes, not only when there is none: a shield
    // is a child of one window, and one left pointing at a window that has
    // gone covers nothing while the new window's page is wide open.
    if (shield === undefined || shieldWindow !== holderWindow) {
      shield?.dispose();
      shieldWindow = holderWindow;
      shield =
        shieldFactory?.({
          window: holderWindow!,
          onGesture: () => {
            if (takeoverEnabled) options.onShieldGesture?.();
          },
        }) ?? null;
    }
    const rect = viewRect();
    if (!shield || !rect) return;
    // `cover` on every apply, not only on the transition: the pane moves, the
    // window resizes, and a shield left at the old rectangle is a hole over
    // the page and a dead patch over the app beside it.
    shield.cover(rect);
    shielded = true;
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
      // The shield comes out with the view. A shield over a page nobody is
      // showing is an invisible rectangle that eats the clicks meant for
      // whatever the pane switched to.
      uncover();
      holderWindow = undefined;
      bounds = undefined;
    },
    setLease(state) {
      lease = state;
      apply();
    },
    setPaneHolder(holder, allowTakeover = true) {
      paneHolder = holder;
      takeoverEnabled = allowTakeover;
      apply();
    },
    isShown: () => !!parented,
    visibilityAllowed: visible,
    paneHolder: () => paneHolder,
    isShielded: () => shielded,
    setShieldFactory(factory) {
      shieldFactory = factory ?? undefined;
      shield?.dispose();
      shield = undefined;
      shieldWindow = undefined;
      shielded = false;
      apply();
    },
    inputAllowed: allowed,
    dispose() {
      disposed = true;
      detach();
      // BEFORE the refs are dropped, and unconditionally: the shield owns a
      // real view and a real renderer process, and one left behind outlives
      // the browser it was covering — an invisible rectangle over the app that
      // swallows every click in it.
      shield?.dispose();
      shield = null;
      shielded = false;
      order = [];
      holderWindow = undefined;
      bounds = undefined;
    },
  };
}
