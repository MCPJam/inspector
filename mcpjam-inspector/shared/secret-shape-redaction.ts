/**
 * Redact credential-SHAPED strings on the way to a model.
 *
 * Nothing on the browser path does this today. A daemon error string passes
 * verbatim through `command-queue.ts` and `unwrapCommand`, console text is only
 * TRUNCATED by `capConsole`, and a network `failure` is copied as-is. Every one
 * of those is page-controlled or upstream-controlled text, and every one of
 * them routinely quotes a URL:
 *
 *     Error: request to https://api.example.com/v1/me?api_key=sk-live-9f2… failed
 *     Failed to load resource: 401 (Authorization: Bearer eyJhbGciOi…)
 *
 * Which lands in the tool result, in the model's context, in the transcript,
 * in the eval trace, and in whatever the model writes next.
 *
 * `server/utils/log-scrubber.ts` has had the patterns for exactly this since
 * long before the browser existed, and its only consumer is `logger.ts`. So
 * the patterns move here — pure, in `shared/` so the bundled daemon can import
 * them — and the log scrubber imports them back.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *
 *  - It does NOT redact email addresses. The log scrubber does, because a log
 *    is a different artifact with different rules; a model reading a page has
 *    to be able to read the page, and a form that shows the address it is
 *    about is the ordinary case rather than a leak.
 *  - It does NOT redact by KEY NAME. The log scrubber drops any object value
 *    under a key called `token`; here the "object" is an accessibility tree
 *    and the "key" is a page's own label, so that rule would blank out the
 *    field the model is trying to fill.
 *  - It is NOT applied to a11y, text, dom, dialog or page-tool results. Those
 *    are what the model is reading; a false positive there hides the content
 *    rather than protecting anything. It is applied where the string is a
 *    MESSAGE — an error, a console line, a network failure — which nobody is
 *    reading for its content.
 *
 * SHAPE, NOT SECRECY. This cannot know whether a string is a real credential;
 * it knows what credentials look like. It is a second line behind
 * `secret-placeholders` (which keeps the value out of the wire entirely) and
 * the daemon's boot registry (which knows the exact values), not a substitute
 * for either.
 */

/**
 * The credential patterns, AS FACTORIES.
 *
 * A factory per call, because every one of these carries the `g` flag and a
 * global regex is STATEFUL: `lastIndex` survives between calls, so a shared
 * instance silently skips the first match of every other string it is given.
 * That bug is invisible in a test that redacts once and catastrophic in a
 * scrubber applied to a hundred console lines.
 */

/** A whole `Authorization:` header value, whatever the scheme. */
export const authHeaderLike = () =>
  /\b(authorization["']?\s*:\s*)["']?[^\n\r"'`]+/gi;

/**
 * `Bearer <token>`, the spelling that reaches a page's own console.
 *
 * `~` is in the class because it is an UNRESERVED character in a URI and real
 * issuers use it. Without it `Bearer ~abc` matched nothing at all and
 * `Bearer abc~def` matched only the `abc`, leaving the rest of the credential
 * in plain sight — a partial redaction that reads as a successful one.
 */
export const tokenLike = () => /\bBearer\s+[A-Za-z0-9._~\-+/=]+\b/gi;

/**
 * An OpenAI-style `sk-` key, and everything that copied the convention.
 *
 * SEGMENTED, because the convention grew prefixes: `sk-proj-…`, `sk-live-…`,
 * `sk-ant-api03-…`. The pattern this moved from required 16+ unbroken
 * alphanumerics straight after `sk-`, so it matched the oldest format and
 * silently missed every key issued in the last few years.
 *
 * The 16-character floor applies to the LAST segment, which is what keeps
 * ordinary hyphenated prose out: "task-management-system-v2" and
 * "ask-me-about-this" have no segment anywhere near that long.
 */
export const skKeyLike = () => /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{16,}\b/g;

/** A JWT: three base64url segments, which nothing else looks like. */
export const jwtLike = () =>
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * A secret-ish `key=value` or `key: value` pair embedded in a string.
 *
 * The one that earns its place on this path: upstream error messages quote
 * whole URLs, and `...?api_key=plain-secret` is a credential no key-based rule
 * can see because there is no key — it is a substring of a sentence.
 */
export const secretParamLike = () =>
  /\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|secret|password|passwd|pwd|token|auth|key|sig|signature)\s*[=:]\s*["']?)[^&\s"'`]+/gi;

/**
 * Basic-auth credentials in a URL: `https://user:pass@host/…`.
 *
 * MUST RUN BEFORE any email pattern, which otherwise consumes `pass@host` as
 * an address and leaves a remainder this cannot match. The ordering matters
 * only in `log-scrubber.ts`, which has both; it is stated here because that is
 * where the pattern now lives.
 */
export const urlBasicAuthLike = () => /(\/\/[^\s/:@]+:)[^\s@/]+@/g;

/**
 * Replace anything credential-shaped in `text`.
 *
 * ORDER IS LOAD-BEARING. The header pattern runs first and consumes the whole
 * value, so a narrower pattern cannot nibble a piece of it and leave the rest
 * exposed — `Authorization: Basic dXNlcjpwYXNz` redacted only the word "Basic"
 * before that rule existed.
 *
 * Returns the input unchanged when nothing matches, which is the overwhelming
 * majority of strings and the reason this can be on by default: it alters
 * output only when a credential shape is present.
 */
export function redactSecretShapes(
  text: string,
  replacement = "[redacted]",
): string {
  if (!text) return text;
  // AROUND THE PLACEHOLDERS, never through them.
  //
  // `{{secret:GITHUB_PASSWORD}}` is what an exact scrub puts back where a
  // credential was, and it is the thing the model asked for — but it also
  // reads to `secretParamLike` as the key `secret` followed by a value, so an
  // unguarded pass rewrote it to `{{secret:[redacted]`: the name gone, the
  // braces unclosed, and a model told a value was hidden from it when in fact
  // it had been handed back exactly the token it wrote.
  //
  // Splitting on the placeholder and redacting only the GAPS is what keeps
  // both true. It costs one extra pass on a string that contains a
  // placeholder, and nothing at all on every other string — `split` with no
  // match yields the input as a single segment.
  const parts = text.split(SECRET_PLACEHOLDER);
  if (parts.length === 1) return redactSegment(text, replacement);
  return parts
    .map((part, index) =>
      // The odd segments are the capture group — the NAME — which is the
      // thing being protected from the redactor rather than by it.
      index % 2 === 1 ? `{{secret:${part}}}` : redactSegment(part, replacement),
    )
    .join("");
}

/**
 * A `{{secret:NAME}}` as `secret-placeholders.ts` spells it.
 *
 * Capturing, so `split` hands the names back as the odd-indexed segments; a
 * duplicate of the name charset rather than an import, because this module is
 * bundled into the daemon and must stay free of server-side imports.
 */
const SECRET_PLACEHOLDER = /\{\{secret:([A-Z_][A-Z0-9_]*)\}\}/g;

/** One stretch of text with no placeholder in it. @see redactSecretShapes */
function redactSegment(text: string, replacement: string): string {
  if (!text) return text;
  return text
    .replace(authHeaderLike(), `$1${replacement}`)
    .replace(tokenLike(), `Bearer ${replacement}`)
    .replace(jwtLike(), replacement)
    .replace(urlBasicAuthLike(), `$1${replacement}@`)
    .replace(skKeyLike(), replacement)
    .replace(secretParamLike(), `$1${replacement}`);
}
