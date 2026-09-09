/**
 * A `DriverContext` over Electron `WebContentsView`s on a hidden holder window.
 *
 * This is the whole reason the desktop app can have an agent browser. The
 * packaged app ships no `node_modules`, so the local engine's
 * `import("playwright")` rejects there — but Electron IS a Chromium, and one
 * view per tab gives the driver everything a Playwright page did. Nothing is
 * downloaded and there is no profile lock to fight over, because the app's own
 * `requestSingleInstanceLock` already guarantees one process.
 *
 * VIEWS ON ONE HIDDEN HOLDER, NOT A WINDOW EACH. A `WebContentsView` can be
 * moved between windows, which is what makes the browser SHOWABLE: the pane
 * reparents the active view into the app's own window at the rail's bounds, and
 * the person is looking at Chromium rather than at a JPEG of it. A
 * `BrowserWindow` per tab could not do that — and it also made Electron count
 * every agent tab as a window, so `window-all-closed` never fired and the app
 * never quit.
 *
 * The holder is a `BaseWindow`, created lazily and never shown. It exists to
 * OWN the views while nobody is looking at them: a view with no parent is not
 * rendered at all, and an unrendered page starves the screencast and stops
 * running timers. `visibleWindows()` in `src/main.ts` never lists a
 * `BaseWindow`, so the app's own window accounting is unaffected.
 *
 * ONE VIEW PER TAB, AND WHY IT IS CAPPED. Each is a renderer PROCESS, so a page
 * that opens popups without limit would otherwise spawn processes without limit
 * inside the user's editor. The cap refuses instead, in prose the driver
 * reports rather than swallowing.
 *
 * BUNDLE SAFETY. `electron` is `import type` at the top level only; the runtime
 * `await import("electron")` is inside `launchElectronContext`, behind the
 * caller's `ELECTRON_APP` check. `electron` is already external in
 * `server/tsup.config.ts` and `vite.main.config.ts`, and nothing under
 * `daemon/**` reaches this file.
 */

import type { DriverContext, DriverPage } from "../daemon/browser-page";
import { BROWSERD_OBSERVATION_VIEWPORT } from "../protocol";
import {
  createElectronInputShield,
  type ShieldViewConstructor,
  type ShieldWindow,
} from "./input-shield";
import { createElectronPage, type PageWebContents } from "./electron-page";
// A separate, import-free module because `src/main.ts` reads the same registry
// and must not pull the server graph in at module-load time. See its header.
import { forgetAgentWindow, rememberAgentWindow } from "./agent-windows";
import type {
  ContextSurface,
  SurfaceView,
  SurfaceWindow,
} from "./agent-surface";

/**
 * How many hidden windows one context may hold.
 *
 * Each is a renderer process inside the user's desktop app. Eight is generous
 * for an agent driving one site — the Playwright engine rarely exceeds three —
 * and small enough that a runaway `window.open` loop cannot eat the machine.
 */
export const ELECTRON_TAB_CAP = 8;

export interface LaunchElectronContextOptions {
  /**
   * `persistent` keeps a profile across boots, which is what a playground
   * login depends on; `ephemeral` gets an in-memory partition that dies with
   * the context, which is what an unattended run must have.
   */
  contextMode?: "persistent" | "ephemeral";
  /** Names the persistent partition. Ignored when ephemeral. */
  partitionKey?: string;
  /** Test seam: the Electron surface, so the suite needs no real Electron. */
  electron?: ElectronLike;
  /**
   * Put the tabs on views the pane can show natively.
   *
   * Off restores the pre-V-3 shape exactly — one hidden `BrowserWindow` per
   * tab, frames over the socket — which is what
   * `MCPJAM_BROWSER_NATIVE_SURFACE=false` is for, and what an Electron without
   * `WebContentsView` gets regardless.
   */
  nativeSurface?: boolean;
  /**
   * The surface this context's views are registered with.
   *
   * Supplied by the session layer, which also binds it to the lease. Absent
   * means "no pane will ever show these", which is the ordinary state for an
   * unattended run.
   */
  surface?: ContextSurface;
}

/** The slice of Electron this module uses, so a fake need not be complete. */
export interface ElectronLike {
  BrowserWindow: new (options: Record<string, unknown>) => ElectronWindowLike;
  /**
   * The holder and the tabs. Optional so a fake — and an Electron too old to
   * have them — falls back to the window-per-tab shape, which is what the
   * native surface's kill switch also produces.
   */
  BaseWindow?: new (options: Record<string, unknown>) => SurfaceWindow & {
    id?: number;
  };
  WebContentsView?: new (options: Record<string, unknown>) => SurfaceView & {
    webContents: PageWebContents & {
      setWindowOpenHandler?(
        handler: (details: { url: string }) => { action: "deny" | "allow" },
      ): void;
    };
  };
  session: {
    fromPartition(partition: string): {
      setPermissionRequestHandler(
        handler: ((...args: never[]) => void) | null,
      ): void;
      setPermissionCheckHandler?(
        handler: ((...args: never[]) => void) | null,
      ): void;
    };
  };
}

export interface ElectronWindowLike {
  /** `BrowserWindow.id`, so the app can tell an agent window from a real one. */
  id?: number;
  webContents: PageWebContents & {
    setWindowOpenHandler?(
      handler: (details: { url: string }) => { action: "deny" | "allow" },
    ): void;
  };
  isDestroyed(): boolean;
  destroy(): void;
  focus?(): void;
}

/**
 * Start a context backed by hidden windows.
 *
 * Throws when this process is not Electron. That is not a defensive check for
 * its own sake: the caller decides the engine from `ELECTRON_APP`, and a
 * mismatch means the session module picked the wrong factory — which should
 * fail loudly at launch rather than at the first act.
 */
export async function launchElectronContext(
  options: LaunchElectronContextOptions = {},
): Promise<DriverContext> {
  const electron = options.electron ?? (await loadElectron());
  const contextMode = options.contextMode ?? "persistent";

  // A persistent partition is the profile: same string, same cookies, next
  // boot. An ephemeral one has no `persist:` prefix, which is what makes
  // Electron keep it in memory and drop it with the session — the isolation an
  // unattended run depends on, and the reason two runs must not share a key.
  const partition =
    contextMode === "persistent"
      ? `persist:mcpjam-browser-${options.partitionKey ?? "default"}`
      : `mcpjam-browser-ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Deny-all, matching the WebMCP surface's handler in `src/main.ts`. The agent
  // browses whatever a page links to; "the developer's own site" stops being
  // true at the first redirect, and a camera grant made on that basis would
  // follow the page wherever it went.
  const partitionSession = electron.session.fromPartition(partition);
  partitionSession.setPermissionRequestHandler(((
    _wc: unknown,
    _permission: string,
    callback: (granted: boolean) => void,
  ) => {
    callback(false);
  }) as never);
  partitionSession.setPermissionCheckHandler?.((() => false) as never);

  const windows = new Set<ElectronWindowLike>();
  let closed = false;

  /**
   * Can this Electron give the pane a real view?
   *
   * Both constructors, and the caller asking for it. Anything less falls back
   * to the window-per-tab shape, which still works — it is simply a picture of
   * the page rather than the page.
   */
  const native =
    options.nativeSurface === true &&
    !!electron.BaseWindow &&
    !!electron.WebContentsView;

  /**
   * ONE hidden holder for every view in this context, created lazily.
   *
   * Lazily because a context that never opens a tab should not create a
   * window, and never shown because its job is to OWN the views rather than to
   * display them: a `WebContentsView` with no parent is not rendered at all,
   * and an unrendered page starves the screencast and stops running timers.
   */
  let holder: (SurfaceWindow & { id?: number }) | undefined;
  function ensureHolder(): SurfaceWindow {
    if (holder && !holder.isDestroyed()) return holder;
    const BaseWindow = electron.BaseWindow!;
    holder = new BaseWindow({
      show: false,
      width: BROWSERD_OBSERVATION_VIEWPORT.width,
      height: BROWSERD_OBSERVATION_VIEWPORT.height,
      useContentSize: true,
    });
    // ONE id in the registry rather than one per tab. `visibleWindows()` never
    // lists a `BaseWindow`, so what this now feeds is the app's
    // `agentBrowserWindowCount()` and its `window-all-closed` accounting.
    rememberAgentWindow(holder.id);
    return holder;
  }

  /** The shared `webPreferences` — see `newWindow` for why each entry is here. */
  const webPreferences = {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    partition,
    // A view parented into no window, or into a hidden holder, is throttled to
    // a crawl by default — and a throttled renderer starves the screencast the
    // pane is watching when it is NOT being shown natively.
    backgroundThrottling: false,
  };

  /**
   * Teach the surface to build an input shield, now that Electron is loaded.
   *
   * HERE rather than where the surface is created, because of an ordering that
   * is not ours to choose: the surface has to exist before this context (it
   * registers each tab as the tab is made) and only this module has Electron.
   * @see ContextSurface.setShieldFactory
   */
  options.surface?.setShieldFactory(({ window, onGesture }) => {
    const View = electron.WebContentsView;
    if (typeof View !== "function") return null;
    return createElectronInputShield(
      View as unknown as ShieldViewConstructor,
      window as unknown as ShieldWindow,
      onGesture,
    );
  });

  function newView(): ElectronWindowLike {
    const WebContentsView = electron.WebContentsView!;
    const view = new WebContentsView({ webPreferences });
    const parent = ensureHolder();
    parent.contentView.addChildView(view);
    view.setBounds({
      x: 0,
      y: 0,
      width: BROWSERD_OBSERVATION_VIEWPORT.width,
      height: BROWSERD_OBSERVATION_VIEWPORT.height,
    });
    options.surface?.registerTab(view);
    // Adapted to the window-shaped seam the rest of this module already uses,
    // so `adopt`, `createElectronPage` and the CDP adapter are untouched. The
    // differences are exactly two: destroying a view means taking it out of
    // its holder, and bringing one to the front means telling the surface.
    const shim: ElectronWindowLike = {
      ...(view.webContents.id !== undefined ? { id: view.webContents.id } : {}),
      webContents: view.webContents,
      isDestroyed: () => view.webContents.isDestroyed?.() ?? false,
      destroy: () => {
        options.surface?.forget(view);
        if (holder && !holder.isDestroyed()) {
          try {
            holder.contentView.removeChildView(view);
          } catch {
            // Already taken out.
          }
        }
        // `WebContentsView` has no `destroy()`; closing its contents is what
        // releases the renderer process.
        (view.webContents as unknown as { close?: () => void }).close?.();
      },
      focus: () => options.surface?.setActive(view),
    };
    return shim;
  }

  function newWindow(): ElectronWindowLike {
    const window = new electron.BrowserWindow({
      show: false,
      width: BROWSERD_OBSERVATION_VIEWPORT.width,
      height: BROWSERD_OBSERVATION_VIEWPORT.height,
      // The CONTENT is 1024×768, not the frame around it. Without this, a
      // framed platform makes the viewport smaller than the surface the model
      // was told about (L5), so every coordinate it was handed from a
      // screenshot lands somewhere other than where it aimed.
      useContentSize: true,
      webPreferences: {
        // The agent browses the open web. Every one of these is what keeps a
        // page it lands on from reaching the user's machine through the
        // renderer: no Node, no preload, an isolated world, and its own
        // partition. This is a hostile-content surface, not an app window.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition,
        // Hidden windows are throttled to a crawl by default, and a throttled
        // renderer starves the screencast the pane is watching.
        backgroundThrottling: false,
      },
    });
    windows.add(window);
    rememberAgentWindow(window.id);
    return window;
  }

  /** Forget a window, in both the context's set and the process-wide one. */
  function forget(window: ElectronWindowLike): void {
    windows.delete(window);
    // A native context's registry entry is the HOLDER's, not the view's, and
    // it is released when the last tab goes — see `close()`. Forgetting a
    // view's `webContents` id here would remove nothing and, worse, could
    // remove a real window's id if the two ever collided.
    if (!native) forgetAgentWindow(window.id);
  }

  async function adopt(window: ElectronWindowLike): Promise<DriverPage> {
    const page = createElectronPage(window.webContents, {
      onClose() {
        forget(window);
        if (!window.isDestroyed()) window.destroy();
      },
      onBringToFront: () => window.focus?.(),
    });

    // Denied, and that is the honest v1 answer rather than a limitation being
    // hidden: `DriverContext` has no `onPageCreated` seam yet (I-2c adds it
    // alongside tab observation), so a popup adopted here would be a page the
    // driver could not address, could not show, and would never close.
    // Allowing it is worse than denying: Electron's default is a real, VISIBLE
    // window on the user's screen running a page the agent is driving. When
    // the seam lands, this becomes a sibling hidden window reported through it.
    window.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));

    return page;
  }

  return {
    async newPage() {
      if (closed) throw new Error("this browser is shutting down");
      if (windows.size >= ELECTRON_TAB_CAP) {
        // Worded for the driver's classifier, so the model is told it has too
        // many tabs open rather than being handed a daemon fault.
        throw new Error(
          `not found: this browser is at its limit of ${ELECTRON_TAB_CAP} tabs — close one first`,
        );
      }
      return adopt(native ? newView() : newWindow());
    },
    isConnected: () => !closed,
    async close() {
      closed = true;
      for (const window of [...windows]) {
        forget(window);
        try {
          if (!window.isDestroyed()) window.destroy();
        } catch {
          // A window the app already tore down (quit, or the user closed the
          // app) destroys itself; there is nothing left to release.
        }
      }
      options.surface?.dispose();
      // The HOLDER is the last thing to go, and it must go: it is a window as
      // far as Electron is concerned, so one left behind means
      // `window-all-closed` never fires and the app never quits.
      if (holder) {
        forgetAgentWindow(holder.id);
        try {
          if (!holder.isDestroyed()) holder.destroy();
        } catch {
          // Already gone.
        }
        holder = undefined;
      }
    },
  };
}

/**
 * The real Electron, or a throw that says why there isn't one.
 *
 * `await import` rather than a top-level import: the standalone Node server is
 * built from this same source and must never resolve `electron`.
 */
async function loadElectron(): Promise<ElectronLike> {
  // `process.versions.electron` FIRST, because importing the specifier is not
  // the same question. In a plain Node process the `electron` npm package
  // resolves to a STRING — the path to a binary — so the import succeeds and
  // then everything built on it fails somewhere less obvious. This is the only
  // check that actually asks "am I running inside Electron", and it costs
  // nothing.
  if (!process.versions.electron) {
    throw new Error(
      "the Electron browser engine was selected outside the desktop app; this process is not Electron",
    );
  }
  try {
    const electron = (await import("electron")) as unknown as ElectronLike;
    if (!electron?.BrowserWindow) throw new Error("no BrowserWindow");
    return electron;
  } catch {
    throw new Error(
      "the Electron browser engine was selected but this build has no Electron to drive",
    );
  }
}
