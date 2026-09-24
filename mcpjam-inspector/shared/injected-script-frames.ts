/**
 * Telling code the browser injected into the page apart from code we loaded.
 *
 * Chrome iOS's page translation re-walks the DOM a couple of seconds after
 * every SPA route change and, on a tree this size, recurses until it blows the
 * stack. Both error reporters log that RangeError against whichever route the
 * user was on and open a new high-severity issue, for a crash in a script that
 * is not ours, in a session where the app kept working — it never reaches a
 * React error boundary because it never runs inside React.
 *
 * Injected code has no script URL of its own, so the engine stamps its frames
 * with the document URL instead. That is the whole discriminator.
 *
 * The comparison is against the ORIGIN, not the current URL: the frames carry
 * whichever route was showing when the injected code was evaluated, which lags
 * the route the user is on by the time it throws. The 2026-09-23 events landed
 * with frames reading `/playground` and `/tasks` while the document was on
 * `/prompts`, so matching the live URL would have matched nothing.
 *
 * No SDK and no globals, like sentry-config.ts next door — the caller supplies
 * the origin so this stays compilable into every bundle.
 */

/** `/assets/index-*.js` in a build, `/src/main.tsx` under Vite dev. */
const SCRIPT_FILE_EXTENSION = /\.[cm]?[jt]sx?$/;

/** An absolute URL, or the absolute path a same-origin frame is stamped with. */
const URL_OR_ABSOLUTE_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;

/**
 * Was this frame stamped with the document rather than a script?
 *
 * Three things deliberately read as NOT the document, so an exception carrying
 * any of them still reports:
 *
 * - A script on another origin. `js.stripe.com/v3/` has no file extension, so
 *   an extension test alone would have swallowed every failure on the payment
 *   path (client/src/lib/seat-payment-stripe.ts loads it).
 * - A same-origin script file — our own bundle, and Cloudflare's
 *   `/cdn-cgi/challenge-platform/.../main.js`.
 * - A frame with no URL at all: `<anonymous>`, `[native code]`. Those are as
 *   unattributable as a missing stack, and get the same benefit of the doubt.
 */
export function isDocumentFrame(filename: unknown, origin: string): boolean {
  if (typeof filename !== "string" || !URL_OR_ABSOLUTE_PATH.test(filename)) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(filename, origin);
  } catch {
    // An opaque origin (`file://` in the packaged desktop app) gives no base
    // to resolve against. Nothing to compare, so nothing is dropped.
    return false;
  }

  if (url.origin !== origin) return false;
  return !SCRIPT_FILE_EXTENSION.test(url.pathname);
}

/**
 * Did this whole stack come from injected code?
 *
 * An empty stack returns false. An exception with no frames cannot be
 * attributed to anybody, and dropping those to catch a variant this rule was
 * not written for would hide real errors.
 */
export function isInjectedScriptStack(
  filenames: unknown[],
  origin: string,
): boolean {
  if (filenames.length === 0) return false;
  return filenames.every((filename) => isDocumentFrame(filename, origin));
}

/**
 * Did every value of a (possibly chained) exception come from injected code?
 *
 * One entry per exception value, each that value's frame filenames. The rule
 * applies per value, not to the values' frames pooled together: a value with
 * no frames — a string `cause`, which PostHog records without a stacktrace —
 * attributes to nobody, so it keeps the whole event. Pooling would let it
 * vanish and leave the other values' document frames to drop a real error.
 */
export function isInjectedScriptException(
  stacks: unknown[][],
  origin: string,
): boolean {
  if (stacks.length === 0) return false;
  return stacks.every((filenames) => isInjectedScriptStack(filenames, origin));
}
