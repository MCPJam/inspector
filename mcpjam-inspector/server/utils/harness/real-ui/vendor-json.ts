/**
 * Reads a vendor's own JSON API through the page's signed-in session.
 *
 * With a script in the page (Playwright), it is a same-origin `fetch` that
 * carries the page's cookies and nothing of MCPJam's. Without one (the hosted
 * browser), the browser opens the URL itself and the module reads the JSON
 * the browser shows; only a cookie-authenticated endpoint works that way.
 */
import { PageDriverError, type PageDriver } from "./page-driver.js";

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
      throw new PageDriverError(
        "failed",
        `The site answered ${result.status} for its own saved data.`,
      );
    }
    return parsedJson(result.text);
  }
  if (Object.keys(headers).length > 0) {
    throw new PageDriverError(
      "unsupported",
      "This site's saved data needs a script in the page, which this browser can't run.",
    );
  }
  const back = await driver.url();
  await driver.navigate(url);
  const text = (await driver.readText("body")) ?? "";
  await driver.navigate(back);
  return parsedJson(text);
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

/**
 * The site's answer as JSON. A sign-in or error page in its place fails as
 * the driver's own typed failure, and its text stays out of the message,
 * since the page can show the account's details.
 */
function parsedJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new PageDriverError(
      "failed",
      "The site answered with a page instead of its own saved data.",
    );
  }
}
