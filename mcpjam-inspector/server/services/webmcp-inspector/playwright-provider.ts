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
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { existsSync } from "node:fs";
import { ensureLocalChromiumInstalled } from "../../utils/browser-rendering-setup";
import {
  WEBMCP_FRAME_MAX_BYTES,
  WEBMCP_FRAME_MIN_INTERVAL_MS,
  WEBMCP_FRAME_QUALITY,
  WEBMCP_VIEWPORT,
  type WebMcpFrame,
  type WebMcpInputEvent,
  type WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import { createFrameThrottle, type FrameThrottle } from "./frame-throttle";
import { logger } from "../../utils/logger.js";
import {
  buildWebMcpLaunchArgs,
  PAGE_API_PROBE,
  webMcpHeadlessRequested,
} from "./launch-args";
import {
  WebMcpBridge,
  WebMcpBridgeError,
  type CdpLike,
} from "../browserd/daemon/webmcp-bridge";
import {
  WebMcpChromiumNotInstalledError,
  WebMcpInvocationCancelledError,
  WebMcpNoDisplayError,
  WebMcpToolGoneError,
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
/** Thumbnail width; small enough that a timeline of them stays cheap. */
const SCREENSHOT_WIDTH = 640;
const SCREENSHOT_MAX_BYTES = 64 * 1024;
/**
 * The one CDP payload this file still names.
 *
 * Everything the WebMCP domain declares — tools, responses, invocations — lives
 * in `webmcp-bridge.ts` now. The screencast is a Page-domain concern and stays
 * here with the rest of the viewport.
 */
interface CdpScreencastFrame {
  data: string;
  sessionId: number;
  metadata?: {
    deviceWidth?: number;
    deviceHeight?: number;
    timestamp?: number;
  };
}

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
 * Turn a bridge failure into the error this interface's callers handle.
 *
 * The two that carry meaning are named; everything else becomes a plain Error
 * with the page's own message, which is what the timeline shows. Kept at module
 * scope rather than inline so the mapping is one readable table instead of a
 * `catch` block with four branches in the middle of an invocation.
 */
function translateBridgeError(error: unknown, toolName: string): Error {
  if (!(error instanceof WebMcpBridgeError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  switch (error.failure) {
    case "webmcp_tool_gone":
      return new WebMcpToolGoneError(
        `The page no longer offers a tool named "${toolName}".`,
      );
    case "webmcp_cancelled":
      // The reason is the point: the browser answers every cancel `Canceled`,
      // so without carrying it a timed-out invocation is recorded as a user
      // cancellation — the one place the difference matters to whoever reads
      // the timeline later.
      return new WebMcpInvocationCancelledError(
        error.message,
        error.cancelReason ?? "cancelled",
      );
    case "webmcp_unsupported":
    case "webmcp_error":
      return new Error(error.message);
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
  private url: string;
  private disposed = false;
  /** Whether the browser is currently painting frames at us. */
  private screencasting = false;
  private readonly frameThrottle: FrameThrottle<WebMcpFrame>;
  /** One in-flight budgeted substitute at a time; see `substituteFrame`. */
  private substituting = false;

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
    this.frameThrottle = createFrameThrottle<WebMcpFrame>({
      minIntervalMs: WEBMCP_FRAME_MIN_INTERVAL_MS,
      emit: (frame) => this.callbacks.onFrame(frame),
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
    this.wireScreencast();
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
      this.callbacks.onNavigated(frame.url, originOf(frame.url));
    });
  }

  private wireScreencast(): void {
    this.cdp.on("Page.screencastFrame", (event) => {
      const frame = event as CdpScreencastFrame;
      // ACK FIRST, before any size check, throttling or publishing. Chromium
      // sends the NEXT frame only once the current one is acknowledged, so an
      // ack that waits on consumption lets a slow consumer starve the stream
      // into stillness — and the pane would then show a page frozen at whatever
      // it looked like when the consumer fell behind.
      void this.cdp
        .send(
          "Page.screencastFrameAck" as never,
          {
            sessionId: frame.sessionId,
          } as never,
        )
        .catch(() => {});

      // A frame already in flight when the stream was stopped. Publishing it
      // would repaint a pane the client has just cleared, with a picture
      // nothing is going to correct afterwards.
      if (!this.screencasting || this.disposed) return;

      // A frame is transient — the next paint replaces it — so an oversized one
      // is dropped rather than re-encoded in the hot path. But the throttle's
      // trailing-frame guarantee does not cover THIS drop, so a complex page
      // whose final paint never fits would leave the pane stale forever.
      // Converge it with one budgeted screenshot instead: lower fidelity, but
      // the current paint.
      const bytes = Buffer.byteLength(frame.data, "base64");
      if (bytes > WEBMCP_FRAME_MAX_BYTES) {
        void this.substituteFrame();
        return;
      }

      this.frameThrottle.push({
        data: frame.data,
        deviceWidth: frame.metadata?.deviceWidth ?? WEBMCP_VIEWPORT.width,
        deviceHeight: frame.metadata?.deviceHeight ?? WEBMCP_VIEWPORT.height,
        ts: Date.now(),
      });
    });
  }

  /**
   * Publish one frame through the BUDGETED screenshot path, for a paint the
   * screencast could not deliver under the frame cap.
   *
   * Reuses `captureScreenshot()` rather than re-encoding here: that path is
   * already the tested one (64 KiB, q50 then q30@640 on retry), and having two
   * shrink policies would mean two things to keep in step.
   *
   * Single-flight, because the frames that trigger it arrive in bursts and a
   * screenshot per oversized frame would queue CDP round trips behind a page
   * that is already expensive to encode.
   */
  private async substituteFrame(): Promise<void> {
    if (this.substituting || this.disposed || !this.screencasting) return;
    this.substituting = true;
    try {
      const data = await this.captureScreenshot();
      if (!data || this.disposed || !this.screencasting) return;
      this.frameThrottle.push({
        data,
        // The budgeted retry may have clipped to a narrower crop, but the
        // client scales by the frame's own dimensions, so reporting the
        // viewport it was captured from keeps the picture in the right box.
        deviceWidth: WEBMCP_VIEWPORT.width,
        deviceHeight: WEBMCP_VIEWPORT.height,
        ts: Date.now(),
      });
    } finally {
      this.substituting = false;
    }
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

  async captureScreenshot(): Promise<string | undefined> {
    try {
      const buffer = await this.page.screenshot({
        type: "jpeg",
        quality: 50,
        timeout: 5_000,
      });
      if (buffer.byteLength <= SCREENSHOT_MAX_BYTES) {
        return buffer.toString("base64");
      }
      // One retry at a smaller size. A frame that still will not fit the budget
      // is dropped: the timeline can say "no screenshot", but it must not carry
      // multi-megabyte entries.
      const smaller = await this.page.screenshot({
        type: "jpeg",
        quality: 30,
        clip: {
          x: 0,
          y: 0,
          width: SCREENSHOT_WIDTH,
          height: Math.round(
            (SCREENSHOT_WIDTH * WEBMCP_VIEWPORT.height) / WEBMCP_VIEWPORT.width,
          ),
        },
        timeout: 5_000,
      });
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

  /**
   * Apply a batch of input to the page, in order.
   *
   * Driven through Playwright's `page.mouse` / `page.keyboard` rather than raw
   * `Input.dispatchMouseEvent` / `dispatchKeyEvent`. Those primitives take a
   * modifier bitmask, a `text`/`unmodifiedText` pair, a `windowsVirtualKeyCode`
   * and a `code`, all of which have to be derived per key and per layout —
   * Playwright already carries that table, along with modifier state tracking
   * and click counting. Reimplementing it here would be reimplementing it
   * WRONGLY, quietly, for every key that is not a letter.
   *
   * Each event is applied under its own try/catch. One exotic key that
   * Playwright refuses to map must not swallow the click queued behind it — a
   * batch is a person's gesture, and losing the rest of it is far more visible
   * than losing the one event that failed.
   */
  async dispatchInput(events: WebMcpInputEvent[]): Promise<void> {
    if (this.disposed) return;
    for (const event of events) {
      try {
        await this.applyInput(event);
      } catch (error) {
        logger.debug("[webmcp] could not apply an input event", {
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async applyInput(event: WebMcpInputEvent): Promise<void> {
    switch (event.kind) {
      case "mouse_move":
        await this.page.mouse.move(...this.clamp(event.x, event.y));
        return;
      case "mouse_down":
        await this.page.mouse.move(...this.clamp(event.x, event.y));
        await this.page.mouse.down({
          button: event.button,
          ...(event.clickCount ? { clickCount: event.clickCount } : {}),
        });
        return;
      case "mouse_up":
        await this.page.mouse.move(...this.clamp(event.x, event.y));
        await this.page.mouse.up({
          button: event.button,
          ...(event.clickCount ? { clickCount: event.clickCount } : {}),
        });
        return;
      case "wheel":
        await this.page.mouse.move(...this.clamp(event.x, event.y));
        await this.page.mouse.wheel(event.deltaX, event.deltaY);
        return;
      case "key_down":
        await this.page.keyboard.down(event.key);
        return;
      case "key_up":
        await this.page.keyboard.up(event.key);
        return;
      case "text":
        // `insertText`, not a synthesized key sequence. Paste and IME
        // composition have no keystrokes to replay, and reconstructing them
        // would be wrong in a different way on every keyboard layout.
        await this.page.keyboard.insertText(event.text);
        return;
    }
  }

  /**
   * Hold a pointer inside the viewport.
   *
   * The client scales against the frame it is looking at, so a coordinate
   * arriving out of range means the two disagreed for a moment — a resize, or a
   * frame that landed after the pane had already changed size. Clamping keeps
   * that from dispatching at a negative coordinate, where Chromium's behaviour
   * is its own business rather than anything the page would do.
   */
  private clamp(x: number, y: number): [number, number] {
    return [
      Math.min(Math.max(x, 0), WEBMCP_VIEWPORT.width - 1),
      Math.min(Math.max(y, 0), WEBMCP_VIEWPORT.height - 1),
    ];
  }

  async setScreencast(enabled: boolean): Promise<void> {
    if (this.disposed || enabled === this.screencasting) return;
    this.screencasting = enabled;
    if (enabled) {
      // Rides the session's existing CDPSession — the same one `Page.enable`
      // and the WebMCP domain are on. A second session would double every
      // event this class already handles.
      //
      // Page-target-level, so it survives navigations: the pane keeps painting
      // across a page load without anything re-arming it.
      await this.cdp
        .send(
          "Page.startScreencast" as never,
          {
            format: "jpeg",
            quality: WEBMCP_FRAME_QUALITY,
            maxWidth: WEBMCP_VIEWPORT.width,
            maxHeight: WEBMCP_VIEWPORT.height,
          } as never,
        )
        .catch((error) => {
          this.screencasting = false;
          logger.debug("[webmcp] could not start the screencast", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    this.frameThrottle.reset();
    await this.cdp.send("Page.stopScreencast" as never).catch(() => {});
  }

  viewportTransport(): WebMcpViewportTransport {
    // An embedded session has no window by construction, so the streamed pane
    // is the viewport — and it is interactive, which is what separates this
    // from plain `headless`. Reporting `headless` here would tell the client
    // there is nothing to drive.
    if (this.viewportMode === "embedded") {
      return { kind: "frame-stream", ...WEBMCP_VIEWPORT };
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
    // Before the context closes, so the browser stops encoding immediately
    // rather than painting into a teardown that is racing a timeout.
    this.frameThrottle.reset();
    if (this.screencasting) {
      this.screencasting = false;
      await this.cdp.send("Page.stopScreencast" as never).catch(() => {});
    }
    // Rejects every in-flight invocation and clears their timers.
    this.bridge.dispose();
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
        deviceScaleFactor: 1,
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
