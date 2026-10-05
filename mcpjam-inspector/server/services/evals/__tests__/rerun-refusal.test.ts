import { describe, expect, it } from "vitest";
import { WebRouteError } from "../../../routes/web/errors.js";
import { rerunPreviewRefusal, rerunRefusalError } from "../rerun-refusal.js";

describe("rerunRefusalError", () => {
  it.each([
    ["RERUN_NOTHING_TO_RERUN", 409],
    ["RERUN_SOURCE_NOT_TERMINAL", 409],
    ["RERUN_SOURCE_SUITE_MISMATCH", 400],
  ])("maps %s to %i with the code as the reason", (code, status) => {
    const error = rerunRefusalError({ data: { code, message: "why" } });
    expect(error).toBeInstanceOf(WebRouteError);
    expect(error?.status).toBe(status);
    expect(error?.message).toBe("why");
    expect(error?.details).toEqual({ reason: code });
  });

  it("falls back to its own wording and keeps the counts", () => {
    const error = rerunRefusalError({
      data: {
        code: "RERUN_NOTHING_TO_RERUN",
        totalCaseCount: 4,
        excluded: { passed: 2, cancelled: 3, skipped: 1, bogus: "x" },
      },
    });
    // Not "every case passed": a run of only stopped trials lands here too.
    expect(error?.message).toBe(
      "Nothing in that run qualifies (no trial failed; cancelled and skipped trials do not count).",
    );
    expect(error?.details).toEqual({
      reason: "RERUN_NOTHING_TO_RERUN",
      totalCaseCount: 4,
      excluded: { passed: 2, cancelled: 3, skipped: 1 },
    });
  });

  it("leaves anything else alone", () => {
    expect(rerunRefusalError(new Error("boom"))).toBeNull();
    expect(rerunRefusalError({ data: { code: "VALIDATION" } })).toBeNull();
    expect(rerunRefusalError({ data: ["RERUN_NOTHING_TO_RERUN"] })).toBeNull();
    expect(rerunRefusalError(null)).toBeNull();
  });
});

describe("rerunPreviewRefusal", () => {
  it("lets a rerunnable preview through", () => {
    expect(
      rerunPreviewRefusal({ sourceTerminal: true, rerunnable: true }),
    ).toBeNull();
  });

  it("refuses a source still in flight, whatever it selected", () => {
    const error = rerunPreviewRefusal({
      sourceTerminal: false,
      sourceStatus: "grading",
      rerunnable: false,
    });
    expect(error?.status).toBe(409);
    expect(error?.details).toEqual({
      reason: "RERUN_SOURCE_NOT_TERMINAL",
      sourceStatus: "grading",
    });
  });

  it("refuses a finished source where nothing qualifies", () => {
    const error = rerunPreviewRefusal({
      sourceTerminal: true,
      sourceStatus: "completed",
      rerunnable: false,
      totalCaseCount: 3,
      excluded: { passed: 1, cancelled: 2, skipped: 0 },
    });
    expect(error?.status).toBe(409);
    expect(error?.details).toEqual({
      reason: "RERUN_NOTHING_TO_RERUN",
      sourceStatus: "completed",
      totalCaseCount: 3,
      excluded: { passed: 1, cancelled: 2, skipped: 0 },
    });
  });

  it("fails closed on a malformed preview", () => {
    expect(rerunPreviewRefusal({})?.details).toMatchObject({
      reason: "RERUN_SOURCE_NOT_TERMINAL",
    });
  });
});
