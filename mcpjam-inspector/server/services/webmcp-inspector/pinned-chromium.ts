/**
 * THE ONE PLACE THE PINNED BROWSER IS NAMED.
 *
 * Every finding about WebMCP in this repository is a fact about a SPECIFIC
 * Chromium, not about browsers: which feature flags are sufficient, whether
 * annotations survive a round trip, whether `toolsRemoved` fires on
 * navigation, whether a `_blank` navigation loses the page's tools, what the
 * AX tree reports for a password field. Each was measured once and written
 * down as prose beside the code it justifies — and each of those sentences
 * names a version number, in nine different files.
 *
 * That is the problem. A Chromium bump is a bump of a fact base, and the fact
 * base was scattered: nothing connected `docs/webmcp-inspector.md:480` to the
 * spike that proved it, and nothing failed when `package.json` moved and the
 * prose did not. So the number lives here, the test beside it asserts every
 * other mention agrees, and `docs/chromium-bump-checklist.md` says what to
 * re-run when it changes.
 *
 * A LEAF MODULE, deliberately. `launch-args.ts` does NOT import it: the launch
 * args must work against whatever Chromium is actually installed — the UA
 * correction reads playwright-core's own `browsers.json` for exactly that
 * reason — and a launch path that consulted a hard-coded version would start
 * lying the moment the two disagreed. This constant is for tests and for
 * documentation, which are the two things that legitimately want to know what
 * we MEANT to pin.
 */

/** The Chromium build every WebMCP finding in this repo was measured against. */
export const PINNED_CHROMIUM = "151.0.7922.34";

/** The Playwright release that installs it. @see PINNED_CHROMIUM */
export const PINNED_PLAYWRIGHT = "1.62.1";

/** `151`, for a check that only cares about the line. */
export const PINNED_CHROMIUM_MAJOR = Number(PINNED_CHROMIUM.split(".")[0]);
