/**
 * A `DriverContext` over hidden Electron `BrowserWindow`s.
 *
 * This is the whole reason the desktop app can have an agent browser. The
 * packaged app ships no `node_modules`, so the local engine's
 * `import("playwright")` rejects there — but Electron IS a Chromium, and one
 * hidden window per tab gives the driver everything a Playwright page did.
 * Nothing is downloaded and there is no profile lock to fight over, because the
 * app's own `requestSingleInstanceLock` already guarantees one process.
 *
 * ONE WINDOW PER TAB, AND WHY IT IS CAPPED. Electron has no first-class "tab":
 * a `BrowserWindow` is the unit that owns a `webContents`. Each one is a
 * renderer PROCESS, so a page that opens popups without limit would otherwise
 * spawn processes without limit inside the user's editor. The cap refuses
 * instead, in prose the driver reports rather than swallowing.
 *
 * HIDDEN, following `src/main.ts`'s OAuth popup: `show: false` is an existing,
 * shipped pattern in this app, not a new trick. The user sees the page in the
 * rail's viewport — driven by the screencast over CDP — not as a window that
 * steals their focus mid-sentence.
 *
 * BUNDLE SAFETY. `electron` is `import type` at the top level only; the runtime
 * `await import("electron")` is inside `launchElectronContext`, behind the
 * caller's `ELECTRON_APP` check. `electron` is already external in
 * `server/tsup.config.ts` and `vite.main.config.ts`, and nothing under
 * `daemon/**` reaches this file.
 */

import type { DriverContext, DriverPage } from "../daemon/browser-page";
import { BROWSERD_OBSERVATION_VIEWPORT } from "../protocol";
import { createElectronPage, type PageWebContents } from "./electron-page";
// A separate, import-free module because `src/main.ts` reads the same registry
// and must not pull the server graph in at module-load time. See its header.
import { forgetAgentWindow, rememberAgentWindow } from "./agent-windows";

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
}

/** The slice of Electron this module uses, so a fake need not be complete. */
export interface ElectronLike {
  BrowserWindow: new (options: Record<string, unknown>) => ElectronWindowLike;
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
    forgetAgentWindow(window.id);
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
      return adopt(newWindow());
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
