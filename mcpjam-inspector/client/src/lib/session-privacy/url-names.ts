/**
 * Name scrubbing for URLs: `scrubNamesFromUrl` keeps route words and ids and
 * replaces every other path segment, query value and foreign host.
 */
import { scrubCredentialUrl } from "../../../../shared/credential-urls";
import { APP_ROUTES } from "../app-routes";

const NAME_PLACEHOLDER = "[name]";

/**
 * Path segments that are the app's own vocabulary, read off the route table
 * so a new route needs no edit here. `p` prefixes every project route; the
 * rest are the API prefixes replayed network requests start with.
 */
const ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  "p",
  "api",
  "web",
  "v1",
  "mcp",
  ...APP_ROUTES.flatMap((route) => route.path.split("/")).filter(
    (segment) => segment && !segment.startsWith(":") && segment !== "*",
  ),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids may stay: a document id says which record without saying what it is
 * called. Convex ids (lowercase base32, always with digits in practice),
 * UUIDs and plain numbers.
 */
function isIdLike(value: string): boolean {
  return (
    /^\d+$/.test(value) ||
    UUID.test(value) ||
    (/^[0-9a-z]{25,40}$/.test(value) && /\d/.test(value))
  );
}

function scrubSegment(segment: string): string {
  if (!segment || ROUTE_SEGMENTS.has(segment) || isIdLike(segment)) {
    return segment;
  }
  return NAME_PLACEHOLDER;
}

/**
 * Hosts whose names are ours to keep: the hosted app and its vanity domains,
 * and loopback, where npx and desktop serve the app. Any other host in a URL
 * is a customer's (an MCP server, an OAuth provider) and is itself a name.
 */
function isOwnHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "mcpjam.com" ||
    host.endsWith(".mcpjam.com") ||
    host === "caniuse.dev" ||
    host.endsWith(".caniuse.dev") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    (typeof window !== "undefined" &&
      host === window.location?.hostname?.toLowerCase())
  );
}

/**
 * Replace every name-like part of a URL — server names, project slugs, host
 * names, free-form query values — with a placeholder, keeping route words and
 * ids. Credentials go first (`scrubCredentialUrl`), so a share token that
 * happens to look like an id — the hex bench secret does — can never survive
 * as one. A host that is not ours becomes the placeholder too. The fragment
 * is dropped (it can hold anything, OAuth responses included). A value that
 * is not a URL or path has its credentials scrubbed and is otherwise returned
 * unchanged; one that fails to parse becomes the placeholder.
 */
export function scrubNamesFromUrl(rawValue: string): string {
  const value = scrubCredentialUrl(rawValue);
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!isAbsolute && !value.startsWith("/")) return value;
  try {
    const url = new URL(value, "http://scrub.invalid");
    const path = url.pathname
      .split("/")
      .map((segment) =>
        segment === "[redacted]"
          ? segment
          : scrubSegment(decodeURIComponent(segment)),
      )
      .join("/");
    const query = [...url.searchParams]
      .map(
        ([key, param]) =>
          `${encodeURIComponent(key)}=${
            param === "[redacted]"
              ? param
              : isIdLike(param)
                ? encodeURIComponent(param)
                : NAME_PLACEHOLDER
          }`,
      )
      .join("&");
    const origin = !isAbsolute
      ? ""
      : isOwnHost(url.hostname)
        ? url.origin
        : `${url.protocol}//${NAME_PLACEHOLDER}`;
    return `${origin}${path}${query ? `?${query}` : ""}`;
  } catch {
    return NAME_PLACEHOLDER;
  }
}
