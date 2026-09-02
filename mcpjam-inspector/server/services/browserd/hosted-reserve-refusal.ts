/**
 * What a hosted-browser establishment failure should tell the person.
 *
 * Reserving a desktop can fail eight ways, and only one of them is a bug. The
 * rest are conditions a person can act on — their plan does not include
 * Computers, the flag is off for their org, they have started too many
 * machines today, the vendor account is momentarily full, the box did not
 * finish booting. All eight used to arrive as `500 Internal Server Error` plus
 * a Sentry event, because the establishment path threw a bare `Error` and the
 * route's ladder had nothing to match on. The user saw "something went wrong"
 * for a quota working exactly as designed, and we got paged for it.
 *
 * Pure and separate from the route for the same reason the backend's
 * `classifyReserveRefusal` is: this mapping is the load-bearing part, it has
 * eight branches, and route tests that have to stand up a Hono app to check a
 * status code get written once and then not extended.
 *
 * `null` means "not a refusal this understands" — the caller keeps its own
 * 500-and-report path, which is right for a genuine bug.
 */
import { HostedReserveError } from "./hosted-reserve-error.js";

export interface HostedRefusal {
  status: 401 | 403 | 409 | 429 | 499 | 502 | 503 | 504;
  code: string;
  /** Shown to the person. Says what happened AND what they can do about it. */
  error: string;
}

export function classifyHostedReserveError(
  error: unknown,
): HostedRefusal | null {
  if (!(error instanceof HostedReserveError)) return null;

  switch (error.status) {
    case 401:
      return {
        status: 401,
        code: "hosted-auth-required",
        error: "Sign in again to run the browser on your MCPJam computer.",
      };
    case 403:
      return {
        status: 403,
        code: "hosted-forbidden",
        // Two causes, one message: the plan does not include Computers, or the
        // feature is off for this organization. Both are resolved by the same
        // person doing the same thing, and naming which one would leak the
        // org's plan to anyone who can reach this route.
        error:
          "Computers are not enabled for this organization, so there is no machine to run the browser on. An organization admin can enable them.",
      };
    case 429:
      return {
        status: 429,
        code: "hosted-at-capacity",
        error:
          "You have started too many computers recently. Wait for the limit to reset, or close one you are not using.",
      };
    case 503:
      return {
        status: 503,
        code: "hosted-at-capacity",
        error:
          "MCPJam computers are at capacity right now. Try again in a few minutes.",
      };
    case 504:
      return {
        status: 504,
        code: "hosted-reserve-timeout",
        error:
          "Your computer did not finish starting in time. Try again — it is usually ready on the second attempt.",
      };
    case 502:
      return {
        status: 502,
        code: "hosted-provision-failed",
        error: `Your computer failed to start (${error.message}).`,
      };
    case 410:
      return {
        status: 409,
        code: "hosted-desktop-deleted",
        error:
          "That computer has been deleted. Open the browser again to get a new one.",
      };
    case 499:
      // The caller went away mid-reserve — we passed them the request's abort
      // signal, so this is our own code for "they stopped waiting", not a
      // refusal at all. Mapped so it cannot reach the 500-and-report path;
      // nobody is left to read the response either way.
      return {
        status: 499,
        code: "hosted-reserve-abandoned",
        error: "The request was cancelled before the computer was ready.",
      };
    case 0:
      // Not an answer from the control plane at all: this inspector has no
      // `CONVEX_HTTP_URL`, no service token, or could not reach Convex. A
      // deployment problem, so it reads as one rather than as the user's
      // fault — but still not a 500, because the request was fine.
      return {
        status: 503,
        code: "hosted-unconfigured",
        error:
          "This server cannot reach MCPJam computers right now. Try again shortly, or run the browser on your own machine.",
      };
    default:
      return null;
  }
}
