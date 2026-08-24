import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import {
  GITHUB_CHECKS_UNAVAILABLE_MESSAGE,
  githubChecksWriteErrorMessage,
} from "../github-checks-errors";

/**
 * The rule under test is WHICH FIELD is read, and it only matters in
 * production.
 *
 * Convex masks a plain throw as `Server Error` plus a request id before it
 * reaches a browser; only a `ConvexError` arrives intact, with its payload on
 * `data`. So a client that reads `error.message` shows `Server Error` for every
 * refusal the backend worded carefully — and, less obviously, any branch that
 * matches on the message text stops matching, because the text it looks for was
 * replaced.
 *
 * Neither dev deployments nor the component tests reproduce the mask, so these
 * cases construct the masked shape by hand: that is the only place the
 * distinction is visible.
 */

/** A refusal as it arrives in a real browser: payload intact, message redacted. */
function asProductionRejection(payload: string): ConvexError<string> {
  const error = new ConvexError(payload);
  error.message = "[Request ID: 6f1c2a] Server Error";
  return error;
}

describe("githubChecksWriteErrorMessage", () => {
  it("shows the refusal the backend wrote, not the masked message", () => {
    const message = githubChecksWriteErrorMessage(
      asProductionRejection(
        "Repository is not accessible to the MCPJam GitHub App."
      )
    );

    expect(message).toBe(
      "Repository is not accessible to the MCPJam GitHub App."
    );
    expect(message).not.toContain("Server Error");
    expect(message).not.toContain("Request ID");
  });

  it("keeps the two connect refusals distinguishable", () => {
    // Different advice: one says go and install the App, the other says wait.
    // Collapsing them sends someone to reconfigure a working installation.
    expect(
      githubChecksWriteErrorMessage(
        asProductionRejection(
          "GitHub could not be reached right now. Please try again."
        )
      )
    ).toBe("GitHub could not be reached right now. Please try again.");
  });

  it("still recognises the availability refusal through the mask", () => {
    // The regression that is invisible from the outside: this branch reads the
    // message text, so with a masked message it silently never fires and the
    // user gets a raw backend sentence — or `Server Error` — instead of this
    // surface's own copy.
    expect(
      githubChecksWriteErrorMessage(
        asProductionRejection(
          "GitHub Checks settings are not currently available."
        )
      )
    ).toBe(GITHUB_CHECKS_UNAVAILABLE_MESSAGE);
  });

  it("reads a structured payload's message field", () => {
    // Not the shape these refusals use, but the shape the shared helper
    // supports and the one `kind: 'forbidden'` refusals arrive in.
    expect(
      githubChecksWriteErrorMessage(
        new ConvexError({ kind: "forbidden", message: "You are not an admin." })
      )
    ).toBe("You are not an admin.");
  });

  it("falls back to a plain throw's message, de-prefixed", () => {
    // A dev deployment does not mask, and an invariant violation is deliberately
    // still a plain throw. Both must stay readable.
    expect(
      githubChecksWriteErrorMessage(new Error("[CONVEX M(x)] Suite not found"))
    ).toBe("Suite not found");
  });

  it("says something rather than nothing when there is no message at all", () => {
    for (const nothing of [undefined, null, {}, new Error("")]) {
      const message = githubChecksWriteErrorMessage(nothing);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("undefined");
      expect(message).not.toContain("[object Object]");
    }
  });
});
