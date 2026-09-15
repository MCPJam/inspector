import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import {
  convexErrMessage,
  describeConvexFailure,
  formatSupportReference,
  getConvexRequestId,
  splitSupportReference,
} from "../convex-error";

/**
 * The shapes below are Convex's, verbatim.
 *
 * A production deployment redacts every plain throw to `Server Error` after
 * the request id; a dev deployment appends the real message and the server
 * stack; the browser client prefixes both with `[CONVEX M(<fn>)]` and suffixes
 * them with `Called by client`. Neither dev nor the component suites reproduce
 * the production mask, so it is spelled out here as a literal — that is the
 * only place the redacted case is visible before it reaches a user.
 */
const REQUEST_ID = "da0bbc6cf9261481";

const PRODUCTION_THROW = `[CONVEX M(members:invite)] [Request ID: ${REQUEST_ID}] Server Error\n  Called by client`;

const DEV_THROW = `[CONVEX M(members:invite)] [Request ID: ${REQUEST_ID}] Server Error\nUncaught Error: unique() query returned more than one result from table users\n    at handler (../convex/members.ts:112:5)\n    at async invoke (../convex/_deps/server.js:44:3)\n  Called by client`;

describe("describeConvexFailure", () => {
  it("says something plain when production disclosed nothing", () => {
    const failure = describeConvexFailure(
      new Error(PRODUCTION_THROW),
      "Failed to invite member",
    );

    expect(failure).toEqual({
      message: "Something went wrong",
      requestId: REQUEST_ID,
      redacted: true,
    });
  });

  it("keeps the dev message and drops the stack under it", () => {
    // The screenshot that started this: the whole server stack went into a
    // toast, so the one line a developer could act on was the hardest to find.
    const failure = describeConvexFailure(new Error(DEV_THROW), "fallback");

    expect(failure.message).toBe(
      "Uncaught Error: unique() query returned more than one result from table users",
    );
    expect(failure.message).not.toContain("at handler");
    expect(failure.message).not.toContain("Called by client");
    expect(failure.message).not.toContain("\n");
    expect(failure.requestId).toBe(REQUEST_ID);
    expect(failure.redacted).toBe(false);
  });

  it("shows a ConvexError's string payload unchanged", () => {
    const failure = describeConvexFailure(
      new ConvexError("You are not an admin of this project."),
      "fallback",
    );

    expect(failure.message).toBe("You are not an admin of this project.");
    expect(failure.redacted).toBe(false);
  });

  it("reads a structured ConvexError payload's message field", () => {
    expect(
      describeConvexFailure(
        new ConvexError({ kind: "forbidden", message: "You are not a member." }),
        "fallback",
      ).message,
    ).toBe("You are not a member.");
  });

  it("de-prefixes a plain throw that carries no request id", () => {
    expect(
      describeConvexFailure(new Error("[CONVEX M(x)] Suite not found"), "f")
        .message,
    ).toBe("Suite not found");
  });

  it("drops the stack off any other Error too", () => {
    const error = new Error("Network request failed");
    error.message = "Network request failed\n    at fetchJson (api.ts:8:1)";

    expect(describeConvexFailure(error, "fallback").message).toBe(
      "Network request failed",
    );
  });

  it("falls back when there is nothing readable to show", () => {
    for (const nothing of [undefined, null, {}, new Error(""), 42]) {
      expect(describeConvexFailure(nothing, "fallback").message).toBe(
        "fallback",
      );
    }
  });

  it("never hands a toast more than 400 characters", () => {
    const long = "x".repeat(900);
    expect(
      describeConvexFailure(new Error(long), "fallback").message.length,
    ).toBe(400);
    expect(
      describeConvexFailure(new ConvexError(long), "fallback").message.length,
    ).toBe(400);
  });
});

describe("getConvexRequestId", () => {
  it("finds the id in every shape Convex throws", () => {
    expect(getConvexRequestId(new Error(PRODUCTION_THROW))).toBe(REQUEST_ID);
    expect(getConvexRequestId(new Error(DEV_THROW))).toBe(REQUEST_ID);
    expect(getConvexRequestId(`[Request ID: ${REQUEST_ID}] Server Error`)).toBe(
      REQUEST_ID,
    );
  });

  it("finds it on a ConvexError as well, even though the user reads the payload", () => {
    // Support still needs the id: it is what the Convex dashboard's logs page
    // searches by, and what the backend's own Sentry events are tagged with.
    const error = new ConvexError("You are not a member.");
    error.message = `[Request ID: ${REQUEST_ID}] Uncaught ConvexError: You are not a member.`;

    expect(getConvexRequestId(error)).toBe(REQUEST_ID);
  });

  it("returns null when there is no id to find", () => {
    expect(getConvexRequestId(new Error("boom"))).toBeNull();
    expect(getConvexRequestId(null)).toBeNull();
    expect(getConvexRequestId({ message: 7 })).toBeNull();
  });
});

describe("convexErrMessage", () => {
  it("appends the support reference to a masked failure", () => {
    expect(convexErrMessage(new Error(PRODUCTION_THROW), "fallback")).toBe(
      `Something went wrong (ref ${REQUEST_ID})`,
    );
  });

  it("appends it to a dev failure too, beside the real message", () => {
    expect(convexErrMessage(new Error(DEV_THROW), "fallback")).toBe(
      `Uncaught Error: unique() query returned more than one result from table users (ref ${REQUEST_ID})`,
    );
  });

  it("does NOT append one to a ConvexError payload", () => {
    // These are expected outcomes the backend worded for this user, not
    // incidents. A reference on one reads as a crash and invites a support
    // thread about something that is working as designed.
    const error = new ConvexError("You are not an admin of this project.");
    error.message = `[Request ID: ${REQUEST_ID}] Uncaught ConvexError: nope`;

    expect(convexErrMessage(error, "fallback")).toBe(
      "You are not an admin of this project.",
    );
  });

  it("leaves a message with no request id alone", () => {
    expect(convexErrMessage(new Error("[CONVEX M(x)] Suite not found"), "f")).toBe(
      "Suite not found",
    );
    expect(convexErrMessage(null, "fallback")).toBe("fallback");
  });
});

describe("support references", () => {
  it("round-trips through the toast layer's split", () => {
    const spliced = `Something went wrong ${formatSupportReference(REQUEST_ID)}`;

    expect(splitSupportReference(spliced)).toEqual({
      text: "Something went wrong",
      requestId: REQUEST_ID,
    });
  });

  it("leaves a message that carries no reference untouched", () => {
    expect(splitSupportReference("Failed to invite member")).toEqual({
      text: "Failed to invite member",
      requestId: null,
    });
    // Only a trailing reference counts: a sentence that merely mentions one
    // mid-string is still the sentence.
    expect(
      splitSupportReference("(ref abc123) came back from support").requestId,
    ).toBeNull();
  });
});
