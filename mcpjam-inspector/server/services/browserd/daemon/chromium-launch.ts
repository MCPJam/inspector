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

const NAV_TIMEOUT_MS = 30_000;

/** A structural skeleton of the DOM — cheap, and changes when structure does. */
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
};

export function wrapPage(page: AnyPage): DriverPage {
  return {
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
          "() => new Promise((r) => requestAnimationFrame(() => r()))",
        ),
        abortPromise(signal),
      ]);
    },
    domStructureSignal() {
      return page.evaluate<string>(DOM_SIGNAL_FN);
    },
    async screenshotBase64() {
      const buffer = await page.screenshot({ type: "png" });
      return buffer.toString("base64");
    },
    url: () => page.url(),
    close: () => page.close(),
    isClosed: () => page.isClosed(),
  };
}

export interface LaunchBrowserdContextOptions {
  /** Persistent profile directory — the singleton whose lock L8 clears. */
  userDataDir: string;
  /** Headed under Xfce in the sandbox; tests may force headless. */
  headless?: boolean;
  /** Extra args, e.g. `--window-size` matched to the X screen geometry. */
  extraArgs?: readonly string[];
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
  await clearStaleSingletonLock(options.userDataDir);
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(options.userDataDir, {
    headless: options.headless ?? false,
    chromiumSandbox: process.getuid?.() !== 0,
    args: buildBrowserdLaunchArgs(options.extraArgs),
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
};

/**
 * Adapt a persistent Playwright context to `DriverContext`. A persistent context
 * opens with a startup page (about:blank on a fresh profile, restored tabs
 * otherwise); adopt those first so the FIRST driver tab IS the startup page.
 * Otherwise `newPage()` would create a second page and leave the startup tab
 * visible and permanently outside the driver's tab map, where a headed user could
 * focus it while observations ran against a different tab (P2).
 */
export function adaptContext(context: AnyContext): DriverContext {
  const startup = [...context.pages()];
  let adopted = 0;
  return {
    async newPage() {
      const page =
        adopted < startup.length ? startup[adopted++] : await context.newPage();
      return wrapPage(page);
    },
    isConnected() {
      return context.browser()?.isConnected() ?? true;
    },
    close() {
      return context.close();
    },
  };
}
