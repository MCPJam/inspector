import { convexErrMessage } from "@/lib/convex-error";

/**
 * What a refused GitHub Checks write says to the person who made it.
 *
 * Its own module, with no React and no Convex client in it, so the surfaces
 * that show these messages can be tested against the REAL mapping: both connect
 * surfaces stub `useGithubChecksSettings` wholesale, and a helper living there
 * would be replaced by a stub in exactly the tests that should be exercising it.
 */

/** The one message the UI shows when the backend refuses on availability. */
export const GITHUB_CHECKS_UNAVAILABLE_MESSAGE =
  "GitHub Checks settings are not currently available.";

/** Shown when a write fails in a way that carries no message of its own. */
const GENERIC_WRITE_ERROR = "Something went wrong. Please try again.";

/**
 * READ `error.data`, NOT `error.message`.
 *
 * The backend words these refusals deliberately — "install the App on that
 * repository" is different advice from "try again", and telling someone the
 * wrong one sends them to reconfigure a working installation. But Convex only
 * carries a message across to a PRODUCTION client when it was thrown as a
 * `ConvexError`, whose payload lands on `data`; `error.message` there is the
 * redacted `Server Error` / request-id string. Reading `message` therefore
 * showed the user nothing useful and — worse — made the availability check
 * below silently never match, because the string it looks for had already been
 * replaced. (Backend PR #1028 is the other half: it throws these as
 * `ConvexError`s so there is a payload to read.)
 *
 * `convexErrMessage` prefers `data` and falls back to a de-prefixed `message`,
 * which is what keeps a plain throw from a dev deployment readable too.
 *
 * ONE helper because both connect surfaces refuse the same way — the settings
 * page and the suite's own section — and a second copy of this rule is a second
 * chance to read the wrong field.
 */
export function githubChecksWriteErrorMessage(error: unknown): string {
  const message = convexErrMessage(error, GENERIC_WRITE_ERROR);
  // The availability refusal gets this surface's own phrasing; every other
  // refusal is shown exactly as the backend worded it, because the backend is
  // the only side that knows which one happened.
  return message.includes("not currently available")
    ? GITHUB_CHECKS_UNAVAILABLE_MESSAGE
    : message;
}
