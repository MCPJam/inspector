import {
  createContextSurface,
  registerContextSurface,
  forgetContextSurface,
  type ContextSurface,
} from "../browserd/electron/agent-surface";
import { launchElectronContext } from "../browserd/electron/electron-context";
import {
  WEBMCP_BROWSER_PARTITION,
  WEBMCP_RESULT_CAP_BYTES,
} from "@/shared/webmcp-inspector-protocol";
/** WebMCP inspection over the same in-process daemon used by Playground. */
import { randomUUID } from "node:crypto";
import type { BrowserPaneCommand } from "@/shared/browser-pane-command";
import { toBrowserPaneInput } from "@/shared/webmcp-input";
import type {
  WebMcpInputEvent,
  WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import { ChromiumDriver } from "../browserd/daemon/chromium-driver";
import { launchBrowserdContext } from "../browserd/daemon/chromium-launch";
import {
  buildBrowserdStack,
  type BrowserdStack,
} from "../browserd/daemon/server";
import {
  createInProcessBrowserdClient,
  type InProcessPaneClient,
} from "../browserd/in-process-client";
import { BrowserdWebMcpSession } from "./browserd-provider";
import { buildWebMcpLaunchArgs, webMcpHeadlessRequested } from "./launch-args";
import {
  WebMcpNoDisplayError,
  WebMcpChromiumNotInstalledError,
  type CreateWebMcpSessionOptions,
  type WebMcpBrowserProvider,
} from "./provider";
import { ensureLocalChromiumInstalled } from "../../utils/browser-rendering-setup";

export class LocalBrowserdWebMcpSession extends BrowserdWebMcpSession {
  private unsubscribe?: () => void;
  private streamTab?: string;
  private streamUrl?: string;
  private streamRequest = 0;
  private streaming = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval>;
  private refreshing = false;
  private localDisposed = false;
  constructor(
    private readonly stack: BrowserdStack,
    private readonly client: InProcessPaneClient,
    private readonly driver: ChromiumDriver,
    options: CreateWebMcpSessionOptions,
    private readonly headless: boolean,
    private readonly nativeSurface?: ContextSurface,
  ) {
    super({ bootId: stack.bootId }, client, options, { pollMs: 0 });
    this.timer = setInterval(() => {
      if (this.refreshing || this.localDisposed) return;
      this.refreshing = true;
      void this.driver
        .health()
        .then(async (health) => {
          if (this.localDisposed) return;
          if (!health.ok) {
            clearInterval(this.timer);
            this.options.callbacks.onCrashed(
              health.detail ?? "The browser disconnected.",
            );
            return;
          }
          await this.refreshTools();
          await this.syncStream();
        })
        .catch(() => {})
        .finally(() => {
          this.refreshing = false;
        });
    }, 500);
    this.timer.unref?.();
  }
  browserState() {
    return this.client.paneState({});
  }
  async browserCommand(command: BrowserPaneCommand): Promise<void> {
    if (this.options.viewportMode !== "embedded")
      throw new Error("Use the browser window to navigate this session.");
    const result = await this.client.paneCommand({
      holder: "webmcp-inspector",
      command,
    });
    if (!result.ok)
      throw new Error(
        result.reason === "failed"
          ? (result.detail ?? "Browser command failed")
          : result.reason,
      );
    await this.refreshTools();
    await this.syncStream();
    this.options.callbacks.onActivityObserved();
  }
  viewportTransport(): WebMcpViewportTransport {
    if (this.nativeSurface)
      return { kind: "electron-native", bootId: this.stack.bootId };
    if (this.options.viewportMode === "embedded") {
      const { width, height } = this.driver.sessionViewportState();
      return { kind: "frame-stream", width, height };
    }
    return { kind: this.headless ? "headless" : "native-window" };
  }
  async setScreencast(enabled: boolean): Promise<boolean> {
    if (this.nativeSurface) return false;
    this.streaming = enabled;
    await this.syncStream();
    return enabled && !!this.unsubscribe;
  }
  private async syncStream(): Promise<void> {
    const request = ++this.streamRequest;
    const state = await this.browserState();
    if (request !== this.streamRequest) return;
    const tabId = this.streaming
      ? (state?.activeTabId ?? undefined)
      : undefined;
    const url = state?.tabs.find((tab) => tab.id === tabId)?.url;
    if (tabId === this.streamTab && url === this.streamUrl) return;
    this.streamUrl = url;
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.streamTab = tabId;
    if (!tabId) return;
    const subscription = await this.stack.handler.subscribeFrames({
      tabId,
      listener: (frame) => {
        if (generation !== this.generation) return;
        this.options.callbacks.onFrame(frame);
      },
    });
    if (!subscription.ok) {
      this.streamTab = undefined;
      return;
    }
    if (generation !== this.generation) {
      subscription.unsubscribe();
      return;
    }
    this.unsubscribe = subscription.unsubscribe;
  }
  async resizeViewport(width: number, height: number): Promise<void> {
    await this.client.paneViewport({ width, height, policy: "followPane" });
  }
  async dispatchInput(
    events: WebMcpInputEvent[],
    tabId?: string,
  ): Promise<void> {
    if (this.options.viewportMode !== "embedded") return;
    const state = await this.browserState();
    if (!state?.activeTabId) return;
    if (tabId && tabId !== state.activeTabId) {
      events = events.filter(
        (event) => event.kind === "key_up" || event.kind === "mouse_up",
      );
      if (!events.length) return;
    }
    const result = await this.stack.handler.dispatchInput({
      holder: "webmcp-inspector",
      tabId: tabId ?? state.activeTabId,
      events: events.map(toBrowserPaneInput),
    });
    if (!result.ok) throw new Error(result.error);
    this.options.callbacks.onActivityObserved();
  }
  async dispose(): Promise<void> {
    if (this.localDisposed) return;
    this.localDisposed = true;
    clearInterval(this.timer);
    this.streaming = false;
    ++this.generation;
    ++this.streamRequest;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await super.dispose();
    forgetContextSurface(this.stack.bootId);
    await this.driver.close();
  }
}

export const localBrowserdWebMcpProvider: WebMcpBrowserProvider = {
  async createSession(options) {
    const headless =
      options.viewportMode === "embedded" ||
      (options.headless ?? webMcpHeadlessRequested());
    const native =
      process.env.ELECTRON_APP === "true" &&
      options.viewportMode === "embedded";
    if (!native) await ensureLocalChromiumInstalled();
    let driver: ChromiumDriver | undefined;
    const surface = native
      ? createContextSurface({
          authority: "shared",
          onViewportRequest: (size) => {
            void driver?.requestViewport(size);
          },
        })
      : undefined;
    let context;
    try {
      context = native
        ? await launchElectronContext({
            partition: WEBMCP_BROWSER_PARTITION,
            nativeSurface: true,
            surface,
          })
        : await launchBrowserdContext({
            userDataDir: "",
            contextMode: "ephemeral",
            headless,
            channel: "chromium",
            extraArgs: buildWebMcpLaunchArgs(),
            deviceScaleFactor: options.devicePixelRatio ?? 1,
          });
    } catch (error) {
      if (/Executable.*doesn.t exist/i.test(String(error)))
        throw new WebMcpChromiumNotInstalledError(
          "Chromium is not installed. Run npx playwright install chromium and retry.",
        );
      if (/XServer|Missing X server|DISPLAY/i.test(String(error)))
        throw new WebMcpNoDisplayError(
          "No display is available. Use the embedded browser or set MCPJAM_WEBMCP_HEADLESS=true.",
        );
      throw error;
    }
    driver = new ChromiumDriver(context, {
      webmcpOutputBytes: WEBMCP_RESULT_CAP_BYTES,
      onPopupOpened: options.callbacks.onPopupOpened,
      onTabLimit: () =>
        options.callbacks.onSessionNotice?.(
          "Tab limit reached. Close a tab before opening another.",
        ),
      onExternalInvocation: (tabId, name) =>
        options.callbacks.onExternalInvocation(
          `A page tool ran in tab ${tabId}.`,
          name,
        ),
      viewport: {
        policy: options.viewportMode === "embedded" ? "followPane" : "fixed",
        allowPaneResize: options.viewportMode === "embedded",
        onChange: (viewport) => surface?.setViewport(viewport),
      },
    });
    const token = randomUUID();
    const stack = buildBrowserdStack(driver, { token, authority: "shared" });
    if (surface) registerContextSurface(stack.bootId, surface);
    const client = createInProcessBrowserdClient(stack, token);
    const session = new LocalBrowserdWebMcpSession(
      stack,
      client,
      driver,
      options,
      headless,
      surface,
    );
    try {
      await session.navigate(options.url);
      if (options.viewportMode === "embedded")
        await session.setScreencast(true);
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  },
};
