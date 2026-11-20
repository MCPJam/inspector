/**
 * Reads a vendor's own JSON API through the page's signed-in session.
 *
 * With a script in the page (Playwright), it is a same-origin `fetch` that
 * carries the page's cookies and nothing of MCPJam's. Without one (the hosted
 * browser), the browser opens the URL itself and the module reads the JSON
 * the browser shows; only a cookie-authenticated endpoint works that way, and
 * only an answer short enough for the browser's page text.
 */
import { PageDriverError, type PageDriver } from "./page-driver.js";

export async function readVendorJson(
  driver: PageDriver,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  if (driver.canEvaluate) {
    const result = await driver.evaluate(
      async (args) => {
        const response = await fetch(String(args.url), {
          credentials: "include",
          headers: typeof args.headers === "object" ? args.headers : {},
        });
        return { status: response.status, text: await response.text() };
      },
      { url, headers },
    );
    if (result.status < 200 || result.status >= 300) {
      throw new PageDriverError(
        "failed",
        `The site answered ${result.status} for its own saved data.`,
      );
    }
    return JSON.parse(result.text);
  }
  if (Object.keys(headers).length > 0) {
    throw new PageDriverError(
      "unsupported",
      "This site's saved data needs a script in the page, which this browser can't run.",
    );
  }
  if (!driver.readPageText) {
    throw new PageDriverError("unsupported", "This browser can't read the site's saved data.");
  }
  const back = await driver.url();
  await driver.navigate(url);
  const shown = await driver.readPageText();
  await driver.navigate(back);
  try {
    return JSON.parse(shownJson(shown));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PageDriverError("failed", "The site's saved data didn't come through whole in this browser.");
  }
}

/** The JSON in a browser's page text: a block the page shows fenced, or the text from its first bracket. */
function shownJson(text: string): string {
  const fenced = /```[^\n]*\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (fenced !== undefined) return fenced;
  const start = text.search(/[[{]/);
  return start >= 0 ? text.slice(start) : text;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
