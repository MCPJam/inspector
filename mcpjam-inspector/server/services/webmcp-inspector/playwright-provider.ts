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
  WEBMCP_VIEWPORT,
  type WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import {
  buildWebMcpLaunchArgs,
  PAGE_API_PROBE,
  webMcpHeadlessRequested,
} from "./launch-args";
import {
  WebMcpChromiumNotInstalledError,
  WebMcpInvocationCancelledError,
  WebMcpNoDisplayError,
  WebMcpToolGoneError,
  WebMcpUnsupportedError,
  type CreateWebMcpSessionOptions,
  type ProviderToolDescriptor,
  type WebMcpBrowserProvider,
  type WebMcpBrowserSession,
  type WebMcpInvokeRequest,
  type WebMcpSessionCallbacks,
} from "./provider";

/** Cap on how long a browser teardown may block shutdown. */
const CLOSE_TIMEOUT_MS = 5_000;
/** Thumbnail width; small enough that a timeline of them stays cheap. */
const SCREENSHOT_WIDTH = 640;
const SCREENSHOT_MAX_BYTES = 64 * 1024;
/** Grace period for the browser's own Canceled response after we ask to cancel. */
const CANCEL_SETTLE_GRACE_MS = 1_000;

/** CDP payloads, as the domain definition declares them. */
interface CdpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    consequential?: boolean;
    autosubmit?: boolean;
  };
  frameId: string;
  backendNodeId?: number;
  stackTrace?: { callFrames: unknown[] };
}
interface CdpRemovedTool {
  name: string;
  frameId: string;
}
interface CdpToolResponded {
  invocationId: string;
  status: "Completed" | "Canceled" | "Error";
  output?: unknown;
  errorText?: string;
  exception?: { description?: string };
}
interface CdpToolInvoked {
  toolName: string;
  frameId: string;
  invocationId: string;
  input: string;
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

class PlaywrightWebMcpSession implements WebMcpBrowserSession {
  /** Tools keyed `${frameId} ${name}` — the browser's own notion of identity. */
  private readonly tools = new Map<string, CdpTool>();
  /** frameId to last known URL, for origin labelling and subframe detection. */
  private readonly frames = new Map<string, string>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: { output: unknown }) => void;
      reject: (error: Error) => void;
      /**
       * Why WE asked the browser to stop, if we did.
       *
       * The browser answers a cancel with `Canceled` whatever the reason, so
       * without remembering it here a timed-out invocation would be recorded on
       * the timeline as a user cancellation — the one place where the
       * difference actually matters to whoever reads it later.
       */
      cancelReason?: "cancelled" | "timeout";
    }
  >();
  private url: string;
  private mainFrameId = "";
  private disposed = false;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly callbacks: WebMcpSessionCallbacks,
    startUrl: string,
    private readonly headless: boolean,
  ) {
    this.url = startUrl;
  }

  async start(url: string): Promise<void> {
    this.wireCdp();
    this.wirePage();
    await this.cdp.send("Page.enable" as never).catch(() => {});
    await this.cdp.send("WebMCP.enable" as never);
    await this.navigate(url);

    // `WebMCP.enable` resolves even on a browser with the feature switched off
    // - it just never reports a tool. So support is probed in the page, after
    // the first navigation, where the API either exists or does not.
    const supported = await this.page
      .evaluate(PAGE_API_PROBE)
      .catch(() => false);
    if (!supported) {
      throw new WebMcpUnsupportedError(
        "This browser build does not expose the WebMCP page API " +
          "(document.modelContext), so no tools can be discovered. The page " +
          "itself loaded normally; check that the page is origin-isolated, " +
          "the WebMCP tools Permissions Policy is allowed, and the feature is " +
          "enabled for this origin.",
      );
    }
  }

  private wireCdp(): void {
    this.cdp.on("WebMCP.toolsAdded", (event) => {
      const { tools } = event as { tools: CdpTool[] };
      for (const tool of tools) {
        this.tools.set(this.key(tool.frameId, tool.name), tool);
      }
      this.emitTools();
    });

    // Chromium does emit this for an explicit page-side unregister; it just
    // never fires on navigation. Both paths converge on a fresh snapshot.
    this.cdp.on("WebMCP.toolsRemoved", (event) => {
      const { tools } = event as { tools: CdpRemovedTool[] };
      for (const tool of tools) {
        this.tools.delete(this.key(tool.frameId, tool.name));
      }
      this.emitTools();
    });

    this.cdp.on("WebMCP.toolInvoked", (event) => {
      const invoked = event as CdpToolInvoked;
      // Every invocation we start is registered before the command is sent, so
      // anything unknown here was started by someone else: the page's own
      // agent, or a devtools panel. Worth surfacing, because it explains state
      // changes the timeline would otherwise attribute to nothing.
      if (!this.pending.has(invoked.invocationId)) {
        this.callbacks.onExternalInvocation(
          "A tool was invoked from outside this inspector.",
          invoked.toolName,
        );
      }
    });

    this.cdp.on("WebMCP.toolResponded", (event) => {
      const responded = event as CdpToolResponded;
      const waiter = this.pending.get(responded.invocationId);
      if (!waiter) return;
      this.pending.delete(responded.invocationId);
      if (responded.status === "Completed") {
        waiter.resolve({ output: responded.output });
        return;
      }
      if (responded.status === "Canceled") {
        const reason = waiter.cancelReason ?? "cancelled";
        waiter.reject(
          new WebMcpInvocationCancelledError(
            reason === "timeout"
              ? "The tool did not respond in time."
              : "The invocation was cancelled.",
            reason,
          ),
        );
        return;
      }
      // On Error, `errorText` is empty in practice and the usable message is on
      // the exception's description.
      waiter.reject(
        new Error(
          responded.exception?.description?.split("\n")[0] ||
            responded.errorText ||
            "The page tool failed without a message.",
        ),
      );
    });

    this.cdp.on("Page.frameNavigated", (event) => {
      const { frame } = event as {
        frame: { id: string; url: string; parentId?: string };
      };
      this.frames.set(frame.id, frame.url);
      // Navigation fires NO toolsRemoved, and the main frame KEEPS its id, so
      // nothing the browser tells us separates "tools of the page we just left"
      // from "tools of the page we are on". Dropping the navigated frame's
      // tools here is what stops the registry serving tools that no longer
      // exist; the new page's registrations arrive immediately after.
      this.dropToolsForFrame(frame.id);
      if (!frame.parentId) {
        this.mainFrameId = frame.id;
        this.url = frame.url;
        this.callbacks.onNavigated(frame.url, originOf(frame.url));
      }
      this.emitTools();
    });

    this.cdp.on("Page.frameDetached", (event) => {
      const { frameId } = event as { frameId: string };
      this.frames.delete(frameId);
      this.dropToolsForFrame(frameId);
      this.emitTools();
    });
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

  private key(frameId: string, name: string): string {
    return `${frameId} ${name}`;
  }

  private dropToolsForFrame(frameId: string): void {
    for (const key of [...this.tools.keys()]) {
      if (key.startsWith(`${frameId} `)) this.tools.delete(key);
    }
  }

  private emitTools(): void {
    const descriptors: ProviderToolDescriptor[] = [...this.tools.values()].map(
      (tool) => {
        const frameUrl = this.frames.get(tool.frameId) ?? this.url;
        return {
          frameId: tool.frameId,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          origin: originOf(frameUrl),
          isMainFrame: tool.frameId === this.mainFrameId,
          registrationKind:
            tool.backendNodeId !== undefined
              ? "declarative"
              : tool.stackTrace
                ? "imperative"
                : "unknown",
        };
      },
    );
    this.callbacks.onToolsChanged(descriptors);
  }

  /**
   * Resolve a tool name to the frame currently offering it, preferring the main
   * frame. Frame ids churn across navigations, so this happens at invoke time
   * rather than being carried around as identity.
   */
  private resolveFrame(toolName: string): string {
    for (const tool of this.tools.values()) {
      if (tool.name === toolName && tool.frameId === this.mainFrameId) {
        return tool.frameId;
      }
    }
    for (const tool of this.tools.values()) {
      if (tool.name === toolName) return tool.frameId;
    }
    throw new WebMcpToolGoneError(
      `The page no longer offers a tool named "${toolName}".`,
    );
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

  async invokeTool(request: WebMcpInvokeRequest): Promise<{ output: unknown }> {
    const frameId = request.frameId || this.resolveFrame(request.toolName);
    if (request.signal.aborted) {
      throw new WebMcpInvocationCancelledError(
        "Cancelled before it started.",
        "cancelled",
      );
    }

    let invocationId: string;
    try {
      ({ invocationId } = (await this.cdp.send(
        "WebMCP.invokeTool" as never,
        {
          frameId,
          toolName: request.toolName,
          input: request.input,
        } as never,
      )) as { invocationId: string });
    } catch (error) {
      // An unknown tool rejects here rather than settling as a response.
      const message = error instanceof Error ? error.message : String(error);
      if (/tool not found/i.test(message)) {
        throw new WebMcpToolGoneError(
          `The page no longer offers a tool named "${request.toolName}".`,
        );
      }
      throw error;
    }

    return new Promise<{ output: unknown }>((resolve, reject) => {
      const waiter = { resolve, reject } as {
        resolve: (value: { output: unknown }) => void;
        reject: (error: Error) => void;
        cancelReason?: "cancelled" | "timeout";
      };
      this.pending.set(invocationId, waiter);

      let aborting = false;
      const onAbort = () => {
        // Idempotent: this runs from the listener AND from the already-aborted
        // re-check below, and both can be reached for one invocation.
        if (aborting) return;
        aborting = true;
        const reason =
          request.signal.reason === "timeout" ? "timeout" : "cancelled";
        waiter.cancelReason = reason;
        // Ask the browser to stop, then settle on its Canceled response. If
        // that never arrives (the page died mid-invocation), settle anyway so
        // the caller is never left waiting on a browser that is gone.
        this.cdp
          .send("WebMCP.cancelInvocation" as never, { invocationId } as never)
          .catch(() => {});
        setTimeout(() => {
          if (!this.pending.has(invocationId)) return;
          this.pending.delete(invocationId);
          reject(
            new WebMcpInvocationCancelledError(
              reason === "timeout"
                ? "The tool did not respond in time."
                : "The invocation was cancelled.",
              reason,
            ),
          );
        }, CANCEL_SETTLE_GRACE_MS);
      };

      request.signal.addEventListener("abort", onAbort, { once: true });
      // The listener is registered only after `WebMCP.invokeTool` resolves, so
      // an abort during that round trip has already fired and will never reach
      // it. Without this re-check the browser is never told to stop and the
      // caller waits on a tool nobody is going to cancel.
      if (request.signal.aborted) onAbort();
    });
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

  viewportTransport(): WebMcpViewportTransport {
    // V1 runs the browser on the developer's own machine, so the viewport IS
    // the window in front of them — unless it was launched headless, where
    // there is no window and the UI must not tell anyone to go look at one.
    // A remote provider returns an interactive URL here instead, and the client
    // renders that without further changes.
    return this.headless ? { kind: "headless" } : { kind: "native-window" };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("The browser session was closed."));
    }
    this.pending.clear();
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
    // Headed for real sessions: the developer drives their own window. Tests
    // pass `headless` explicitly; `MCPJAM_WEBMCP_HEADLESS` is the escape hatch
    // for an inspector running where no display exists.
    const headless = options.headless ?? webMcpHeadlessRequested();

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
