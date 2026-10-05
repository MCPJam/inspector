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

  it("falls back to its own wording and keeps the case count", () => {
    const error = rerunRefusalError({
      data: { code: "RERUN_NOTHING_TO_RERUN", totalCaseCount: 4 },
    });
    expect(error?.message).toMatch(/nothing to rerun/);
    expect(error?.details).toEqual({
      reason: "RERUN_NOTHING_TO_RERUN",
      totalCaseCount: 4,
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
    });
    expect(error?.status).toBe(409);
    expect(error?.details).toEqual({
      reason: "RERUN_NOTHING_TO_RERUN",
      sourceStatus: "completed",
      totalCaseCount: 3,
    });
  });

  it("fails closed on a malformed preview", () => {
    expect(rerunPreviewRefusal({})?.details).toMatchObject({
      reason: "RERUN_SOURCE_NOT_TERMINAL",
    });
  });
});
