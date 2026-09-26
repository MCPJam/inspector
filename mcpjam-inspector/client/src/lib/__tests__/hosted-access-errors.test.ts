/**
 * `isStaleHostedAccessError` arbitrates recovery for every hosted writer: a
 * true answer queues the write and asks for a re-redeem, a false answer
 * surfaces an error. Both directions of a wrong answer are bad — a missed
 * detection strands a write that would have succeeded after a redeem, and a
 * false positive spins on a rejection no redeem can fix — so the shape
 * matching is pinned directly rather than through a caller.
 */
import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";

import { BlobUploadError } from "@/shared/blob-upload";
import { isStaleHostedAccessError } from "../hosted-access-errors";

describe("isStaleHostedAccessError", () => {
  it("recognizes the structured rejection the backend throws", () => {
    expect(
      isStaleHostedAccessError(
        new ConvexError({
          code: "scenario_access_stale",
          message: "stale",
          currentAccessVersion: 3,
        })
      )
    ).toBe(true);
  });

  it("recognizes the bare payload shape without the ConvexError wrapper", () => {
    expect(
      isStaleHostedAccessError({ data: { code: "scenario_access_stale" } })
    ).toBe(true);
  });

  it("recognizes the upload route's refusal of a stale scenario grant", () => {
    expect(
      isStaleHostedAccessError(
        new BlobUploadError("Stale", 403, "FORBIDDEN", {
          reason: "scenario_access_stale",
        }),
      ),
    ).toBe(true);
  });

  it("rejects an upload refusal for any other reason", () => {
    expect(
      isStaleHostedAccessError(new BlobUploadError("No", 403, "FORBIDDEN")),
    ).toBe(false);
    expect(
      isStaleHostedAccessError({
        data: { code: "FORBIDDEN", reason: "not_a_member" },
      }),
    ).toBe(false);
  });

  it("rejects a different ConvexError code", () => {
    expect(
      isStaleHostedAccessError(
        new ConvexError({ code: "score_value_out_of_range", message: "nope" })
      )
    ).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a plain string", "scenario_access_stale"],
    ["a plain Error", new Error("scenario_access_stale")],
    ["an empty object", {}],
    ["a null data payload", { data: null }],
    ["a string data payload", { data: "scenario_access_stale" }],
    ["a payload with no code", { data: {} }],
  ])("rejects %s", (_label, input) => {
    expect(isStaleHostedAccessError(input)).toBe(false);
  });
});
