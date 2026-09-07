/**
 * Will saving this URL throw away the server's stored credentials? (MJ-003)
 *
 * The backend clears a row's saved headers, env, OAuth tokens and client secret
 * when a `url` change crosses their origin, because otherwise anyone who can
 * edit a project can repoint a server and have the Inspector deliver somebody
 * else's credential to a host they control.
 *
 * That is the right behaviour and a genuinely surprising one — it destroys data
 * the person saving may not have entered and cannot see. So the edit form has
 * to say so before the save, which is what this is for.
 *
 * ORIGIN, NOT URL. Editing `…/mcp` to `…/mcp/v2` keeps the credentials, and the
 * warning must not fire for it: a warning on the common harmless edit is one
 * people learn to click through, and then it is not there when it matters.
 *
 * These rules mirror `server/utils/secret-origin-binding.ts` and, through it,
 * `convex/lib/canonicalUrl.ts` in the backend. A copy rather than an import
 * because the renderer cannot import server code. If the rules diverge, this
 * warns about the wrong saves — either crying wolf, or staying silent while the
 * backend wipes a credential.
 */

/**
 * The http(s) origin a credential is bound to, or `null` for anything that
 * cannot be reduced to one.
 *
 * The trailing dot is stripped because `host.example.com.` and
 * `host.example.com` are one name to a resolver and two strings to a
 * comparison. Non-http schemes are rejected rather than passed through:
 * `URL.origin` answers the opaque string `"null"` for them, which would make
 * two unrelated URLs compare equal.
 */
export function credentialOriginOf(
  url: string | null | undefined
): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = host;
  return parsed.origin;
}

export interface PendingCredentialClear {
  previousOrigin: string;
  nextOrigin: string;
}

/**
 * The warning to show, or `null` for a save that keeps the credentials.
 *
 * Returns `null` when the next URL cannot be parsed at all: the form's own
 * validation owns that, and a "your credentials will be cleared" warning on a
 * half-typed URL would fire on almost every keystroke.
 */
export function pendingCredentialClearForUrlEdit(args: {
  /** `true` when the row holds any credential a repoint would invalidate. */
  holdsStoredCredential: boolean;
  /** The URL as saved on the server row. */
  savedUrl: string | null | undefined;
  /** The URL currently in the form. */
  nextUrl: string | null | undefined;
}): PendingCredentialClear | null {
  if (!args.holdsStoredCredential) return null;
  const previousOrigin = credentialOriginOf(args.savedUrl);
  const nextOrigin = credentialOriginOf(args.nextUrl);
  if (previousOrigin === null || nextOrigin === null) return null;
  if (previousOrigin === nextOrigin) return null;
  return { previousOrigin, nextOrigin };
}
