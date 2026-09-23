import type { Context } from "hono";

/**
 * Mark an alias response as deprecated on the wire (RFC 8594).
 *
 * On the response rather than in the body: a body field would only reach
 * callers who parse for it, while the header reaches every proxy, log and
 * client library that already looks.
 *
 * Extracted from `clients.ts`, which shipped the first of these aliases, so the
 * `/hosts` family and the `/scenarios` family cannot drift on the one thing a
 * caller actually inspects.
 */
export function markDeprecated(c: Context, successor: string): void {
  c.header("Deprecation", "true");
  c.header("Link", `<${successor}>; rel="successor-version"`);
}
