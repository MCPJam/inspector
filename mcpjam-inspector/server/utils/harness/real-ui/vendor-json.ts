/**
 * Reads a vendor's own JSON API through the page's signed-in session.
 *
 * With a script in the page (Playwright), it is a same-origin `fetch` that
 * carries the page's cookies and nothing of MCPJam's. Without one (the hosted
 * browser), the browser opens the URL itself and the module reads the JSON
 * the browser shows, then goes back to the page it was on, whatever it read;
 * only a cookie-authenticated endpoint works that way.
 */
import { PageDriverError, type PageDriver } from "./page-driver.js";

/** The site's own API answered with an error status, so nothing it saved was read. */
export class VendorStatusError extends PageDriverError {
  constructor(readonly status: number) {
    super("failed", `The site answered ${status} for its own saved data.`);
    this.name = "VendorStatusError";
  }
}

export async function readVendorJson(
  driver: PageDriver,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  if (driver.canEvaluate) {
    const result = await driver.evaluate(
      async (args: { url: string; headers: Record<string, string> }) => {
        const response = await fetch(args.url, {
          credentials: "include",
          headers: args.headers,
        });
        return { status: response.status, text: await response.text() };
      },
      { url, headers },
    );
    if (result.status < 200 || result.status >= 300) {
      throw new VendorStatusError(result.status);
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

/** The JSON in a page's text, without the browser viewer's own controls around it. */
function shownJson(shown: string): unknown {
  const start = shown.search(/[[{]/);
  const end = Math.max(shown.lastIndexOf("}"), shown.lastIndexOf("]"));
  try {
    if (start < 0 || end < start) throw new Error("no JSON");
    return JSON.parse(shown.slice(start, end + 1));
  } catch {
    // A page too long for the browser's text read ends cut off, and reads here too.
    throw new PageDriverError("failed", "The site's saved data could not be read in this browser.");
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
