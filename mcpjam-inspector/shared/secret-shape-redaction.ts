/**
 * Redacts credential-shaped strings in messages bound for a model: errors,
 * console lines and network failures, which often quote URLs with tokens.
 *
 * Patterns are shared with `server/utils/log-scrubber.ts`; this module is pure
 * so the bundled daemon and the client can import it. Unlike the log scrubber
 * it does not redact emails or by key name, and it is not applied to page
 * content, where false positives would hide what the model reads.
 *
 * Shape-based only: it catches strings that look like credentials, not exact
 * known values.
 */

/**
 * Pattern factories: each regex has `g`, and a shared instance's `lastIndex`
 * would silently skip matches across calls.
 */

/** A whole `Authorization:` header value, whatever the scheme. */
export const authHeaderLike = () =>
  /\b(authorization["']?\s*:\s*)["']?[^\n\r"'`]+/gi;

/**
 * `Bearer <token>`. `~` is a legal token character; without it the rest of a
 * token after `~` stayed visible.
 */
export const tokenLike = () => /\bBearer\s+[A-Za-z0-9._~\-+/=]+\b/gi;

/**
 * `sk-` keys, including segmented ones (`sk-proj-…`, `sk-ant-api03-…`). The
 * 16-character floor on the last segment keeps hyphenated prose out.
 */
export const skKeyLike = () => /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{16,}\b/g;

/** A JWT: three base64url segments, which nothing else looks like. */
export const jwtLike = () =>
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * A secret-ish `key=value` / `key: value` pair, such as `?api_key=` in a
 * quoted URL.
 */
export const secretParamLike = () =>
  /\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|secret|password|passwd|pwd|token|auth|key|sig|signature)\s*[=:]\s*["']?)[^&\s"'`]+/gi;

/**
 * Basic-auth credentials in a URL. Must run before any email pattern (see
 * `log-scrubber.ts`), which would otherwise consume `pass@host`.
 */
export const urlBasicAuthLike = () => /(\/\/[^\s/:@]+:)[^\s@/]+@/g;

/**
 * Replace anything credential-shaped in `text`. Order matters: the header
 * pattern runs first so narrower patterns cannot leave part of it exposed.
 */
export function redactSecretShapes(
  text: string,
  replacement = "[redacted]",
): string {
  if (!text) return text;
  return text
    .replace(authHeaderLike(), `$1${replacement}`)
    .replace(tokenLike(), `Bearer ${replacement}`)
    .replace(jwtLike(), replacement)
    .replace(urlBasicAuthLike(), `$1${replacement}@`)
    .replace(skKeyLike(), replacement)
    .replace(secretParamLike(), `$1${replacement}`);
}
