import { ConvexError } from "convex/values";

/**
 * Did the backend refuse, or did it fail?
 *
 * A `ConvexError` carrying `kind: 'forbidden'` is the server declining to
 * answer — the caller is not a member, the role is too low. That is the
 * product working, not a defect, and two places need the same answer about it:
 *
 *   - `reportCaught`, which must not send it to the error sinks. An expected
 *     refusal that pages the team trains everyone to ignore the channel.
 *   - `RouteErrorScreen`, which must not render it as a crash. A refusal that
 *     is quiet in Sentry but still shows the user a stack trace is only
 *     half-handled (BB-250).
 *
 * It lives in its own module, rather than in `error-reporting.ts` where it
 * started, so that asking "is this a refusal?" does not pull `@sentry/react`
 * and `posthog-js` in behind it. A render path should not have to load the
 * telemetry stack to decide which screen to draw, and a test of that screen
 * should not have to mock it.
 *
 * This is deliberately narrow. Only the explicit `forbidden` shape is a
 * refusal; every other `ConvexError`, and every plain throw, is a fault and
 * keeps its loud treatment. Convex masks plain throws as `Server Error` in
 * production, so a backend that wants silence here has to say so — see
 * `requireProjectRole` and `requireUserActor` in the backend, and
 * `AUTH_WRAPPERS.md` for the convention.
 */
export function isAuthorizationRefusal(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "forbidden"
  );
}

/**
 * Did the backend refuse because this tab's session was signed out?
 *
 * Signing out in one tab (or on another device) revokes the session on the
 * server, and every live query in any OTHER tab still holding a token for it
 * fails at once. The backend tags exactly that refusal
 * `ConvexError({ kind: 'session_revoked' })` (`SESSION_REVOKED_KIND` in its
 * `lib/actors.ts`) so it survives the production `Server Error` mask.
 *
 * Not a fault, so it is kept out of the error sinks like a `forbidden`
 * refusal — but it is NOT an authorization refusal: the right answer is to
 * sign this tab out (`notifySessionRevoked`), not to render "no access".
 * INSPECTOR-CLIENT-2H9 was 13 of these from one sign-out.
 */
export function isSessionRevokedError(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "session_revoked"
  );
}
