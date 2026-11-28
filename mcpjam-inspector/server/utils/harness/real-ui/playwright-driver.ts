/**
 * The Playwright driver: a page in a browser this process launched (the local
 * engine, the tracer kit and tests).
 *
 * The signed-in profile may only open the vendor's sites and MCPJam's sign-in
 * page: a top-level navigation anywhere else is aborted, and `navigate`
 * refuses it before trying. Subresources load as the site asks, since the
 * vendor's own pages pull scripts and frames from elsewhere.
 *
 * The driver's page is the only page in its context. A popup or a new tab
 * could open any site on the account's cookies, so another page is closed as
 * it opens, and the context's routes refuse its requests until it is gone.
 *
 * Playwright routes only the first request of a redirect chain, so each
 * document request of the main frame, every hop of a chain included, is also
 * paused over CDP and failed before it is sent when it leaves the sites. That
 * is why the driver runs only in Chromium. If the page lands off the sites
 * anyway, it goes to a blank page and the driver refuses every command until
 * a `navigate` lands back on one of them.
 */
import type { Frame, Page, Request } from "playwright";
import {
  PageDriverError,
  assertOnSites,
  pollUntil,
  urlOnSites,
  type PageDriver,
} from "./page-driver.js";
import { logger } from "../../logger.js";

const ACTION_TIMEOUT_MS = 15_000;
/** How long a control may take to render after the action that opens it. */
const APPEAR_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 2_000;
const VANISHED = /TimeoutError|Execution context was destroyed|frame was detached/;

/**
 * The frame a request comes from. Playwright has none for a service worker's
 * request, or for a navigation sent before its frame exists, such as a
 * popup's first one; its `frame()` throws for those.
 */
function frameOf(request: Request): Frame | undefined {
  if (request.serviceWorker()) return undefined;
  try {
    return request.frame();
  } catch {
    return undefined;
  }
}

export async function createPlaywrightDriver(
  page: Page,
  options: { sites: readonly string[] },
): Promise<PageDriver> {
  const sites = options.sites;
  const context = page.context();
  if (context.browser()?.browserType().name() !== "chromium") {
    throw new PageDriverError(
      "unsupported",
      "The driver runs only in Chromium, which can stop a redirect before it leaves the vendor's sites.",
    );
  }
  // A page handed over already off its sites is refused from the start, as
  // if it had just left them, so nothing reads it before a navigate lands.
  const current = page.url();
  let leftFor =
    current === "about:blank" || urlOnSites(current, sites)
      ? undefined
      : new URL(current).origin;
  let departures = 0;
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const landed = frame.url();
    // A blank page, or the browser's own page for a failed navigation, shows
    // nothing from another site.
    if (landed === "about:blank" || landed.startsWith("chrome-error://") || urlOnSites(landed, sites)) {
      return;
    }
    const origin = new URL(landed).origin;
    leftFor = origin;
    departures += 1;
    void page.goto("about:blank").catch((error: unknown) => {
      // Commands still refuse while the page is off its sites; this only says
      // why it is still showing the other one.
      logger.warn("[web-clients] a page that left its sites did not go blank", {
        origin,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  const stayOnSites = () => {
    if (leftFor) {
      throw new PageDriverError(
        "site_blocked",
        `The page was sent to ${leftFor}, outside the sites this browser may open.`,
      );
    }
  };
  // Only a document committed on one of the sites lifts the block, so a way
  // back that fails before it lands leaves the page refused.
  const liftIfBack = () => {
    if (leftFor && urlOnSites(page.url(), sites)) leftFor = undefined;
  };
  // Every page in the context goes through these routes, so a page other than
  // the driver's loads nothing before it closes. A popup's first navigation is
  // sent before its frame exists, so a navigation from an unknown frame is
  // refused as well.
  const allowed = (request: Request): boolean => {
    const frame = frameOf(request);
    if (!frame) return !request.isNavigationRequest();
    if (frame.page() !== page) return false;
    return (
      frame !== page.mainFrame() ||
      !request.isNavigationRequest() ||
      urlOnSites(request.url(), sites)
    );
  };
  await context.route("**/*", async (route) => {
    if (allowed(route.request())) await route.continue();
    else await route.abort("blockedbyclient");
  });
  const closeOther = (other: Page) => {
    if (other === page) return;
    void other.close().catch((error: unknown) => {
      logger.warn("[web-clients] a page beside the driver's did not close", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  context.on("page", closeOther);
  context.pages().forEach(closeOther);

  // The routes above never see a redirect's later hops. Here every document
  // request of the main frame is paused before it is sent, and one that
  // leaves the sites is failed, so the other site never receives it.
  let stops = 0;
  let stoppedAt: string | undefined;
  const cdp = await context.newCDPSession(page);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  cdp.on("Fetch.requestPaused", ({ requestId, frameId, request }) => {
    const leaves =
      frameId === frameTree.frame.id && !urlOnSites(request.url, sites);
    if (leaves) {
      stops += 1;
      stoppedAt = new URL(request.url).origin;
    }
    const answered: Promise<unknown> = leaves
      ? cdp.send("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        })
      : cdp.send("Fetch.continueRequest", { requestId });
    void answered.catch((error: unknown) => {
      // The page closed, or its navigation was cancelled, while the request
      // was paused: nothing was sent either way.
      logger.debug("[web-clients] a paused document request had no answer", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
    ],
  });

  const locate = (selector: string) => page.locator(selector).first();
  const act = async (selector: string, run: () => Promise<void>) => {
    stayOnSites();
    // A control a click just opened (a menu item, a dialog's button) renders
    // a moment later, so it gets a short wait before it counts as missing.
    const present = await locate(selector)
      .waitFor({ state: "attached", timeout: APPEAR_TIMEOUT_MS })
      .then(
        () => true,
        (error: unknown) => {
          // Only the wait running out means missing; a selector that doesn't
          // parse, or a page that closed, is the caller's failure as it was.
          if (error instanceof Error && error.name === "TimeoutError") return false;
          throw error;
        },
      );
    if (!present) {
      throw new PageDriverError("not_found", `Nothing on the page matches ${selector}.`);
    }
    await run();
  };

  return {
    kind: "playwright",
    canEvaluate: true,
    playwrightSelectors: true,
    async navigate(url) {
      assertOnSites(url, sites);
      const before = departures;
      const stopsBefore = stops;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch (error) {
        // A hop off the sites was failed before it was sent, which ends the
        // navigation in the browser's own error page.
        if (stops !== stopsBefore) {
          throw new PageDriverError(
            "site_blocked",
            `The page was sent to ${stoppedAt}, outside the sites this browser may open.`,
          );
        }
        // Sending the page away interrupts the navigation that left; that
        // ends as site_blocked below. Any other failure is the caller's.
        if (departures === before) {
          liftIfBack();
          throw error;
        }
      }
      liftIfBack();
      stayOnSites();
    },
    async url() {
      stayOnSites();
      return page.url();
    },
    async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
      stayOnSites();
      // Page modules pass plain JSON arguments, never element handles, so the
      // value Playwright hands the function is the argument itself. Widening
      // the parameter lets Playwright's unboxed argument type through.
      const pageFunction = fn as (value: unknown) => T | Promise<T>;
      return page.evaluate(pageFunction, arg);
    },
    waitFor: pollUntil,
    async click(selector) {
      await act(selector, () =>
        locate(selector).click({ timeout: ACTION_TIMEOUT_MS }),
      );
    },
    async type(selector, text) {
      await act(selector, () =>
        locate(selector).fill(text, { timeout: ACTION_TIMEOUT_MS }),
      );
    },
    async press(key, selector) {
      if (selector) {
        await act(selector, () =>
          locate(selector).press(key, { timeout: ACTION_TIMEOUT_MS }),
        );
        return;
      }
      stayOnSites();
      await page.keyboard.press(key);
    },
    async readText(selector) {
      stayOnSites();
      const match = page.locator(selector);
      try {
        if ((await match.count()) === 0) return undefined;
        return (await match.first().innerText({ timeout: READ_TIMEOUT_MS })).trim();
      } catch (error) {
        // The element went away between the count and the read, or the page
        // navigated under the read: either way it is not there now.
        if (error instanceof Error && VANISHED.test(`${error.name} ${error.message}`)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
