/**
 * The WebMCP provider for a Chromium surface the CLIENT already mounted.
 *
 * OWNERSHIP IS INVERTED HERE, and nearly every difference from
 * `playwright-provider.ts` follows from that one fact. Every other provider
 * STARTS a browser, drives it, and kills it. This one ATTACHES to a `<webview>`
 * the renderer put on screen: it never launches anything, never destroys
 * anything, and `dispose()` detaches a debugger from a surface that goes on
 * living until the client unmounts it.
 *
 * That inversion is what deletes the machinery: there is no screencast (the
 * pixels are already on the viewer's screen), no frame throttle, and no input
 * forwarder (the surface receives real mouse and keyboard from the OS). What is
 * left is the WebMCP domain itself, and it reaches the guest the same way it
 * reaches a Playwright page — `webContents.debugger` exposes `sendCommand` and
 * `on("message")`, which the adapter below turns into the `CdpLike` the shared
 * `WebMcpBridge` speaks, so the state machine is the same single copy.
 *
 * WHY THIS CAN WORK AT ALL: the Hono server runs INSIDE the Electron main
 * process (`src/main.ts` imports and serves it there), so this module is a
 * `webContents.fromId` away from the surface. No IPC bridge, no remote
 * debugging port.
 *
 * BUNDLE SAFETY. The standalone Node server is built from the same source and
 * must never resolve `electron`. So the only top-level mention of it is an
 * `import type`, which erases; the runtime `await import("electron")` lives
 * inside `createSession` behind an `ELECTRON_APP` check, and `electron` is in
 * `server/tsup.config.ts`'s externals so the bundler leaves the specifier
 * alone rather than trying to follow it.
 *
 * GOTCHA WORTH KEEPING: `Schema.getDomains` does NOT list the WebMCP domain
 * even where the domain works. Support is feature-detected by enabling the
 * domain and evaluating `PAGE_API_PROBE` in the page — never by enumerating
 * domains.
 */
import type { Debugger, Session, WebContents } from "electron";
import {
  WEBMCP_WEBVIEW_PARTITION,
  type WebMcpInputEvent,
  type WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import { logger } from "../../utils/logger.js";
import { PAGE_API_PROBE } from "./launch-args";
import { WebMcpBridge, type CdpLike } from "../browserd/daemon/webmcp-bridge";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_WIDTH,
  translateBridgeError,
} from "./provider-shared";
import {
  WebMcpUnsupportedError,
  type CreateWebMcpSessionOptions,
  type WebMcpBrowserProvider,
  type WebMcpBrowserSession,
  type WebMcpInvokeRequest,
  type WebMcpSessionCallbacks,
} from "./provider";

/** Longest a `capturePage` may block a screenshot command. */
const CAPTURE_TIMEOUT_MS = 5_000;
/** Navigation timeout, matching the Playwright provider's. */
const NAVIGATE_TIMEOUT_MS = 30_000;
/**
 * Floor on the gap between activity reports.
 *
 * `before-input-event` fires per keystroke and per mouse button, so an
 * unthrottled report would tick the idle clock thousands of times during a
 * paragraph of typing. Ten a second is far more than the idle sweep needs and
 * costs nothing.
 */
const ACTIVITY_MIN_INTERVAL_MS = 100;

/**
 * The `webContents` handed to us is not one of ours.
 *
 * Its own class because the fixes are specific and completely different from
 * each other — a stale id after the pane unmounted, devtools holding the
 * debugger slot, or a caller trying to point the inspector's CDP attach at the
 * app's own UI. The route maps it to a 400 with a code the client can explain.
 */
export class WebMcpWebviewAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpWebviewAttachError";
  }
}

/** The slice of `electron` this provider uses, so tests can inject a fake. */
export interface ElectronModuleLike {
  webContents: {
    fromId(id: number): WebContents | undefined;
  };
  session: {
    fromPartition(partition: string): Session;
  };
  BrowserWindow: {
    getAllWindows(): Array<{ webContents: WebContents }>;
  };
}

export interface ElectronWebviewProviderOptions {
  /** The guest surface to attach to, as the renderer reported it. */
  webContentsId: number;
  /** Injected in tests; production loads the real `electron` at session start. */
  electronModule?: ElectronModuleLike;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "about:blank";
  }
}

/**
 * `webContents.debugger` as the bridge's `CdpLike`.
 *
 * Two shapes to reconcile. The debugger delivers EVERY protocol event through
 * one `"message"` listener carrying `(event, method, params)`; `CdpLike` wants
 * per-method subscription. So one listener fans out to a handler map.
 *
 * `CdpLike` has no `off`, which decides how teardown works: a bridge listener
 * cannot be individually removed, so `dispose()` flips `alive` and every one of
 * them becomes a no-op. Underneath, only the single `"message"` listener this
 * adapter installed is removed — by identity, not `removeAllListeners`, which
 * would be wrong on an emitter we do not exclusively own.
 */
class DebuggerCdpAdapter implements CdpLike {
  private readonly handlers = new Map<
    string,
    Array<(payload: unknown) => void>
  >();
  private alive = true;
  private readonly onMessage: (
    event: unknown,
    method: string,
    params: unknown,
  ) => void;

  constructor(private readonly dbg: Debugger) {
    this.onMessage = (_event, method, params) => {
      if (!this.alive) return;
      for (const handler of this.handlers.get(method) ?? []) {
        try {
          handler(params);
        } catch (error) {
          // A throwing subscriber is the consumer's own reaction to a browser
          // event; letting it escape would take down the listener that is also
          // responsible for the bridge's bookkeeping.
          logger.debug("[webmcp] a CDP event handler threw", {
            method,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    this.dbg.on("message", this.onMessage);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.alive) {
      return Promise.reject(new Error("The debugger has been detached."));
    }
    return this.dbg.sendCommand(method, params ?? {});
  }

  on(event: string, handler: (payload: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.handlers.clear();
    // By identity: `removeAllListeners("message")` would also take out anything
    // else that ever subscribed to this debugger, which is not ours to decide.
    this.dbg.removeListener("message", this.onMessage);
  }
}

export class ElectronWebviewWebMcpSession implements WebMcpBrowserSession {
  private readonly bridge: WebMcpBridge;
  private readonly cdp: DebuggerCdpAdapter;
  private url: string;
  private disposed = false;
  private lastActivityReport = 0;
  /** Listeners we bound on the guest, so dispose removes exactly those. */
  private readonly bound: Array<{
    event: string;
    handler: (...args: never[]) => void;
  }> = [];

  constructor(
    private readonly wc: WebContents,
    private readonly callbacks: WebMcpSessionCallbacks,
    startUrl: string,
    /** Hardened `webPreferences` for any popup the page opens. */
    private readonly popupWebPreferences: Record<string, unknown>,
  ) {
    this.url = startUrl;
    this.cdp = new DebuggerCdpAdapter(this.wc.debugger);
    this.bridge = new WebMcpBridge(this.cdp, {
      onChange: (tools) => this.callbacks.onToolsChanged(tools),
      onExternalInvocation: (toolName) =>
        this.callbacks.onExternalInvocation(
          "A tool was invoked from outside this inspector.",
          toolName || undefined,
        ),
    });
  }

  /**
   * Wire the surface, enable the domains, and load the first page.
   *
   * Mirrors `PlaywrightWebMcpSession.start` step for step, and the ordering is
   * the contract rather than a style choice:
   *
   *   - navigation is wired BEFORE the bridge, so its handler runs first and
   *     the runtime sees `navigated` ahead of the tool snapshot the bridge
   *     publishes from the same event (CDP dispatches in registration order,
   *     and the timeline reads badly the other way round);
   *   - the first `loadURL` happens INSIDE the probe callback, because both of
   *     its neighbours pin it there: the domains must be enabled first or tools
   *     registered during page load are never reported, and the page must be
   *     loaded before `document.modelContext` can be asked about.
   */
  async start(url: string): Promise<void> {
    this.wireNavigation();
    this.wirePage();

    // The bridge treats a throwing probe as "unsupported", which is right for a
    // probe and wrong for a navigation: a DNS failure or a refused connection
    // would be reported as "this browser cannot do WebMCP" and send someone
    // chasing a browser problem they do not have.
    let navigationFailure: unknown;
    await this.bridge.start(async () => {
      try {
        await this.navigate(url);
      } catch (error) {
        navigationFailure = error;
        return false;
      }
      // THE PAGE, not the domain list. `Schema.getDomains` omits the WebMCP
      // domain even where it works, and `WebMCP.enable` resolves even where the
      // feature is switched off.
      return (
        (await this.wc
          .executeJavaScript(PAGE_API_PROBE)
          .catch(() => false)) === true
      );
    });
    if (navigationFailure) throw navigationFailure;
    if (!this.bridge.isSupported()) {
      throw new WebMcpUnsupportedError(
        "This app's embedded browser did not expose the WebMCP page API " +
          "(document.modelContext), so no tools can be discovered. The page " +
          "itself loaded normally; check that the page is origin-isolated and " +
          "that the WebMCP tools Permissions Policy is allowed for it.",
      );
    }
  }

  /**
   * The one Page-domain fact this class needs for itself: where we are.
   *
   * Read from CDP rather than from the `did-navigate` event so it lands in the
   * same ordering as the bridge's own `Page.frameNavigated` bookkeeping. The
   * Electron events feed `onActivityObserved` and the client's URL bar; this
   * feeds the session's reported URL.
   */
  private wireNavigation(): void {
    this.cdp.on("Page.frameNavigated", (event) => {
      const { frame } = (event ?? {}) as {
        frame?: { id: string; url: string; parentId?: string };
      };
      if (!frame || frame.parentId) return;
      this.url = frame.url;
      this.callbacks.onNavigated(frame.url, originOf(frame.url));
    });
  }

  /** Bind a guest listener and remember it, so dispose removes exactly ours. */
  private bind<Args extends unknown[]>(
    event: string,
    handler: (...args: Args) => void,
  ): void {
    this.wc.on(event as never, handler as never);
    this.bound.push({ event, handler: handler as (...args: never[]) => void });
  }

  private wirePage(): void {
    // A crash and a destroy are the same thing to the layer above: the surface
    // is gone and the session cannot continue. Guarded on `disposed` so an
    // ORDERLY teardown — where we destroy nothing, but the client may unmount
    // the element a moment later — does not report a crash on the way out.
    this.bind("render-process-gone", () => {
      if (this.disposed) return;
      this.callbacks.onCrashed("The embedded page's renderer stopped.");
    });
    this.bind("destroyed", () => {
      if (this.disposed) return;
      this.callbacks.onCrashed("The embedded page was closed.");
    });

    // The idle-sweep gap the hosted provider documents (browserd-provider.ts:27)
    // is closed here: a person reading and typing in the surface keeps the
    // session alive even though no command reaches the server.
    this.bind("before-input-event", () => this.reportActivity());
    this.bind("did-navigate", (_event: unknown, navigationUrl: string) => {
      this.reportActivity();
      this.noteUrl(navigationUrl);
    });
    this.bind(
      "did-navigate-in-page",
      (_event: unknown, navigationUrl: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        this.reportActivity();
        this.noteUrl(navigationUrl);
      },
    );
    this.bind("console-message", () => this.reportActivity());

    // REPLACES the app-wide handler `src/main.ts` installs on every created
    // webContents (OAuth frames → managed popup, other safe http(s) →
    // `shell.openExternal`). That is a deliberate behaviour change for the
    // duration of a session: an inspected page's `window.open` should open a
    // real, hardened browser window the person can complete a sign-in in —
    // "left open and un-driven", which is the provider contract — rather than
    // being handed to their default browser where the session's cookies are
    // not.
    this.wc.setWindowOpenHandler(({ url }) => {
      this.callbacks.onPopupOpened(url);
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: this.popupWebPreferences,
        },
      };
    });
  }

  /**
   * Keep the reported URL current between `Page.frameNavigated` events.
   *
   * Belt and braces: the CDP handler is the authority and fires for every
   * main-frame navigation, but an in-page (History API) navigation is not one,
   * and the client's URL bar should follow those too.
   */
  private noteUrl(navigationUrl: string): void {
    if (!navigationUrl) return;
    if (navigationUrl === this.url) return;
    this.url = navigationUrl;
    this.callbacks.onNavigated(navigationUrl, originOf(navigationUrl));
  }

  private reportActivity(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (now - this.lastActivityReport < ACTIVITY_MIN_INTERVAL_MS) return;
    this.lastActivityReport = now;
    this.callbacks.onActivityObserved();
  }

  async navigate(url: string): Promise<void> {
    await withTimeout(
      this.wc.loadURL(url),
      NAVIGATE_TIMEOUT_MS,
      "The page took too long to load.",
    );
    this.url = this.wc.getURL();
    this.callbacks.onActivityObserved();
  }

  async reload(): Promise<void> {
    this.wc.reload();
    await this.waitForNavigation();
    this.url = this.wc.getURL();
  }

  async goBack(): Promise<void> {
    this.wc.navigationHistory.goBack();
    await this.waitForNavigation();
    this.url = this.wc.getURL();
  }

  /**
   * Wait for a reload or a history move to settle.
   *
   * `reload()` and `goBack()` return void — unlike `loadURL`, there is no
   * promise to await — so the session's URL would be read before the navigation
   * started and the command would answer with the OLD page. Resolving on
   * `did-stop-loading` (or the timeout) makes these behave like `navigate`.
   */
  private waitForNavigation(): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.wc.removeListener("did-stop-loading", finish);
        resolve();
      };
      const timer = setTimeout(finish, NAVIGATE_TIMEOUT_MS);
      this.wc.on("did-stop-loading", finish);
    });
  }

  /**
   * Run a page tool. Byte-for-byte the Playwright provider's shape, on purpose:
   * the envelope, the frame pin, the signal hand-over and the error mapping are
   * all contracts with the runtime above, and a second interpretation of any of
   * them would show up as a differently-worded timeline entry for the same
   * event.
   */
  async invokeTool(request: WebMcpInvokeRequest): Promise<{ output: unknown }> {
    try {
      const { output } = await this.bridge.invoke({
        toolName: request.toolName,
        ...(request.frameId ? { frameId: request.frameId } : {}),
        input: request.input,
        // Handing the signal over also hands the DEADLINE over: the bridge
        // stops arming its own, so the runtime stays the single owner of what
        // "too long" means and a timeout is not reported as a user cancel.
        signal: request.signal,
      });
      return { output };
    } catch (error) {
      throw translateBridgeError(error, request.toolName);
    }
  }

  /**
   * A thumbnail for the timeline, under the same 64 KiB budget as every other
   * provider's.
   *
   * The retry RESCALES rather than clipping — `NativeImage.resize` gives us
   * what Playwright's `clip` could not, so an oversized capture degrades to a
   * smaller picture of the WHOLE page instead of a sharp crop of its top-left
   * corner. Better evidence for the same bytes.
   *
   * Undefined rather than throwing on every failure, per the interface: a
   * capture of an occluded or minimized window is platform-dependent (an empty
   * or stale bitmap is possible), and "no screenshot" is a fine timeline entry
   * where a thrown error would fail the whole command.
   */
  async captureScreenshot(): Promise<string | undefined> {
    if (this.disposed) return undefined;
    try {
      const image = await withTimeout(
        this.wc.capturePage(),
        CAPTURE_TIMEOUT_MS,
        "The screenshot timed out.",
      );
      if (image.isEmpty()) return undefined;
      const full = image.toJPEG(50);
      if (full.byteLength <= SCREENSHOT_MAX_BYTES) {
        return full.toString("base64");
      }
      const smaller = image.resize({ width: SCREENSHOT_WIDTH }).toJPEG(30);
      return smaller.byteLength > SCREENSHOT_MAX_BYTES
        ? undefined
        : smaller.toString("base64");
    } catch {
      return undefined;
    }
  }

  currentUrl(): string {
    return this.url;
  }

  viewportTransport(): WebMcpViewportTransport {
    return { kind: "electron-webview" };
  }

  /**
   * Always `false`, and never throws.
   *
   * There is nothing to stream: the surface's pixels are already on the
   * viewer's screen. The client knows this from the transport kind and stops
   * asking after it sees one — but the contract says this must answer rather
   * than throw, because an older client asks unconditionally on every pane
   * mount and a throw would surface as a failed command on a session whose
   * viewport is working perfectly.
   */
  async setScreencast(enabled: boolean): Promise<boolean> {
    logger.debug("[webmcp] the embedded surface paints itself; no screencast", {
      enabled,
    });
    return false;
  }

  /**
   * No-op: the surface receives the viewer's real mouse and keyboard from the
   * OS. Replaying forwarded input here would deliver every gesture twice.
   */
  async dispatchInput(events: WebMcpInputEvent[]): Promise<void> {
    logger.debug("[webmcp] the embedded surface takes native input", {
      events: events.length,
    });
  }

  /**
   * Detach, and leave the surface alive.
   *
   * The inversion's sharpest edge: every other provider's `dispose` closes a
   * browser. Destroying this `webContents` would tear a live DOM node out from
   * under React, which owns it — so this removes exactly the listeners we bound,
   * detaches the debugger, and stops.
   *
   * The deny window-open handler we leave behind is a deliberate CHANGE from
   * what the guest was born with (the app-wide handler from `src/main.ts`, which
   * would `shell.openExternal` a safe http(s) URL). It is the right end state:
   * a surface whose session has ended must not be able to launch the viewer's
   * browser. The client unmounts the element immediately after, so the window
   * in which it matters is short — but during it, deny is the safe answer.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Rejects every in-flight invocation and clears their timers.
    this.bridge.dispose();
    this.cdp.dispose();

    if (this.wc.isDestroyed()) return;
    for (const { event, handler } of this.bound) {
      this.wc.removeListener(event as never, handler as never);
    }
    this.bound.length = 0;
    try {
      this.wc.setWindowOpenHandler(() => ({ action: "deny" }));
    } catch {
      /* the surface went away mid-teardown */
    }
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch {
      /* already detached, or the surface went away */
    }
  }
}

/**
 * Race a promise against a deadline.
 *
 * Electron's `loadURL` and `capturePage` take no timeout of their own, and both
 * can hang on a page that never settles — which would hold a session command
 * open indefinitely.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Attach to one embedded surface, per request.
 *
 * A FACTORY rather than a singleton, because the `webContentsId` is a fact
 * about one client's pane and arrives with the start request.
 */
export function createElectronWebviewProvider(
  options: ElectronWebviewProviderOptions,
): WebMcpBrowserProvider {
  return {
    async createSession(
      sessionOptions: CreateWebMcpSessionOptions,
    ): Promise<WebMcpBrowserSession> {
      const electron = options.electronModule ?? (await loadElectron());
      const wc = resolveGuest(electron, options.webContentsId);

      // A guest with devtools open already holds the debugger slot, and the
      // attach throws with a message nobody can act on. Say what to do.
      try {
        wc.debugger.attach("1.3");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new WebMcpWebviewAttachError(
          "Could not attach to the embedded page. Close DevTools on the " +
            `embedded page and try again. (${detail})`,
        );
      }

      const session = new ElectronWebviewWebMcpSession(
        wc,
        sessionOptions.callbacks,
        sessionOptions.url,
        hardenedPopupPreferences(),
      );
      try {
        await session.start(sessionOptions.url);
      } catch (error) {
        // Detach on every failure path. An unsupported page still leaves a
        // debugger attached to a live surface the client is about to reuse.
        await session.dispose().catch(() => {});
        throw error;
      }
      return session;
    },
  };
}

/**
 * `webPreferences` for a popup the inspected page opens.
 *
 * Same partition, so a sign-in that completes in the popup is a sign-in the
 * main surface sees; nothing else granted.
 */
function hardenedPopupPreferences(): Record<string, unknown> {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    partition: WEBMCP_WEBVIEW_PARTITION,
  };
}

/**
 * Load `electron` at runtime, or refuse.
 *
 * Both halves of the guard matter. `ELECTRON_APP` is what `src/main.ts` sets
 * before it starts this server, and `process.versions.electron` is the fact
 * itself — an env var is a claim anyone can make, and a standalone Node server
 * that somehow reached this line must fail with an explanation rather than an
 * unresolved-module stack.
 */
async function loadElectron(): Promise<ElectronModuleLike> {
  if (process.env.ELECTRON_APP !== "true" || !process.versions.electron) {
    throw new WebMcpWebviewAttachError(
      "The embedded browser surface only exists inside the MCPJam desktop app.",
    );
  }
  return (await import("electron")) as unknown as ElectronModuleLike;
}

/**
 * Prove the id names a surface WE own before pointing a CDP debugger at it.
 *
 * This is the security boundary of the whole feature. `webContents.fromId` will
 * happily hand back the app's OWN UI renderer — where the user's servers,
 * tokens and chat history live — and a local caller who can reach this route
 * could otherwise attach a debugger to it and read or drive anything. So an id
 * is accepted only when every one of these holds:
 *
 *   1. it resolves, and the surface is not already destroyed;
 *   2. it is a `webview` guest, not a window or a normal renderer;
 *   3. it runs on the WebMCP partition (the same string
 *      `will-attach-webview` enforces at attach time);
 *   4. its host is one of OUR windows — so a guest embedded by something else
 *      in this process cannot be borrowed either.
 *
 * Each check is separately load-bearing: (2) alone would still admit a guest on
 * another partition, and (3) alone would admit one hosted somewhere we do not
 * control.
 */
function resolveGuest(
  electron: ElectronModuleLike,
  webContentsId: number,
): WebContents {
  const refuse = (why: string): never => {
    throw new WebMcpWebviewAttachError(
      `The embedded page is not available any more (${why}). ` +
        "Close this session and open the page again.",
    );
  };

  const wc = electron.webContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) return refuse("it is gone");
  if (wc.getType() !== "webview") return refuse("it is not an embedded page");
  if (wc.session !== electron.session.fromPartition(WEBMCP_WEBVIEW_PARTITION)) {
    return refuse("it is not on the inspector's browsing partition");
  }
  const host = wc.hostWebContents;
  if (!host) return refuse("it has no host window");
  const ours = electron.BrowserWindow.getAllWindows().some(
    (window) => window.webContents === host,
  );
  if (!ours) return refuse("its host is not one of this app's windows");
  return wc;
}
