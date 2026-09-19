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
