/**
 * The Playwright driver: a page in a browser this process launched (the local
 * engine, the tracer kit and tests).
 *
 * The signed-in profile may only open the vendor's sites and MCPJam's sign-in
 * page: a top-level navigation anywhere else is aborted, and `navigate`
 * refuses it before trying. Subresources load as the site asks, since the
 * vendor's own pages pull scripts and frames from elsewhere.
 */
import type { Page } from "playwright";
import {
  PageDriverError,
  assertOnSites,
  pollUntil,
  urlOnSites,
  type PageDriver,
} from "./page-driver.js";

const ACTION_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 2_000;
const VANISHED = /TimeoutError|Execution context was destroyed|frame was detached/;

export async function createPlaywrightDriver(
  page: Page,
  options: { sites: readonly string[] },
): Promise<PageDriver> {
  const sites = options.sites;
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
      await page.goto(url, { waitUntil: "domcontentloaded" });
    },
    async url() {
      return page.url();
    },
    async evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
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
      await page.keyboard.press(key);
    },
    async readText(selector) {
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
