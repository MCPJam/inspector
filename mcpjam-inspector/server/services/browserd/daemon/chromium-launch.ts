/**
 * The live Playwright implementation of the driver's browser boundary.
 *
 * This is the ONLY file in the daemon that imports Playwright and knows about
 * CDP-era specifics. It launches ONE persistent browser context (a single
 * profile, many tabs — unlike the local inspector, which launches a fresh
 * browser per single-page session) with browserd's hardened launch args (L4) and
 * determinism pins (L5), clears any stale profile lock first (L8), and wraps each
 * Playwright `Page` into the small `DriverPage` the driver logic is written
 * against. It carries no unit tests of its own — its live behaviour is validated
 * by `__tests__/chromium-launch.spike.test.ts`, which runs only when a real
 * Chromium is present.
 */
import type { DriverContext, DriverPage } from "./browser-page";
import {
  BROWSERD_CONTEXT_OPTIONS,
  buildBrowserdLaunchArgs,
} from "./launch-args";
import { clearStaleSingletonLock } from "./profile-lock";
import { capText, type ConsoleEntry } from "./observation-budget";
import { PAGE_TEXT_FN } from "./page-text";
import { WebMcpBridge, type CdpLike } from "./webmcp-bridge";

/**
 * Evaluated IN THE PAGE to decide whether this browser really supports
 * WebMCP. Duplicated from `webmcp-inspector/launch-args.ts` rather than
 * imported: the daemon is bundled standalone, and pulling in the local
 * inspector's module would drag its Playwright-facing dependencies into the
 * sandbox artifact. The two must agree — both read the documented
 * `document.modelContext`, falling back to the `navigator` alias Chromium 151
 * still carries.
 */
const PAGE_API_PROBE = "!!(document.modelContext ?? navigator.modelContext)";

const NAV_TIMEOUT_MS = 30_000;

/**
 * A structural skeleton of the DOM — cheap, and changes when structure does.
 * NOTE: `page.evaluate(string)` evaluates the string as an EXPRESSION, so this
 * function literal must be wrapped and self-invoked — `(${DOM_SIGNAL_FN})()` —
 * at the call site. A bare `() => {…}` string evaluates to the (uncalled)
 * function, which serializes to `undefined` and breaks every capture. Same for
 * the requestAnimationFrame string below.
 */
const DOM_SIGNAL_FN = `() => {
  const parts = [];
  const walk = (el, depth) => {
    if (depth > 12 || parts.length > 400) return;
    parts.push(depth + el.tagName);
    for (const child of el.children) walk(child, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return parts.join(">");
}`;

/** Reject when the signal aborts, so a settle-timeout unblocks a waiting step. */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

// Playwright's Page is structurally richer than DriverPage needs; type the
// handle loosely and adapt, rather than dragging Playwright's types across the
// boundary.
export type AnyPage = {
  goto(url: string, options?: unknown): Promise<unknown>;
  reload(options?: unknown): Promise<unknown>;
  goBack(options?: unknown): Promise<unknown>;
  waitForLoadState(state: string, options?: unknown): Promise<void>;
  evaluate<R>(fn: string): Promise<R>;
  screenshot(options?: unknown): Promise<Buffer>;
  url(): string;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
  mouse: {
    click(x: number, y: number, options?: unknown): Promise<void>;
    move(x: number, y: number, options?: unknown): Promise<void>;
    down(options?: unknown): Promise<void>;
    up(options?: unknown): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string, options?: unknown): Promise<void>;
    press(key: string, options?: unknown): Promise<void>;
  };
  click(selector: string, options?: unknown): Promise<void>;
  hover(selector: string, options?: unknown): Promise<void>;
  fill(selector: string, value: string, options?: unknown): Promise<void>;
  selectOption(
    selector: string,
    value: string,
    options?: unknown,
  ): Promise<unknown>;
  ariaSnapshot(options?: unknown): Promise<string>;
  locator(selector: string): AnyLocator;
  on(event: string, handler: (payload: any) => void): void;
};

/**
 * The sliver of Playwright's `Locator` the daemon uses: narrow a selector to
 * its first match and take that element's aria snapshot.
 */
export type AnyLocator = {
  first(): AnyLocator;
  ariaSnapshot(options?: unknown): Promise<string>;
};

/**
 * How many console entries a tab keeps. A ring buffer, because console
 * history is a TAIL the model reads after an act — not a document, and not
 * something a chatty page should be able to grow without bound.
 */
const CONSOLE_RING_SIZE = 200;
/** Per-entry cap at CAPTURE time; the observe budget caps again for output. */
const CONSOLE_ENTRY_CAPTURE_BYTES = 4_000;

/** Act timeouts: long enough for a slow page, short enough to stay a turn. */
const ACT_TIMEOUT_MS = 15_000;

/**
 * Accessibility capture timeout. Shorter than an act: an observation that
 * cannot be taken promptly is better answered as "unavailable" than held
 * open, because the caller has a screenshot and a DOM outline to fall back on.
 */
const A11Y_TIMEOUT_MS = 5_000;

/**
 * JPEG quality for model-facing captures. High enough that text stays legible
 * and layout edges stay crisp for coordinate targeting; low enough that a
 * capture on every act does not dominate the turn's token budget.
 */
const SCREENSHOT_JPEG_QUALITY = 70;

export function wrapPage(page: AnyPage): DriverPage {
  // The console ring. Attached once per wrapped page; entries are captured
  // eagerly because a console message is gone the moment it is emitted.
  const consoleRing: ConsoleEntry[] = [];
  page.on("console", (message: { type?: () => string; text?: () => string }) => {
    try {
      const text = message.text?.() ?? "";
      consoleRing.push({
        type: message.type?.() ?? "log",
        text: capText(text, CONSOLE_ENTRY_CAPTURE_BYTES),
        at: Date.now(),
      });
      if (consoleRing.length > CONSOLE_RING_SIZE) consoleRing.shift();
    } catch {
      // A console listener must never take the page down.
    }
  });
  page.on("pageerror", (error: unknown) => {
    consoleRing.push({
      type: "pageerror",
      text: capText(
        error instanceof Error ? error.message : String(error),
        CONSOLE_ENTRY_CAPTURE_BYTES,
      ),
      at: Date.now(),
    });
    if (consoleRing.length > CONSOLE_RING_SIZE) consoleRing.shift();
  });

  // The WebMCP bridge is attached lazily and ONCE: a tab that never invokes a
  // page tool should not pay for a CDP session. It reuses the memoized session
  // below rather than attaching its own — a page serving both a tool call and
  // the pane would otherwise hold two.
  let webmcpPromise: Promise<WebMcpBridge | null> | null = null;
  // The CDP session itself is memoized separately and shared: the WebMCP
  // bridge and the viewport both want one, and attaching twice to the same
  // page gives two sessions whose events interleave unpredictably.
  let cdpPromise: Promise<CdpLike | null> | null = null;

  // Named rather than returned inline so `webmcp()` can reach `cdp()` — one
  // attach, two consumers.
  const adapted: DriverPage = {
    async goto(url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    },
    async reload() {
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    },
    async goBack() {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    },
    async waitForNetworkIdle(signal) {
      // settle's maxWait (via the abort signal) is the SOLE budget — no inner
      // timeout. A page that never idles stays pending until the signal aborts,
      // and then this rejects, so `settlePage` reports `settled: false`. The
      // earlier version gave the wait its own 8s timeout and swallowed it, which
      // turned a never-quiet page into a false `settled: true` (P1). Guard the
      // losing promise so it does not surface as an unhandled rejection.
      const idle = page.waitForLoadState("networkidle", { timeout: 0 });
      idle.catch(() => {});
      await Promise.race([idle, abortPromise(signal)]);
    },
    async requestAnimationFrame(signal) {
      await Promise.race([
        page.evaluate<void>(
          "(() => new Promise((r) => requestAnimationFrame(() => r())))()",
        ),
        abortPromise(signal),
      ]);
    },
    domStructureSignal() {
      return page.evaluate<string>(`(${DOM_SIGNAL_FN})()`);
    },
    async screenshotBase64() {
      // JPEG, not PNG. Every act and navigate result carries a capture, and a
      // full-viewport PNG of a real page runs 100–400 KB — which becomes tens
      // of thousands of tokens once it reaches the model as image content. At
      // this quality the difference is invisible for reading a page and
      // aiming a click, and roughly an order of magnitude cheaper.
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: SCREENSHOT_JPEG_QUALITY,
      });
      return buffer.toString("base64");
    },
    url: () => page.url(),
    close: () => page.close(),
    isClosed: () => page.isClosed(),
    bringToFront: () => page.bringToFront(),

    // --- act primitives -----------------------------------------------------
    // Coordinates are already in the canonical observation viewport (L5), so
    // no scaling happens here: what the model saw IS what it clicks.
    clickAt: (point, options) =>
      page.mouse.click(point.x, point.y, {
        ...(options?.button ? { button: options.button } : {}),
      }),
    clickSelector: (selector) => page.click(selector, { timeout: ACT_TIMEOUT_MS }),
    hoverAt: (point) => page.mouse.move(point.x, point.y),
    hoverSelector: (selector) => page.hover(selector, { timeout: ACT_TIMEOUT_MS }),
    typeText: (text) => page.keyboard.type(text),
    fillSelector: (selector, text) =>
      page.fill(selector, text, { timeout: ACT_TIMEOUT_MS }),
    press: (key) => page.keyboard.press(key),
    scrollBy: ({ dx, dy }) => page.mouse.wheel(dx, dy),
    async dragTo(from, to) {
      // Explicit down/move/up rather than `dragAndDrop`: HTML5 drag handlers
      // and canvas apps both need the intermediate move to fire, and a single
      // jump often lands as a click.
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
      await page.mouse.move(to.x, to.y);
      await page.mouse.up();
    },
    async selectOption(selector, value) {
      await page.selectOption(selector, value, { timeout: ACT_TIMEOUT_MS });
    },

    // --- observation --------------------------------------------------------
    async pageText() {
      // Degrades rather than throwing, like every other read on this page: a
      // navigation mid-read destroys the execution context and rejects, and a
      // whole failed observation teaches the model less than an empty one it
      // can retry.
      try {
        const text = await page.evaluate<string>(`(${PAGE_TEXT_FN})()`);
        return typeof text === "string" ? text : "";
      } catch {
        return "";
      }
    },
    consoleEntries: () => consoleRing,
    dropConsoleSince: (since: number) => {
      // Walk from the end: the ring is chronological, so the tail is the
      // window to drop.
      let keep = consoleRing.length;
      while (keep > 0 && consoleRing[keep - 1].at >= since) keep -= 1;
      consoleRing.length = keep;
    },
    webmcp() {
      webmcpPromise ??= (async () => {
        // Through the memoized session, so the bridge and the viewport share
        // ONE attach. Two sessions on a page is two of everything the CDP
        // domains keep per session, for one page's worth of truth.
        const session = await adapted.cdp();
        return session ? attachWebMcp(page, session) : null;
      })();
      return webmcpPromise;
    },
    cdp() {
      cdpPromise ??= (async () => {
        const attach = cdpAttachers.get(page);
        if (!attach) return null;
        return attach().catch(() => null);
      })();
      return cdpPromise;
    },
  };
  return adapted;
}

/**
 * Attach a WebMCP bridge to a page over the session its adapter already holds.
 * Returns null when this browser cannot speak the domain at all — a page with
 * no WebMCP tools is the normal case, not a failure, so nothing here throws.
 *
 * The session is passed IN rather than attached here: the page adapter
 * memoizes one, and a bridge that opened its own would give a page serving
 * both a tool call and the pane two sessions.
 */
async function attachWebMcp(
  page: AnyPage,
  session: CdpLike,
): Promise<WebMcpBridge | null> {
  try {
    const bridge = new WebMcpBridge(session);
    await bridge.start(async () => {
      // `WebMCP.enable` resolves even where the feature is off — the page API
      // is the only honest probe (same reasoning as the local inspector's).
      const supported = await page
        .evaluate<boolean>(`(() => ${PAGE_API_PROBE})()`)
        .catch(() => false);
      return supported === true;
    });
    return bridge;
  } catch {
    return null;
  }
}

/**
 * How a wrapped page opens a CDP session. Populated by `adaptContext` (which
 * holds the BrowserContext); a page wrapped without one — every unit test —
 * simply has no WebMCP, which is exactly the "page offers no tools" path.
 */
const cdpAttachers = new WeakMap<AnyPage, () => Promise<CdpLike>>();

/** Record how a page opens its CDP session (called by `adaptContext`). */
export function registerCdpAttacher(
  page: AnyPage,
  attach: () => Promise<CdpLike>,
): void {
  cdpAttachers.set(page, attach);
}

export interface LaunchBrowserdContextOptions {
  /** Persistent profile directory — the singleton whose lock L8 clears. */
  userDataDir: string;
  /** Headed under Xfce in the sandbox; tests may force headless. */
  headless?: boolean;
  /** Extra args, e.g. `--window-size` matched to the X screen geometry. */
  extraArgs?: readonly string[];
  /**
   * `persistent` (default) keeps one profile across boots — what a
   * playground login depends on. `ephemeral` launches a throwaway browser
   * with a fresh context and NO profile dir, so an eval iteration can never
   * inherit the previous one's cookies.
   */
  contextMode?: "persistent" | "ephemeral";
  /**
   * Which Chromium build to launch.
   *
   * Unset means Playwright's own default, which is what the hosted desktop
   * wants (headed under Xfce, from the template's install). The local engine
   * passes `"chromium"` deliberately: without a channel, `headless: true`
   * resolves to the `chromium-headless-shell` binary — the OLD headless, a
   * different executable with a different compositor path and a fingerprint
   * public sites recognise. "No window" must not mean "a browser sites
   * refuse", so the local engine runs the same full build a headed launch
   * would and merely declines to show it.
   */
  channel?: string;
  /**
   * An explicit Chromium binary.
   *
   * For environments that ship one at a path Playwright's resolver does not
   * know (a prebuilt CI image). Production never sets it — a user's machine
   * has the browser Playwright installed, and pinning a path here would make
   * the engine depend on a filesystem layout we do not control.
   */
  executablePath?: string;
}

/**
 * Launch the persistent browser context and adapt it to `DriverContext`. Clears
 * a stale singleton lock first so a relaunch-on-wake never hands off to a dead
 * instance (L8). Chromium cannot start its renderer sandbox as uid 0 (the image
 * builds as root), so the sandbox is disabled only in that case.
 */
export async function launchBrowserdContext(
  options: LaunchBrowserdContextOptions,
): Promise<DriverContext> {
  const { chromium } = await import("playwright");
  const launchArgs = {
    headless: options.headless ?? false,
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.executablePath
      ? { executablePath: options.executablePath }
      : {}),
    // Chromium cannot start its renderer sandbox as uid 0 (the image builds
    // as root), so it is disabled only in that case.
    chromiumSandbox: process.getuid?.() !== 0,
    args: buildBrowserdLaunchArgs(options.extraArgs),
  };

  if (options.contextMode === "ephemeral") {
    // No user-data-dir at all: an eval's isolation must be a property of the
    // BROWSER, not of remembering to clear cookies. Nothing persists, so
    // there is no singleton lock to clear either (L8 is about the shared
    // profile directory, which does not exist here).
    const browser = await chromium.launch(launchArgs);
    let context;
    try {
      context = await browser.newContext({
        acceptDownloads: false,
        permissions: [],
        ...BROWSERD_CONTEXT_OPTIONS,
      });
    } catch (error) {
      // Ownership of the browser transfers to `adaptContext` below. If we
      // never get there, nothing else will ever close it, and a stranded
      // Chromium keeps running inside the box until the sandbox dies.
      await browser.close().catch(() => {});
      throw error;
    }
    return adaptContext(context as unknown as AnyContext, {
      // The browser outlives the context, so closing the context alone would
      // leave a Chromium process behind in the box.
      onClose: () => browser.close(),
    });
  }

  const cleared = await clearStaleSingletonLock(options.userDataDir);
  if (cleared.heldBy) {
    // Somebody took the profile between the session layer's check and this
    // launch. Refusing here beats Chromium's own message, and beats removing a
    // live owner's lock to make room for ourselves.
    throw new Error(
      `profile_in_use: another browser (pid ${cleared.heldBy.pid ?? "unknown"}` +
        `${cleared.heldBy.host ? ` on ${cleared.heldBy.host}` : ""}) holds ` +
        "this profile; close it and try again",
    );
  }
  const context = await chromium.launchPersistentContext(options.userDataDir, {
    ...launchArgs,
    acceptDownloads: false,
    permissions: [],
    ...BROWSERD_CONTEXT_OPTIONS,
  });
  return adaptContext(context as unknown as AnyContext);
}

/** The subset of a Playwright BrowserContext the adapter uses. */
export type AnyContext = {
  newPage(): Promise<AnyPage>;
  pages(): AnyPage[];
  browser(): { isConnected(): boolean } | null;
  close(): Promise<void>;
  /** Present on a real Playwright context; absent in unit-test fakes. */
  newCDPSession?(page: AnyPage): Promise<CdpLike>;
};

/**
 * Adapt a persistent Playwright context to `DriverContext`. A persistent context
 * opens with a startup page (about:blank on a fresh profile, restored tabs
 * otherwise); adopt those first so the FIRST driver tab IS the startup page.
 * Otherwise `newPage()` would create a second page and leave the startup tab
 * visible and permanently outside the driver's tab map, where a headed user could
 * focus it while observations ran against a different tab (P2).
 */
export function adaptContext(
  context: AnyContext,
  options: { onClose?: () => Promise<unknown> } = {},
): DriverContext {
  const startup = [...context.pages()];
  let adopted = 0;
  return {
    async newPage() {
      const page =
        adopted < startup.length ? startup[adopted++] : await context.newPage();
      // Register how this page opens a CDP session BEFORE wrapping, so the
      // wrapper's lazy `webmcp()` can find it. A context without
      // `newCDPSession` (test fakes) simply yields no WebMCP.
      if (context.newCDPSession) {
        registerCdpAttacher(page, () => context.newCDPSession!(page));
      }
      return wrapPage(page);
    },
    isConnected() {
      return context.browser()?.isConnected() ?? true;
    },
    async close() {
      // Ephemeral mode owns a Browser above the context, and closing only the
      // context would strand its process inside the box — so the browser close
      // runs even when the context close fails, which is exactly the case
      // where something is already wrong.
      try {
        await context.close();
      } finally {
        await options.onClose?.();
      }
    },
  };
}
