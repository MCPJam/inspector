import { convexErrMessage } from "@/lib/convex-error";
import type {
  GithubCheckConnectionStatus,
  GithubInstallationBindingStatus,
} from "@/hooks/useGithubChecksSettings";

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

// ── Installation binding ────────────────────────────────────────────────────

/**
 * What a connected repository's state means, and what it is NOT.
 *
 * Each line names what happened and then rules out the reading that would send
 * somebody to fix the wrong thing. "This is not a problem with your pull
 * request" is doing real work in a product whose whole output is a red or green
 * mark on somebody's PR: the natural assumption when a check stops is that the
 * code did something, and three of these four states have nothing to do with
 * the code at all.
 *
 * The status is DERIVED BY THE BACKEND from facts this app never sees. It is
 * never inferred here — least of all from a missing visibility badge, which
 * means "GitHub did not tell us", not "something is wrong".
 */
export const GITHUB_CONNECTION_STATUS_COPY = {
  verified: null,
  legacy_unverified:
    "Connected before MCPJam verified repositories. Reconnect it to keep checks running — nothing is wrong with the repository or its pull requests.",
  installation_inactive:
    "The MCPJam GitHub App is not active on this account right now, so checks are paused. This is not a problem with your pull requests — reconnect the app from the section above.",
  repository_access_removed:
    "The MCPJam GitHub App no longer has access to this repository, so checks are paused. This is not a problem with your pull requests — grant it access on GitHub, then reconnect.",
  // `satisfies`, not a plain annotation: the map keeps its literal types for
  // callers AND the compiler refuses it if the union gains or loses a member.
  // Without it, a new status is only noticed when something indexes the map.
} as const satisfies Record<GithubCheckConnectionStatus, string | null>;

/** The short badge label beside a row. Same states, fewer words. */
export const GITHUB_CONNECTION_STATUS_LABEL = {
  verified: null,
  legacy_unverified: "Reconnect required",
  installation_inactive: "App inactive",
  repository_access_removed: "No access",
} as const satisfies Record<GithubCheckConnectionStatus, string | null>;

/**
 * What an installation binding's state means to an administrator.
 *
 * `accountLogin` is DISPLAY ONLY and is interpolated by the caller — GitHub
 * lets an account be renamed, so nothing here or anywhere else decides anything
 * from it.
 */
export const GITHUB_BINDING_STATUS_COPY = {
  active: "Connected. Repositories on this account can run checks.",
  suspended:
    "Suspended on GitHub. Checks are paused for this account until somebody unsuspends the app there.",
  removed:
    "The app was uninstalled from this account. Reconnect it to start running checks again.",
  // UNREACHABLE IN PRACTICE, and kept anyway. The backend's
  // `listBindingsForOrganization` filters `unbound` rows out: an admin severed
  // that relationship deliberately, and keeping it on the page as a fifth state
  // to interpret adds nothing. The entry stays because the map is total over
  // the status union — a partial map would mean this file stopped failing to
  // compile the day the backend changed its mind.
  unbound: "Disconnected from this workspace.",
} as const satisfies Record<GithubInstallationBindingStatus, string>;

/**
 * The confirmation before an admin severs a binding.
 *
 * Says the consequence and its LIMIT in the same breath. Disconnecting stops
 * checks immediately, and it is genuinely reversible — nothing about which
 * suite runs on which repository is thrown away — so the copy must not imply
 * that reconnecting means rebuilding.
 */
export const GITHUB_UNBIND_CONFIRMATION =
  "Disconnect this GitHub account? Checks on its repositories stop immediately. Your suite and policy settings are kept, so reconnecting restores them.";

/**
 * The one message the binding flow shows when it could not be completed.
 *
 * DELIBERATELY THE SAME for every reason the backend can refuse: the
 * installation is already connected somewhere else, it does not exist, the
 * proof did not check out, the state expired. Distinguishing them would answer
 * questions about other people's GitHub accounts and other workspaces, so the
 * backend refuses flatly and this is simply what it says.
 *
 * The one exception the backend DOES word specifically is a conflict, which
 * still names no workspace. Both arrive as `ConvexError` payloads and are shown
 * exactly as the backend worded them; this is only the fallback for a failure
 * that carried no message of its own.
 */
export const GITHUB_BINDING_FAILED_MESSAGE =
  "We could not finish connecting that GitHub account. This is not a problem with your repositories — start again from Settings.";

/**
 * A callback URL that carries neither GitHub's setup parameters nor its OAuth
 * parameters. Somebody opened or reloaded the page directly.
 */
export const GITHUB_CALLBACK_INCOMPLETE_MESSAGE =
  "This page finishes connecting a GitHub account, and it was opened without the details GitHub sends. Start again from Settings.";

/**
 * The return trip from GitHub landed with nobody signed in to MCPJam.
 *
 * Worth its own sentence rather than the generic binding failure: nothing is
 * wrong with the GitHub account or the app, the session here simply is not
 * there — and "sign in and start again" is an instruction, where the generic
 * copy would send someone to re-check GitHub settings that are already fine.
 */
export const GITHUB_SIGNED_OUT_MESSAGE =
  "You are not signed in to MCPJam, so we could not finish connecting that GitHub account. Sign in and start again from Settings.";
