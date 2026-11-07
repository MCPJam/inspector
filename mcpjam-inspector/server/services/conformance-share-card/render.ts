/**
 * Draws the conformance share card as a PNG on the server, for the og:image of
 * a shared run's link: a headless Chromium screenshot of the card's SVG, the
 * same markup the share dialog shows and saves.
 *
 * No dependency of its own. The hosted image already installs Chromium for
 * widget rendering (the Dockerfile's "Bake in Chromium" step, and
 * `mcp-app-browser-harness.ts`), through the `playwright` package we ship.
 * Where Chromium is not installed (npx and desktop installs, which a crawler
 * cannot reach anyway) there is no card: this returns null and the link
 * unfurls with its title alone. It never installs Chromium: a public route
 * must not start a download.
 *
 * The page runs no JavaScript and every request it makes is aborted: the SVG
 * carries its fonts and wordmark inline, and nothing else may load.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Browser } from "playwright";
import {
  SHARE_CARD_FONT_FACES,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildConformanceShareCardSvg,
  shareCardFontFaceCss,
  type ConformanceShareCardData,
} from "@/shared/conformance-share-card";
import { isChromiumInstalled } from "../../utils/browser-rendering-setup.js";

const RENDER_TIMEOUT_MS = 15_000;
/** Cards are drawn rarely (each is cached), so the browser does not linger. */
const BROWSER_IDLE_MS = 5 * 60_000;

let fontFaceCssPromise: Promise<string> | null = null;
let browserPromise: Promise<Browser | null> | null = null;
let activeRenders = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** The card's faces, inlined from their `@fontsource` packages. Read once. */
function loadFontFaceCss(): Promise<string> {
  fontFaceCssPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const inlined = new Map<string, string>();
    for (const { file } of SHARE_CARD_FONT_FACES) {
      const bytes = await readFile(require.resolve(file));
      inlined.set(file, `data:font/woff2;base64,${bytes.toString("base64")}`);
    }
    return shareCardFontFaceCss((file) => inlined.get(file) ?? "");
  })().catch((error: unknown) => {
    // A failed read must not stick: the next request tries again.
    fontFaceCssPromise = null;
    throw error;
  });
  return fontFaceCssPromise;
}

// Same resolution as the widget harness: the runtime `playwright` package,
// else `playwright-core` (present transitively).
async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    return (await import("playwright-core")).chromium;
  }
}

/** One browser for the process, launched on demand; null without Chromium. */
function getBrowser(): Promise<Browser | null> {
  if (browserPromise) return browserPromise;
  const launching = (async () => {
    if (!(await isChromiumInstalled())) return null;
    const chromium = await loadChromium();
    // The same flags the widget harness launches with: containers run as
    // root and have a small /dev/shm.
    return chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  })();
  browserPromise = launching;
  // Forget this browser when it goes away, but only if it is still the
  // current one: a closed browser must not drop its replacement.
  const forget = () => {
    if (browserPromise === launching) browserPromise = null;
  };
  launching.then((browser) => browser?.on("disconnected", forget), forget);
  return launching;
}

/** The card as a 1200 × 630 PNG, or null where there is no Chromium to draw it. */
export async function renderConformanceShareCardPng(
  data: ConformanceShareCardData,
): Promise<Uint8Array | null> {
  activeRenders += 1;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  try {
    const browser = await getBrowser();
    if (!browser) return null;
    const svg = buildConformanceShareCardSvg(data, {
      fontFaceCss: await loadFontFaceCss(),
    });
    const context = await browser.newContext({
      viewport: { width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT },
      javaScriptEnabled: false,
    });
    try {
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><body style="margin:0;background:#000">${svg}</body>`,
        { timeout: RENDER_TIMEOUT_MS },
      );
      return await page.screenshot({ type: "png", timeout: RENDER_TIMEOUT_MS });
    } finally {
      await context.close();
    }
  } finally {
    activeRenders -= 1;
    if (activeRenders === 0) {
      idleTimer = setTimeout(
        () => void closeShareCardBrowser(),
        BROWSER_IDLE_MS,
      );
      idleTimer.unref?.();
    }
  }
}

/** Closes the browser this module launched, if any (idle, and tests). */
export async function closeShareCardBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  let browser: Browser | null;
  try {
    browser = await pending;
  } catch {
    // The launch failed, and that render already reported it: nothing to close.
    return;
  }
  await browser?.close();
}
