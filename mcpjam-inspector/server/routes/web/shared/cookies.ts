/**
 * One cookie builder and parser for the web routes.
 *
 * THIS EXISTS BECAUSE THERE WERE ALREADY THREE. `guest-session-shared.ts`,
 * `surface-link/index.ts`, and `slack-link/index.ts` each hand-rolled their own
 * `Set-Cookie` string and their own header split, and the connection flow would
 * have made a fourth. Three copies is where "which one did we get the SameSite
 * attribute right in" stops being answerable by reading one file.
 *
 * The existing three are deliberately left alone here — retrofitting them is a
 * separate change with its own regression surface, and doing it in the same
 * commit as a new feature would hide one inside the other. New cookies use
 * this; the old ones get moved over when someone touches them next.
 *
 * THE LOCAL-HTTP CARVE-OUT IS NOT OPTIONAL. `__Host-` prefixed cookies require
 * `Secure`, which browsers refuse to set over plain http — and the Inspector
 * genuinely runs on `http://localhost` in local development. Without the
 * rewrite, every cookie-authenticated flow silently fails to persist locally
 * while working perfectly in staging, which is the worst possible place to find
 * a bug. The rewrite drops the prefix and `Secure` for loopback ONLY.
 */

import type { Context } from "hono";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface CookieOptions {
  /** Cookie lifetime. Omit for a session cookie. */
  maxAgeSeconds?: number;
  /** Defaults to "/" — narrow it when the cookie is only for one route family. */
  path?: string;
  /**
   * Defaults to "Lax", which is correct for a cookie that must survive a
   * top-level GET redirect back from an OAuth provider. "Strict" would drop it
   * on exactly that navigation; "None" would send it on every cross-site
   * request, which nothing here needs.
   */
  sameSite?: "Lax" | "Strict" | "None";
}

function isLocalHttpRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** The name a cookie takes on plain-http localhost, where `__Host-` is illegal. */
export function localCookieName(name: string): string {
  return name.replace(/^__Host-/, "");
}

/**
 * Build a `Set-Cookie` value.
 *
 * Always `HttpOnly` — every cookie built here carries a capability, and none of
 * them has any business being readable from JavaScript.
 */
export function buildCookie(
  name: string,
  value: string,
  options: CookieOptions = {}
): string {
  return buildCookieWithSecurity(name, value, options, true);
}

/**
 * `Secure` is a parameter, not a substring to delete afterwards.
 *
 * The loopback twin below used to be built by `buildCookie(...).replace("; Secure", "")`
 * — a string edit reaching into a formatter's output, which only works while the
 * attribute list happens to contain that exact text in that exact spelling.
 * `SameSite=None` requires `Secure`, so a caller passing it would have produced
 * a cookie every browser rejects, and the formatter would have had no way to
 * say so.
 */
function buildCookieWithSecurity(
  name: string,
  value: string,
  options: CookieOptions,
  secure: boolean
): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`, "HttpOnly"];
  if (secure) parts.push("Secure");
  // `SameSite=None` REQUIRES `Secure`; a browser rejects the pair without it,
  // so emitting it on the plain-http loopback twin would produce a cookie that
  // is silently never stored. Narrowing to `Lax` there keeps the cookie working
  // locally and is strictly the safer of the two.
  const sameSite = options.sameSite ?? "Lax";
  parts.push(`SameSite=${!secure && sameSite === "None" ? "Lax" : sameSite}`);
  if (typeof options.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join("; ");
}

/** An immediately-expiring version of the same cookie, for logout/consume. */
export function buildExpiredCookie(
  name: string,
  options: CookieOptions = {}
): string {
  return buildCookie(name, "", { ...options, maxAgeSeconds: 0 });
}

/**
 * Set a cookie, adding the loopback-compatible twin when running on local http.
 */
export function setCookie(
  c: Context,
  name: string,
  value: string,
  options: CookieOptions = {}
): void {
  c.header("Set-Cookie", buildCookie(name, value, options), { append: true });
  if (isLocalHttpRequest(c.req.url)) {
    const local = localCookieName(name);
    if (local !== name) {
      // Same cookie, minus the two things plain http cannot honour.
      c.header(
        "Set-Cookie",
        buildCookieWithSecurity(local, value, options, false),
        { append: true }
      );
    }
  }
}

export function clearCookie(
  c: Context,
  name: string,
  options: CookieOptions = {}
): void {
  setCookie(c, name, "", { ...options, maxAgeSeconds: 0 });
}

/**
 * Read one cookie's value, checking the loopback name too — but ONLY on
 * loopback.
 *
 * `setCookie` writes the de-prefixed twin only on local http, and accepting it
 * everywhere gave back the one property `__Host-` was chosen for. The prefix's
 * whole guarantee is that a subdomain cannot set the cookie; a reader that also
 * honours `mcpjam_server_connection` lets `evil.app.example` set exactly that
 * name and have it believed on `app.example`. Symmetry with the writer is what
 * makes the prefix mean anything.
 *
 * Reads only the named cookie rather than handing the whole `Cookie` header
 * onward — forwarding everything would leak unrelated auth and CSRF cookies
 * from this origin to whatever the value is being sent to.
 */
export function readCookie(c: Context, name: string): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  const candidates = isLocalHttpRequest(c.req.url)
    ? [name, localCookieName(name)]
    : [name];
  for (const part of header.split(/;\s*/)) {
    for (const candidate of candidates) {
      const prefix = `${candidate}=`;
      if (part.startsWith(prefix)) {
        const value = part.slice(prefix.length);
        if (value) return value;
      }
    }
  }
  return null;
}
