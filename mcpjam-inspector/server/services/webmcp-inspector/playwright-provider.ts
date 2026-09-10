/**
 * The only module in the inspector that speaks CDP.
 *
 * Everything it knows about Chrome's experimental `WebMCP` domain is asserted
 * against a real browser in `__tests__/webmcp-cdp.spike.test.ts`; when a
 * Chromium bump drifts the protocol, that suite fails with a named expectation
 * rather than this file failing mysteriously in production.
 *
 * Deliberately separate from `utils/mcp-app-browser-harness.ts`. That harness
 * is a hardened *widget* renderer: default-deny networking, `setContent` of a
 * bundled host page, one tab, no navigation. This drives a developer's own site
 * across real navigations. Sharing a class would mean one set of options
 * meaning two different things.
 */
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Frame,
  Page,
} from "playwright";
import { existsSync } from "node:fs";
import { ensureLocalChromiumInstalled } from "../../utils/browser-rendering-setup";
import {
  WEBMCP_FRAME_BOOST_INTERVAL_MS,
  WEBMCP_FRAME_BOOST_WINDOW_MS,
  WEBMCP_VIEWPORT,
  type WebMcpInputEvent,
  type WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import {
  createTabViewport,
  type TabViewport,
} from "../browserd/daemon/viewport";
import { toBrowserPaneInput } from "@/shared/webmcp-input";
import { logger } from "../../utils/logger.js";
import {
  buildWebMcpLaunchArgs,
  PAGE_API_PROBE,
  webMcpHeadlessRequested,
} from "./launch-args";
import { WebMcpBridge, type CdpLike } from "../browserd/daemon/webmcp-bridge";
import { SCREENSHOT_MAX_BYTES, translateBridgeError } from "./provider-shared";
import {
  WebMcpChromiumNotInstalledError,
  WebMcpNoDisplayError,
  WebMcpUnsupportedError,
  type CreateWebMcpSessionOptions,
  type WebMcpBrowserProvider,
  type WebMcpBrowserSession,
  type WebMcpInvokeRequest,
  type WebMcpSessionCallbacks,
  type WebMcpViewportMode,
} from "./provider";

/** Cap on how long a browser teardown may block shutdown. */
const CLOSE_TIMEOUT_MS = 5_000;
/** A stuck explicit screenshot must not hold the caller indefinitely. */
export const STILL_TIMEOUT_MS = 5_000;
/** Explicit timeline evidence uses a smaller byte budget than live frames. */
const SCREENSHOT_QUALITY_LADDER = [50, 30, 20] as const;

/**
 * The ONE attachment failure that means "nothing to attach here".
 *
 * Attachment is a PROBE, not an origin comparison: comparing origins does not
 * identify a separate renderer target, and Chromium's decision depends on
 * process allocation, not on the URL. Our pinned Playwright
 * (`playwright-core/lib/coreBundle.js`) throws exactly this when the frame has
 * no entry of its own in the page's session map, which is precisely the
 * question we are asking. Every OTHER failure — a target that went away
 * mid-attach, a protocol error, a `WebMCP.enable` rejection — is a frame we
 * SHOULD have seen and did not, and is reported rather than swallowed: a blind
 * `catch` here would recreate the exact blind spot child sessions exist to
 * close.
 */
const NO_SEPARATE_SESSION = /does not have a separate CDP session/i;

/**
 * The CDP frame id at the root of a child session's own frame tree.
 *
 * Playwright's `Frame` does not expose the CDP id, and the bridge routes
 * invocations by it — `WebMCP.invokeTool` rejects a frame id belonging to
 * another target — so it is read from the session itself. `Page.getFrameTree`
 * answers without `Page.enable`, which the bridge sends a moment later.
 */
async function frameIdOf(session: CDPSession): Promise<string> {
  const tree = (await session.send("Page.getFrameTree" as never)) as {
    frameTree?: { frame?: { id?: string } };
  };
  const id = tree?.frameTree?.frame?.id;
  if (!id) throw new Error("The frame session reported no frame id.");
  return id;
}

/**
 * `work`, or `undefined` if it takes longer than `ms`.
 *
 * The abandoned promise is left to settle on its own — it is one CDP reply,
 * and nothing is waiting on it once the caller has given up.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** An explicit screenshot can decline while another capture owns the slot. */
type StillAttempt =
  { got: "picture"; data: string } | { got: "busy" } | { got: "failed" };

/** As in the widget harness: a hung close must not block shutdown. */
async function waitForClose(promise: Promise<unknown> | undefined) {
  if (!promise) return;
  await Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "about:blank";
  }
}

/**
 * Exported for `__tests__/playwright-provider.screencast.test.ts`, which drives
 * the CDP wiring with fakes. The screencast path is the one part of this file
 * whose ordering (ack before anything else) cannot be observed from the
 * provider's public surface, and the Chromium-gated integration suite only runs
 * where a WebMCP-capable build exists.
 */
export class PlaywrightWebMcpSession implements WebMcpBrowserSession {
  /**
   * The WebMCP state machine, shared with the daemon.
   *
   * ONE copy of it now. This file used to carry its own — tool map, frame map,
   * pending invocations, cancel-reason bookkeeping — beside an identical one in
   * `browserd/daemon/webmcp-bridge.ts`, and every hard-won behaviour in it (a
   * navigation fires no `toolsRemoved`; the browser answers every cancel
   * `Canceled` whatever the reason; a cancel the page never answers must still
   * settle) had to be fixed twice or drift. The bridge imports nothing, so
   * Playwright's `CDPSession` satisfies its `CdpLike` structurally and this is
   * a plain instantiation.
   *
   * What stays HERE is everything outside the WebMCP domain: the screencast,
   * input dispatch, navigation, screenshots and lifecycle.
   */
  private readonly bridge: WebMcpBridge;
  /**
   * Playwright `Frame` → the bridge token for its attachment.
   *
   * Keyed by the frame OBJECT rather than its id: Playwright hands back the
   * same object for the life of a frame, while the CDP frame id survives a
   * cross-origin navigation and so cannot tell one attachment from the next.
   * The token is what teardown quotes, which is what stops a late removal
   * emptying a frame its replacement has already re-registered.
   */
  private readonly frameSessions = new Map<Frame, string>();
  /** Frames a sweep is already attaching, so two sweeps do not race one frame. */
  private readonly attaching = new Set<Frame>();
  private url: string;
  private disposed = false;
  /** Whether the browser is currently painting frames at us. */
  private readonly viewport: TabViewport;
  private unsubscribeViewport?: () => void;
  private captureInFlight = false;
  private readonly surface = { ...WEBMCP_VIEWPORT };

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly callbacks: WebMcpSessionCallbacks,
    startUrl: string,
    private readonly headless: boolean,
    private readonly viewportMode: WebMcpViewportMode = "window",
  ) {
    this.url = startUrl;
    this.viewport = createTabViewport(cdp as unknown as CdpLike, {
      surface: this.surface,
    });
    this.bridge = new WebMcpBridge(cdp as unknown as CdpLike, {
      // The bridge's descriptors are already the raw browser facts this
      // interface asks for, frame id included, so the snapshot passes straight
      // through. Identity policy — stable keys, collision suffixes — is the
      // runtime's, one layer up, because that is the layer that sees the whole
      // registry at once.
      onChange: (tools) => this.callbacks.onToolsChanged(tools),
      onExternalInvocation: (toolName) =>
        this.callbacks.onExternalInvocation(
          "A tool was invoked from outside this inspector.",
          toolName || undefined,
        ),
    });
  }

  async start(url: string): Promise<void> {
    // Wired BEFORE the bridge, so its `Page.frameNavigated` handler runs first
    // and the runtime still sees `navigated` ahead of the tool snapshot the
    // bridge publishes from the same event. CDP dispatches handlers in
    // registration order, and the timeline reads badly the other way round.
    this.wireNavigation();
    this.wirePage();
    // The first navigation happens INSIDE the bridge's probe callback, because
    // both of its neighbours pin it there: the domains must be enabled first or
    // tools registered during page load are never reported, and the page must
    // be loaded before `document.modelContext` can be asked about — the domain
    // is never the probe, since `WebMCP.enable` resolves even where the feature
    // is switched off.
    //
    // The bridge treats a throwing probe as "unsupported", which is right for a
    // probe and wrong for a navigation: a DNS failure or a refused connection
    // would be reported as "this browser cannot do WebMCP" and send someone
    // chasing a browser problem they do not have. So the navigation's own
    // failure is carried out and rethrown as itself.
    let navigationFailure: unknown;
    await this.bridge.start(async () => {
      try {
        await this.navigate(url);
      } catch (error) {
        navigationFailure = error;
        return false;
      }
      return (
        (await this.page.evaluate(PAGE_API_PROBE).catch(() => false)) === true
      );
    });
    if (navigationFailure) throw navigationFailure;
    // Before the unsupported check: an embedded session has no window, so the
    // stream is the ONLY view of it. A page that turns out to have no WebMCP
    // support still deserves to be visible while the person reads why.
    if (this.viewportMode === "embedded") await this.setScreencast(true);
    // Detected HERE rather than left to the bridge's own per-invocation
    // refusal, so creating a session on a browser that cannot do WebMCP fails
    // immediately with an explanation instead of succeeding into an empty tool
    // list that looks like the page's fault.
    if (!this.bridge.isSupported()) {
      throw new WebMcpUnsupportedError(
        "This browser build does not expose the WebMCP page API " +
          "(document.modelContext), so no tools can be discovered. The page " +
          "itself loaded normally; check that the page is origin-isolated, " +
          "the WebMCP tools Permissions Policy is allowed, and the feature is " +
          "enabled for this origin.",
      );
    }
    // LAST, and after the first navigation: the sweep sees the frames the
    // start page actually created, and a session that is about to be refused
    // as unsupported never pays for it. Frames that arrive later are caught by
    // `frameattached` and by the post-navigation sweep.
    await this.sweepFrameSessions();
  }

  /**
   * The one Page-domain fact this class still needs for itself: where we are.
   *
   * The bridge watches the same event for its own bookkeeping — it has to, to
   * drop a navigated frame's tools — but the main-frame URL is a session fact,
   * not a WebMCP one, so it is read here rather than routed back out of the
   * bridge.
   */
  private wireNavigation(): void {
    this.cdp.on("Page.frameNavigated", (event) => {
      const { frame } = event as {
        frame: { id: string; url: string; parentId?: string };
      };
      if (frame.parentId) return;
      this.url = frame.url;
      this.viewport.invalidate();
      this.callbacks.onNavigated(frame.url, originOf(frame.url));
    });
  }

  private async captureStill(quality: number): Promise<StillAttempt> {
    // Nothing to gain by asking a browser that has not answered the last one,
    // and something to lose — see `captureInFlight`.
    if (this.captureInFlight) return { got: "busy" };
    this.captureInFlight = true;
    const free = () => {
      this.captureInFlight = false;
    };
    try {
      const sent = this.cdp.send(
        "Page.captureScreenshot" as never,
        {
          format: "jpeg",
          quality,
          // The compositor's own surface: no relayout, no paint, and the
          // picture the person is actually looking at.
          fromSurface: true,
        } as never,
      );
      // Released by the COMMAND settling, not by this function returning.
      // Whatever it eventually is — a picture nobody is waiting for any more,
      // or an error — it is the browser answering, which is the only thing
      // that says the next capture is worth sending. Releasing it where the
      // timeout gives up instead would leave the command registered and the
      // gate open, which is the accumulation this exists to prevent.
      void sent.then(free, free);
      const result = (await withTimeout(sent, STILL_TIMEOUT_MS)) as
        { data?: string } | undefined;
      return typeof result?.data === "string"
        ? { got: "picture", data: result.data }
        : { got: "failed" };
    } catch {
      // A `send` that threw synchronously registered nothing to release it.
      // Idempotent, so the settled-command path above may also have run.
      free();
      return { got: "failed" };
    }
  }

  noteFramePressure(): void {
    this.viewport.noteTransportDrop();
  }

  private wirePage(): void {
    this.page.on("popup", (popup) => {
      // Left open on purpose: closing a popup, or re-hosting its URL in the
      // main tab, breaks OAuth and anything using window.opener. We report it
      // and stay out of the way. Its tools belong to a separate target and are
      // out of V1 scope.
      const report = (url: string) => this.callbacks.onPopupOpened(url);
      popup
        .waitForLoadState("domcontentloaded", { timeout: 3_000 })
        .then(() => report(popup.url()))
        .catch(() => report(popup.url()));
    });
    this.page.on("crash", () =>
      this.callbacks.onCrashed("The browser page crashed."),
    );
    this.page.on("close", () => {
      if (!this.disposed) this.callbacks.onCrashed("The browser was closed.");
    });
    // A human driving the window keeps the session alive even while the
    // inspector tab is closed.
    this.page.on("framenavigated", () => this.callbacks.onActivityObserved());
    this.page.on("console", () => this.callbacks.onActivityObserved());
    this.wireFrameSessions();
  }

  /**
   * Keep one CDP session per separately-targeted frame.
   *
   * ATTACH on `frameattached`, and SWEEP `page.frames()` after every
   * navigation. Both, because neither alone is enough: a frame can be attached
   * before it has a target of its own (Chromium hands it one only once it
   * commits a cross-origin document, which arrives as a `swap` detach on the
   * page's session), and a frame already present when we started has no
   * `frameattached` left to fire.
   *
   * REPLACE IS NOT OURS TO DO, on this transport. A Playwright frame session is
   * bound to the FRAME, not to the target behind it: measured across a genuinely
   * cross-site navigation of an out-of-process frame (`--site-per-process`,
   * 127.0.0.1 → localhost), the session stays alive, keeps its frame id, and
   * reports the NEW document's tools. So an attached frame is skipped by later
   * sweeps rather than re-attached — re-attaching would open a second session on
   * the same target and blank the panel for the moment between retiring the old
   * attachment and the new one registering. The bridge's replace path still
   * matters for Electron, where a target swap really does mint a new session id.
   *
   * NESTED TARGETS need no recursion here. Playwright's own auto-attach is
   * already recursive, so `page.frames()` enumerates a cross-origin frame
   * inside a cross-origin frame (measured in the spike), and a flat sweep of it
   * reaches every depth. Recursing ourselves would revisit the same frames.
   */
  private wireFrameSessions(): void {
    this.page.on("frameattached", (frame) => {
      void this.attachFrameSession(frame);
    });
    this.page.on("framenavigated", () => {
      // The whole sweep, not just the navigated frame. Two reasons: a
      // navigation can give a DESCENDANT its own target, and a frame that was
      // same-origin when we last looked (so had nothing to attach to) becomes
      // attachable the moment it commits a cross-origin document.
      void this.sweepFrameSessions();
    });
    // REMOVE, not SWAP. Playwright's `framedetached` fires only when the frame
    // really goes away — the target swap that CDP reports when a frame becomes
    // cross-origin never reaches here, which is what makes this the honest
    // teardown signal. It quotes the attachment's TOKEN, so a removal landing
    // after a re-attachment names an attachment that is already gone.
    this.page.on("framedetached", (frame) => {
      const token = this.frameSessions.get(frame);
      if (token === undefined) return;
      this.frameSessions.delete(frame);
      this.bridge.removeSession(token);
    });
  }

  /** Attach to every frame that turns out to have its own target. */
  private async sweepFrameSessions(): Promise<void> {
    if (this.disposed) return;
    await Promise.all(
      this.page.frames().map((frame) => this.attachFrameSession(frame)),
    );
  }

  private async attachFrameSession(frame: Frame): Promise<void> {
    if (this.disposed) return;
    // The page's own session already covers the main frame; a second session on
    // it would report every tool twice and give the bridge two owners for one
    // frame.
    if (frame === this.page.mainFrame()) return;
    if (this.frameSessions.has(frame) || this.attaching.has(frame)) return;
    this.attaching.add(frame);
    try {
      const session = await this.context.newCDPSession(frame);
      if (this.disposed) return;
      const frameId = await frameIdOf(session);
      const token = await this.bridge.addSession(
        frameId,
        session as unknown as CdpLike,
      );
      // The frame can go away DURING the attach, and its `framedetached` has
      // then already run and found no token to remove. Checking after the fact
      // is what stops that leaving a dead session wired to the bridge, still
      // publishing tools for a frame that is no longer on the page.
      if (this.disposed || frame.isDetached()) {
        this.bridge.removeSession(token);
        return;
      }
      this.frameSessions.set(frame, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "Nothing to attach here" is the ordinary answer for a same-origin
      // frame, and the only one that is silent.
      if (NO_SEPARATE_SESSION.test(message)) return;
      logger.warn("[webmcp] could not attach a CDP session to a frame", {
        url: frame.url(),
        error: message,
      });
      // A frame we could not reach is a frame whose tools are missing, so it is
      // a visible session condition rather than a page that merely looks empty.
      this.callbacks.onSessionNotice?.(
        `Could not inspect a frame at ${frame.url() || "about:blank"}: ${message}. Any WebMCP tools it registers are not listed.`,
      );
    } finally {
      this.attaching.delete(frame);
    }
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    this.url = this.page.url();
    this.callbacks.onActivityObserved();
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    this.url = this.page.url();
  }

  async goBack(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
    this.url = this.page.url();
  }

  /**
   * Run a page tool, translating the bridge's vocabulary into this interface's.
   *
   * The translation is the whole job here, and each mapping matters to someone
   * reading the timeline afterwards: `webmcp_tool_gone` is "the page moved on",
   * a cancel carries WHY it was cancelled (the browser's own answer never
   * says), and the daemon's `{invocationId, output}` envelope loses its id
   * because the runtime already has its own handle for this call.
   */
  async invokeTool(request: WebMcpInvokeRequest): Promise<{ output: unknown }> {
    try {
      const { output } = await this.bridge.invoke({
        toolName: request.toolName,
        // The frame the runtime resolved from its own registry, so a subframe's
        // tool is not shadowed by a same-named one in the main frame.
        ...(request.frameId ? { frameId: request.frameId } : {}),
        strictFrame: true,
        expectedRegistrationSeq: request.expectedBinding?.registrationSeq,
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
   * A capture for the timeline — and for the client's screenshot POLL, which
   * is the fallback whenever a screencast cannot be started.
   *
   * QUALITY degrades, geometry never. This used to retry as a crop of the
   * top-left 640x400, which is defensible for a thumbnail viewed as-is and
   * wrong for the poll: the pane renders whatever comes back as the whole
   * 1280x800 surface and maps clicks across it, so a crop presented as a
   * viewport puts every click at up to twice its true coordinate. A session
   * rendering above one device pixel per CSS pixel made that retry far more
   * likely, because a device-scaled full capture is four times the pixels and
   * blows the 64 KiB budget on ordinary pages.
   *
   * The same surface capture the stills use, for the same reasons: no DOM
   * mutation (Playwright's caret hiding paints), no clip (which resets the
   * context's own device scale factor), and CSS resolution, which is the
   * geometry the client scales against.
   */
  async captureScreenshot(): Promise<string | undefined> {
    for (const quality of SCREENSHOT_QUALITY_LADDER) {
      const attempt = await this.captureStill(quality);
      // Both non-pictures answer the same way here, and the caller reads them
      // the same way: "no new picture", which the client holds its current one
      // through. The poll comes back in a second, which is sooner than any
      // retry this could arrange.
      if (attempt.got !== "picture") return undefined;
      if (Buffer.byteLength(attempt.data, "base64") <= SCREENSHOT_MAX_BYTES) {
        return attempt.data;
      }
    }
    // Nothing fit. The timeline can say "no screenshot"; it must not carry a
    // multi-megabyte entry, and the pane must not be handed a wrong shape.
    return undefined;
  }

  currentUrl(): string {
    return this.url;
  }

  /** Shared inspection permits pane input while a tool invocation is pending. */
  async dispatchInput(events: WebMcpInputEvent[]): Promise<void> {
    if (this.disposed) return;
    this.viewport.boost(
      WEBMCP_FRAME_BOOST_INTERVAL_MS,
      WEBMCP_FRAME_BOOST_WINDOW_MS,
    );
    await this.viewport.dispatchInput(events.map(toBrowserPaneInput));
  }

  async setScreencast(enabled: boolean): Promise<boolean> {
    if (this.disposed) return false;
    if (!enabled) {
      this.unsubscribeViewport?.();
      this.unsubscribeViewport = undefined;
      return false;
    }
    this.unsubscribeViewport ??= this.viewport.subscribe((frame) =>
      this.callbacks.onFrame(frame),
    );
    const started = await this.viewport.ready();
    if (!started) {
      this.unsubscribeViewport?.();
      this.unsubscribeViewport = undefined;
    }
    return started;
  }

  async resizeViewport(width: number, height: number): Promise<void> {
    if (this.disposed || this.viewportMode !== "embedded") return;
    try {
      await this.viewport.resize({ width, height }, () =>
        this.page.setViewportSize({ width, height }),
      );
    } catch (error) {
      // Closing a page while its resize is in flight is normal teardown.
      // A failure on a live page must still reach the caller.
      if (this.disposed || this.page.isClosed()) return;
      throw error;
    }
  }

  viewportTransport(): WebMcpViewportTransport {
    // An embedded session has no window by construction, so the streamed pane
    // is the viewport — and it is interactive, which is what separates this
    // from plain `headless`. Reporting `headless` here would tell the client
    // there is nothing to drive.
    if (this.viewportMode === "embedded") {
      return { kind: "frame-stream", ...this.surface };
    }
    // Otherwise the browser runs on the developer's own machine, so the
    // viewport IS the window in front of them — unless it was launched
    // headless, where there is no window and the UI must not tell anyone to go
    // look at one. A remote provider returns an interactive URL here instead,
    // and the client renders that without further changes.
    return this.headless ? { kind: "headless" } : { kind: "native-window" };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeViewport?.();
    this.unsubscribeViewport = undefined;
    await this.viewport.dispose();
    // Rejects every in-flight invocation and clears their timers.
    this.bridge.dispose();
    this.frameSessions.clear();
    this.attaching.clear();
    await waitForClose(this.context.close());
    await waitForClose(this.browser.close());
  }
}

export class PlaywrightWebMcpProvider implements WebMcpBrowserProvider {
  /** Overridable so tests can force the binary-missing path. */
  protected async loadChromium() {
    try {
      const { chromium } = await import("playwright");
      return chromium;
    } catch {
      const { chromium } = await import("playwright-core");
      return chromium;
    }
  }

  async createSession(
    options: CreateWebMcpSessionOptions,
  ): Promise<WebMcpBrowserSession> {
    const chromium = await this.loadChromium();
    await this.ensureExecutable(chromium);

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    const viewportMode = options.viewportMode ?? "window";
    // Headed for real sessions: the developer drives their own window. Tests
    // pass `headless` explicitly; `MCPJAM_WEBMCP_HEADLESS` is the escape hatch
    // for an inspector running where no display exists.
    //
    // An embedded session is headless regardless of either, and not as a
    // default someone can override: its whole proposition is that the page
    // lives in the pane. A window would put a second, separately-driveable copy
    // of the page on the developer's desktop, and the two would fight for the
    // same clicks.
    const headless =
      viewportMode === "embedded"
        ? true
        : (options.headless ?? webMcpHeadlessRequested());

    try {
      // Chromium cannot start its sandbox as uid 0 (the pinned CI/browser
      // container runs as root). Playwright adds the minimal no-sandbox
      // fallback in that environment; every unprivileged local/production
      // process keeps the renderer sandbox enabled.
      const chromiumSandbox = process.getuid?.() !== 0;
      browser = await chromium.launch({
        headless,
        // The inspector opens arbitrary pages. Keep Chromium's renderer
        // sandbox enabled wherever the OS permits it.
        chromiumSandbox,
        args: buildWebMcpLaunchArgs(),
      });
      context = await browser.newContext({
        viewport: { ...WEBMCP_VIEWPORT },
        // The VIEWER's ratio, so the page rasterises the way it would on their
        // own screen: text at 2x is laid out and hinted for 2x and reaches the
        // pane supersampled rather than merely upscaled. Set once, at context
        // creation, rather than emulated per navigation — see the option's
        // documentation for why a second override is the wrong instrument.
        deviceScaleFactor: options.devicePixelRatio ?? 1,
        acceptDownloads: false,
        permissions: [],
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const session = new PlaywrightWebMcpSession(
        browser,
        context,
        page,
        cdp,
        options.callbacks,
        options.url,
        headless,
        viewportMode,
      );
      await session.start(options.url);
      return session;
    } catch (error) {
      await waitForClose(context?.close());
      await waitForClose(browser?.close());
      const message = error instanceof Error ? error.message : String(error);
      // Headed launch on a machine with no display: SSH, a container, a bare
      // WSL install. Playwright's own text is a wall of browser logs, and the
      // fix is one env var, so say that instead of relaying it.
      if (/XServer|Missing X server|DISPLAY/i.test(message)) {
        throw new WebMcpNoDisplayError(
          "The WebMCP Inspector opens a real browser window, and this machine has no display " +
            "to open one on. Set MCPJAM_WEBMCP_HEADLESS=true to run the browser headless — " +
            "tool discovery, invocation and screenshots all still work; only interacting with " +
            "the page by hand does not. If you need to interact with the page, use a hosted " +
            "browser on an MCPJam computer instead: it runs on a machine with a display, and " +
            "you drive it from the Browser panel.",
        );
      }
      if (/Executable doesn't exist|please run|install/i.test(message)) {
        throw new WebMcpChromiumNotInstalledError(message);
      }
      throw error;
    }
  }

  private async ensureExecutable(chromium: {
    executablePath(): string;
  }): Promise<void> {
    const resolve = () => {
      try {
        const path = chromium.executablePath();
        return path && existsSync(path) ? path : undefined;
      } catch {
        return undefined;
      }
    };
    if (resolve()) return;
    await ensureLocalChromiumInstalled({ reason: "webmcp" });
    if (resolve()) return;
    throw new WebMcpChromiumNotInstalledError(
      "Chromium is required to inspect a page's WebMCP tools, and it could not be installed.",
    );
  }
}

export const playwrightWebMcpProvider = new PlaywrightWebMcpProvider();
