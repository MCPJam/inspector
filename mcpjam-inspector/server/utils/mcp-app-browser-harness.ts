/**
 * mcp-app-browser-harness.ts — headless-Chromium host harness for MCP App evals.
 *
 * Browser-rendered MCP App eval PR 3. Mounts a widget's UI resource in a real
 * (headless Playwright) browser running the production host bridge (PR 1, via
 * the esbuild-bundled `host-page.ts`) so the eval can answer two questions an
 * inert HTML snapshot never could:
 *
 *   1. Renderability — did the widget actually mount + handshake + paint?
 *      (`renderWidget` → {@link WidgetRenderObservation}).
 *   2. User-mimicry — can a driver click/type and observe the next state, with
 *      widget-initiated `tools/call` captured? (`executeAction`).
 *
 * Lifecycle: one harness per eval iteration. Construction is cheap; Chromium is
 * launched lazily on the first `renderWidget` so prompt-only / server-tool-only
 * iterations pay zero browser cost. If Chromium is not installed the harness
 * throws {@link ChromiumNotInstalledError}; the eval runner catches it, records
 * `browser_unavailable`, and falls back to the HTML snapshot path.
 *
 * Isolation: each harness uses a fresh `BrowserContext` (no shared cookies /
 * storage), downloads off, no granted permissions, a one-tab limit, and a
 * default-deny network route with a small allowlist.
 */

import { existsSync } from "fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { HARNESS_PAGE_BUNDLE } from "./browser-harness/HarnessPageBundle.generated";

/* ------------------------------------------------------------------ *
 * Contract types
 * ------------------------------------------------------------------ */

export type WidgetRenderStatus =
  | "rendered"
  | "no_ui_resource"
  | "resource_read_failed"
  | "mount_failed"
  | "bridge_timeout"
  | "render_error"
  | "blank_screenshot"
  | "screenshot_failed"
  | "browser_unavailable";

export interface WidgetRenderObservation {
  toolCallId: string;
  toolName: string;
  serverId: string;
  status: WidgetRenderStatus;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  /** Raw screenshot bytes (base64 PNG/JPEG). PR 6 uploads this to a blob. */
  screenshotBase64?: string;
  consoleErrors?: string[];
  blockedRequests?: string[];
  elapsedMs: number;
  ts: number;
}

/** A Computer Use action subset the harness can apply via Playwright. */
export interface BrowserActionSpec {
  action:
    | "screenshot"
    | "left_click"
    | "double_click"
    | "right_click"
    | "mouse_move"
    | "type"
    | "key"
    | "scroll"
    | "wait";
  coordinate?: [number, number];
  text?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
}

export interface WidgetToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  elapsedMs: number;
}

export interface BrowserActionResult {
  action: BrowserActionSpec;
  /** base64 screenshot after the action settled (within the byte budget). */
  screenshotBase64?: string;
  widgetToolCalls: WidgetToolCall[];
  elapsedMs: number;
  /** Set when a budget/limit forced a no-op (e.g. "budget_exceeded"). */
  note?: string;
}

export interface HarnessBudgets {
  /** Per-rendered-widget cap on `executeAction` calls before forced dismiss. */
  maxBrowserStepsPerWidget: number;
  /** Hard cap on a screenshot's bytes; re-encoded as lower-quality JPEG if over. */
  screenshotMaxBytes: number;
  /** After each action, wait min(network idle, this) + 50ms before screenshot. */
  settleTimeoutMs: number;
  /** During render, wait this long for iframe load + bridge init. */
  renderTimeoutMs: number;
  /** Circuit breaker: total screenshots per iteration. */
  totalScreenshotsPerIteration: number;
}

export const DEFAULT_HARNESS_BUDGETS: HarnessBudgets = {
  maxBrowserStepsPerWidget: 12,
  screenshotMaxBytes: 256 * 1024,
  settleTimeoutMs: 2000,
  renderTimeoutMs: 3000,
  totalScreenshotsPerIteration: 60,
};

/** Fixed viewport at 1x CSS pixels — the model's coordinate space == screenshot
 *  pixel space. deviceScaleFactor MUST stay 1 (HiDPI scaling is the #1 cause of
 *  off-by-N click misses with Computer Use). */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export class ChromiumNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromiumNotInstalledError";
  }
}

export interface RenderWidgetInput {
  toolCallId: string;
  toolName: string;
  serverId: string;
  /** Widget resource HTML (OpenAI-compat injected upstream if required). */
  html: string;
  resourceUri?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  /** SEP-1865 sandbox inputs forwarded to the in-page policy resolver. */
  permissions?: Record<string, unknown>;
  sandboxAttrs?: string[];
  allowFeatures?: Record<string, string>;
  /** Keep the widget mounted for subsequent executeAction calls. */
  keepMounted?: boolean;
}

export interface McpAppBrowserHarnessOptions {
  /** Dispatch a widget-initiated tools/call (app->host). */
  callTool: (
    serverId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Host capabilities advertised in ui/initialize. Sensible default below. */
  hostCapabilities?: Record<string, unknown>;
  hostInfo?: { name: string; version: string };
  viewport?: { width: number; height: number };
  budgets?: Partial<HarnessBudgets>;
  /** Extra http(s) origins to allow through the default-deny network route. */
  allowOrigins?: string[];
}

// SEP-1865 host capabilities are declared as OBJECTS (an empty `{}` means
// "supported"), not booleans — the guest's ui/initialize schema rejects
// booleans. Empty objects are still truthy, so the capability gating in
// `registerHostBridgeHandlers` (which checks `caps.message` etc.) is unaffected.
const DEFAULT_HOST_CAPABILITIES = {
  message: {},
  openLinks: {},
  serverTools: {},
  serverResources: {},
  logging: {},
  updateModelContext: {},
  downloadFile: {},
} as const;

interface MountedWidget {
  serverId: string;
  actionCount: number;
}

export class McpAppBrowserHarness {
  private readonly opts: McpAppBrowserHarnessOptions;
  private readonly budgets: HarnessBudgets;
  private readonly viewport: { width: number; height: number };

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private readonly mounted = new Map<string, MountedWidget>();
  private consoleErrors: string[] = [];
  private blockedRequests: string[] = [];
  private toolCallBuffer: WidgetToolCall[] = [];
  private screenshotCount = 0;

  constructor(opts: McpAppBrowserHarnessOptions) {
    this.opts = opts;
    this.budgets = { ...DEFAULT_HARNESS_BUDGETS, ...(opts.budgets ?? {}) };
    this.viewport = opts.viewport ?? { ...DEFAULT_VIEWPORT };
  }

  hasRenderedWidget(): boolean {
    return this.mounted.size > 0;
  }

  /* ---- launch ---- */

  // Overridable for tests (force the binary-missing path without uninstalling
  // Chromium). Prefer the runtime `playwright` package; fall back to
  // `playwright-core` (present transitively).
  protected async loadChromium(): Promise<{
    executablePath: () => string;
    launch: (opts: {
      headless: boolean;
      args?: string[];
    }) => Promise<Browser>;
  }> {
    try {
      return (await import("playwright")).chromium;
    } catch {
      return (await import("playwright-core")).chromium;
    }
  }

  private async ensureLaunched(): Promise<void> {
    if (this.page) return;
    const chromium = await this.loadChromium();

    let executablePath: string | undefined;
    try {
      executablePath = chromium.executablePath();
    } catch {
      executablePath = undefined;
    }
    if (!executablePath || !existsSync(executablePath)) {
      throw new ChromiumNotInstalledError(
        "Chromium is not installed for Playwright. Run `npx playwright install chromium`.",
      );
    }

    try {
      // `--no-sandbox` is required when running as root (CI / containers);
      // `--disable-dev-shm-usage` avoids /dev/shm exhaustion crashes there.
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|please run|install/i.test(msg)) {
        throw new ChromiumNotInstalledError(msg);
      }
      throw err;
    }

    // Fresh, locked-down context per iteration.
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      permissions: [],
    });

    // Default-deny network with a small allowlist (loopback + configured
    // origins). Non-network schemes (data:, blob:, about:) pass through.
    const allowOrigins = new Set(this.opts.allowOrigins ?? []);
    await this.context.route("**/*", (route) => {
      const url = route.request().url();
      if (
        url.startsWith("data:") ||
        url.startsWith("blob:") ||
        url.startsWith("about:")
      ) {
        return route.continue();
      }
      try {
        const origin = new URL(url).origin;
        const host = new URL(url).hostname;
        const isLoopback =
          host === "127.0.0.1" || host === "localhost" || host === "[::1]";
        if (isLoopback || allowOrigins.has(origin)) return route.continue();
      } catch {
        /* fall through to abort */
      }
      this.blockedRequests.push(url);
      return route.abort();
    });

    this.page = await this.context.newPage();
    this.page.on("console", (msg) => {
      if (msg.type() === "error") this.consoleErrors.push(msg.text());
    });
    this.page.on("pageerror", (err) => this.consoleErrors.push(String(err)));

    // One-tab limit: a widget must not pop a tab the model can't see. Attached
    // AFTER the main page exists so the main page's own "page" event (which
    // fires during newPage, before `this.page` is assigned) doesn't close it.
    const mainPage = this.page;
    this.context.on("page", (p) => {
      if (p !== mainPage) void p.close().catch(() => {});
    });

    // app->host tools/call funneled from the in-page bridge.
    await this.page.exposeBinding(
      "__mcpjamHostRpc",
      async (
        _source,
        payload: {
          widgetId: string;
          name: string;
          args: Record<string, unknown>;
        },
      ) => {
        const widget = this.mounted.get(payload.widgetId);
        const serverId = widget?.serverId ?? "";
        const startedAt = Date.now();
        try {
          const result = await this.opts.callTool(
            serverId,
            payload.name,
            payload.args,
          );
          this.toolCallBuffer.push({
            name: payload.name,
            args: payload.args,
            ok: true,
            elapsedMs: Date.now() - startedAt,
          });
          return { result };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.toolCallBuffer.push({
            name: payload.name,
            args: payload.args,
            ok: false,
            error,
            elapsedMs: Date.now() - startedAt,
          });
          return { error };
        }
      },
    );

    await this.page.setContent(
      "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>",
    );
    await this.page.addScriptTag({ content: HARNESS_PAGE_BUNDLE });
  }

  /* ---- render ---- */

  async renderWidget(
    input: RenderWidgetInput,
  ): Promise<WidgetRenderObservation> {
    const ts = Date.now();
    const started = ts;
    const base = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      serverId: input.serverId,
      resourceUri: input.resourceUri,
      ts,
    };

    try {
      await this.ensureLaunched();
    } catch (err) {
      if (err instanceof ChromiumNotInstalledError) {
        return {
          ...base,
          status: "browser_unavailable",
          elapsedMs: Date.now() - started,
        };
      }
      throw err;
    }
    const page = this.page!;

    if (!input.html || input.html.trim().length === 0) {
      return { ...base, status: "no_ui_resource", elapsedMs: Date.now() - started };
    }

    // Capture only this render's console errors + blocked requests (otherwise
    // an observation would attach unrelated diagnostics from earlier widgets in
    // the same iteration).
    this.consoleErrors = [];
    this.blockedRequests = [];
    this.mounted.set(input.toolCallId, {
      serverId: input.serverId,
      actionCount: 0,
    });

    let pageResult: {
      mounted: boolean;
      bridgeInitialized: boolean;
      blank: boolean;
      mountError?: string;
    };
    try {
      pageResult = await page.evaluate(
        (opts) =>
          (
            globalThis as unknown as { __mcpjamHarness: HarnessPageApi }
          ).__mcpjamHarness.renderWidget(opts),
        {
          widgetId: input.toolCallId,
          html: input.html,
          hostCapabilities:
            this.opts.hostCapabilities ?? DEFAULT_HOST_CAPABILITIES,
          hostInfo: this.opts.hostInfo ?? {
            name: "mcpjam-eval-harness",
            version: "1.0.0",
          },
          permissions: input.permissions,
          sandboxAttrs: input.sandboxAttrs,
          allowFeatures: input.allowFeatures,
          toolInput: input.toolInput,
          toolOutput: input.toolOutput,
          renderTimeoutMs: this.budgets.renderTimeoutMs,
        },
      );
    } catch (err) {
      await this.unmount(input.toolCallId);
      return {
        ...base,
        status: "render_error",
        consoleErrors: [...this.consoleErrors],
        elapsedMs: Date.now() - started,
      };
    }

    // app->host calls during render are not part of an action result.
    this.toolCallBuffer = [];

    if (!pageResult.mounted) {
      await this.unmount(input.toolCallId);
      return {
        ...base,
        status: "mount_failed",
        bridgeInitialized: pageResult.bridgeInitialized,
        consoleErrors: [
          ...this.consoleErrors,
          ...(pageResult.mountError ? [pageResult.mountError] : []),
        ],
        elapsedMs: Date.now() - started,
      };
    }

    let screenshotBase64: string | undefined;
    try {
      screenshotBase64 = await this.captureScreenshot();
    } catch {
      // mounted but couldn't screenshot — keep mount state consistent.
      if (!input.keepMounted) await this.unmount(input.toolCallId);
      return {
        ...base,
        status: "screenshot_failed",
        bridgeInitialized: pageResult.bridgeInitialized,
        consoleErrors: [...this.consoleErrors],
        elapsedMs: Date.now() - started,
      };
    }

    let status: WidgetRenderStatus;
    if (!pageResult.bridgeInitialized) status = "bridge_timeout";
    else if (pageResult.blank) status = "blank_screenshot";
    else status = "rendered";

    // Only a fully-rendered widget stays mounted for Computer Use. Any other
    // outcome is torn down IN THE PAGE too (not just removed from `mounted`),
    // so a leftover iframe + host bridge can't keep running and misroute a
    // later widget-initiated tools/call (its serverId would resolve to "").
    if (!(input.keepMounted && status === "rendered")) {
      await this.unmount(input.toolCallId);
    }

    return {
      ...base,
      status,
      bridgeInitialized: pageResult.bridgeInitialized,
      screenshotBase64,
      consoleErrors: this.consoleErrors.length
        ? [...this.consoleErrors]
        : undefined,
      blockedRequests: this.blockedRequests.length
        ? [...this.blockedRequests]
        : undefined,
      elapsedMs: Date.now() - started,
    };
  }

  /* ---- interact ---- */

  async executeAction(input: {
    toolCallId: string;
    action: BrowserActionSpec;
  }): Promise<BrowserActionResult> {
    const started = Date.now();
    const widget = this.mounted.get(input.toolCallId);
    if (!widget || !this.page) {
      return {
        action: input.action,
        widgetToolCalls: [],
        elapsedMs: 0,
        note: "no rendered widget",
      };
    }
    if (
      widget.actionCount >= this.budgets.maxBrowserStepsPerWidget ||
      this.screenshotCount >= this.budgets.totalScreenshotsPerIteration
    ) {
      return {
        action: input.action,
        widgetToolCalls: [],
        elapsedMs: Date.now() - started,
        note: "budget_exceeded",
      };
    }
    widget.actionCount += 1;
    this.toolCallBuffer = [];

    await this.applyAction(input.action);
    await this.settle();

    // The app->host round-trip (postMessage -> host bridge -> exposeBinding ->
    // Node -> back) is async across the CDP boundary, so a fixed settle tail is
    // racy. Debounce-collect until the tool-call buffer is stable (bounded).
    const widgetToolCalls = await this.drainAfterAction();
    let screenshotBase64: string | undefined;
    try {
      screenshotBase64 = await this.captureScreenshot();
    } catch {
      /* leave undefined */
    }

    return {
      action: input.action,
      screenshotBase64,
      widgetToolCalls,
      elapsedMs: Date.now() - started,
    };
  }

  private async applyAction(action: BrowserActionSpec): Promise<void> {
    const page = this.page!;
    const [x, y] = action.coordinate ?? [0, 0];
    switch (action.action) {
      case "left_click":
        await page.mouse.click(x, y);
        break;
      case "double_click":
        await page.mouse.dblclick(x, y);
        break;
      case "right_click":
        await page.mouse.click(x, y, { button: "right" });
        break;
      case "mouse_move":
        await page.mouse.move(x, y);
        break;
      case "type":
        if (action.text) await page.keyboard.type(action.text);
        break;
      case "key":
        if (action.text) await page.keyboard.press(action.text);
        break;
      case "scroll": {
        const amount = (action.scrollAmount ?? 3) * 100;
        const dir = action.scrollDirection ?? "down";
        const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
        const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
        if (action.coordinate) await page.mouse.move(x, y);
        await page.mouse.wheel(dx, dy);
        break;
      }
      case "wait":
        await page.waitForTimeout(
          Math.min(action.duration ?? 250, this.budgets.settleTimeoutMs),
        );
        break;
      case "screenshot":
        break;
    }
  }

  private async settle(): Promise<void> {
    const page = this.page!;
    await page
      .waitForLoadState("networkidle", { timeout: this.budgets.settleTimeoutMs })
      .catch(() => {});
    await page.waitForTimeout(50);
  }

  /** Collect widget tool calls triggered by the action, waiting until the
   *  buffer is stable across one interval (bounded by settleTimeoutMs). */
  private async drainAfterAction(): Promise<WidgetToolCall[]> {
    const page = this.page!;
    const cap = Math.min(this.budgets.settleTimeoutMs, 800);
    const deadline = Date.now() + cap;
    let prev = -1;
    while (Date.now() < deadline) {
      const n = this.toolCallBuffer.length;
      if (n === prev) break;
      prev = n;
      await page.waitForTimeout(60);
    }
    return this.toolCallBuffer.splice(0);
  }

  private async captureScreenshot(): Promise<string> {
    const page = this.page!;
    this.screenshotCount += 1;
    const png = await page.screenshot({ type: "png" });
    if (png.byteLength <= this.budgets.screenshotMaxBytes) {
      return png.toString("base64");
    }
    // Re-encode as progressively lower-quality JPEG to fit the byte budget.
    for (const quality of [70, 50, 35, 20]) {
      const jpeg = await page.screenshot({ type: "jpeg", quality });
      if (jpeg.byteLength <= this.budgets.screenshotMaxBytes) {
        return jpeg.toString("base64");
      }
    }
    // Still over budget: return the smallest attempt.
    const jpeg = await page.screenshot({ type: "jpeg", quality: 20 });
    return jpeg.toString("base64");
  }

  /* ---- teardown ---- */

  async dismissWidget(toolCallId: string): Promise<void> {
    await this.unmount(toolCallId);
  }

  /** Tear the widget down IN THE PAGE (close its host bridge + remove its
   *  iframe) and drop the Node-side mount entry. Best-effort. */
  private async unmount(toolCallId: string): Promise<void> {
    if (this.page) {
      await this.page
        .evaluate(
          (id) =>
            (
              globalThis as unknown as { __mcpjamHarness: HarnessPageApi }
            ).__mcpjamHarness.dismissWidget(id),
          toolCallId,
        )
        .catch(() => {});
    }
    this.mounted.delete(toolCallId);
  }

  async dispose(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.browser = null;
    this.page = null;
    this.mounted.clear();
  }
}

// Shape of the in-page harness API (defined in host-page.ts, installed on the
// page's global after the bundle is injected). Referenced via a `globalThis`
// cast inside `page.evaluate` callbacks — those run in the browser, where
// `globalThis === window`, but are typechecked here in the Node context.
interface HarnessPageApi {
  renderWidget: (opts: unknown) => Promise<{
    mounted: boolean;
    bridgeInitialized: boolean;
    blank: boolean;
    mountError?: string;
  }>;
  dismissWidget: (widgetId: string) => boolean;
  isBlank: (widgetId: string) => boolean;
}
