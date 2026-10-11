/**
 * How much of a URL a breadcrumb keeps (`scrubSentryBreadcrumb` in
 * `sentry-config.ts`). Pure and globals-free: the browser caller supplies the
 * app's origin.
 */

/** `/a/b?c=1#d` → `/a/b`. */
export function stripQueryAndFragment(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** `https://x`, `blob:…`, `//host/…`: a URL that names its own origin. */
const ABSOLUTE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/**
 * A browser request URL as a breadcrumb keeps it. A relative or same-origin
 * URL is a call to our own API, whose paths are ours: the path stays. Any
 * other origin is a third party's, whose path can be anything — a
 * customer's MCP server, a presigned upload — so only its origin stays.
 * Without `appOrigin`, every absolute URL counts as another origin.
 */
export function clientRequestUrl(
  url: string,
  appOrigin: string | undefined,
): string {
  if (!ABSOLUTE_URL.test(url)) return stripQueryAndFragment(url);
  const origin = urlOrigin(url, appOrigin);
  if (origin === undefined) return "[redacted-url]";
  // An opaque origin (`file:`, `data:`) is "null", which matches nothing.
  return appOrigin !== undefined && origin !== "null" && origin === appOrigin
    ? stripQueryAndFragment(url)
    : origin;
}

/** `url`'s origin, resolved against `base` when that is a valid URL. */
function urlOrigin(url: string, base: string | undefined): string | undefined {
  for (const candidate of [base, undefined]) {
    try {
      return new URL(url, candidate).origin;
    } catch {
      // An opaque base ("null") or an unparseable URL: try the next one.
    }
  }
  return undefined;
}
