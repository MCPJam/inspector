/**
 * The one place the pinned Chromium is named. WebMCP findings in this repo are
 * facts about a specific build; the adjacent test asserts every other mention
 * agrees, and `docs/chromium-bump-checklist.md` says what to re-run on a bump.
 *
 * A leaf module for tests and docs only: launch args must work against the
 * Chromium actually installed, so `launch-args.ts` does not import it.
 */

/** The Chromium build every WebMCP finding in this repo was measured against. */
export const PINNED_CHROMIUM = "151.0.7922.34";

/** The Playwright release that installs it. @see PINNED_CHROMIUM */
export const PINNED_PLAYWRIGHT = "1.62.1";

/** `151`, for a check that only cares about the line. */
export const PINNED_CHROMIUM_MAJOR = Number(PINNED_CHROMIUM.split(".")[0]);
