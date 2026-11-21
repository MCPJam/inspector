/**
 * Reads a vendor's own JSON API through the page's signed-in session.
 *
 * With a script in the page (Playwright), it is a same-origin `fetch` that
 * carries the page's cookies and nothing of MCPJam's. Without one (the hosted
 * browser), the browser opens the URL itself and the module reads the JSON
 * the browser shows, then goes back to the page it was on, whatever it read;
 * only a cookie-authenticated endpoint works that way, and only an answer
 * short enough for the browser's page text.
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
  const back = await driver.url();
  await driver.navigate(url);
  try {
    return shownJson(driver.pageText ? await driver.pageText() : ((await driver.readText("body")) ?? ""));
  } finally {
    await driver.navigate(back);
  }
}

/**
 * The JSON in a browser's page text, without the viewer's own controls: a
 * block the page shows fenced, or the text between its first and last bracket.
 */
function shownJson(shown: string): unknown {
  const fenced = /```[^\n]*\n([\s\S]*?)\n```/.exec(shown)?.[1];
  const start = shown.search(/[[{]/);
  const end = Math.max(shown.lastIndexOf("}"), shown.lastIndexOf("]"));
  try {
    if (fenced !== undefined) return JSON.parse(fenced);
    if (start < 0 || end < start) throw new Error("no JSON");
    return JSON.parse(shown.slice(start, end + 1));
  } catch {
    // A page too long for the browser's text read ends cut off, and reads here too.
    throw new PageDriverError("failed", "The site's saved data didn't come through whole in this browser.");
  }
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
