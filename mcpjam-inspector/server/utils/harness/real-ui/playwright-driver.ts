/**
 * The Playwright driver: a page in a browser this process launched (the local
 * engine, the tracer kit and tests).
 *
 * The signed-in profile may only open the vendor's sites and MCPJam's sign-in
 * page: a top-level navigation anywhere else is aborted, and `navigate`
 * refuses it before trying. Subresources load as the site asks, since the
 * vendor's own pages pull scripts and frames from elsewhere.
 *
 * Playwright routes only the first request of a redirect chain, so an
 * allowed page that redirects elsewhere can't be stopped before it loads.
 * When the page lands off the sites anyway, it goes to a blank page and the
 * driver refuses every command until a `navigate` lands back on one of them.
 */
import type { Page } from "playwright";
import {
  PageDriverError,
  assertOnSites,
  pollUntil,
  urlOnSites,
  type PageDriver,
} from "./page-driver.js";
import { logger } from "../../logger.js";

const ACTION_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 2_000;
const VANISHED = /TimeoutError|Execution context was destroyed|frame was detached/;

export async function createPlaywrightDriver(
  page: Page,
  options: { sites: readonly string[] },
): Promise<PageDriver> {
  const sites = options.sites;
  let leftFor: string | undefined;
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
  await page.route("**/*", async (route) => {
    const request = route.request();
    const topLevel =
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    if (topLevel && !urlOnSites(request.url(), sites)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const locate = (selector: string) => page.locator(selector).first();
  const act = async (selector: string, run: () => Promise<void>) => {
    stayOnSites();
    if ((await page.locator(selector).count()) === 0) {
      throw new PageDriverError("not_found", `Nothing on the page matches ${selector}.`);
    }
    await run();
  };

  return {
    kind: "playwright",
    canEvaluate: true,
    async navigate(url) {
      assertOnSites(url, sites);
      const before = departures;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch (error) {
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
