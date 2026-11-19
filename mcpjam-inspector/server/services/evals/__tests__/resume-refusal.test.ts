import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../../routes/web/errors";
import { resumeRefusalError } from "../resume-refusal";

describe("resumeRefusalError", () => {
  it("translates each RESUME_* code to a readable status the CLI reads as usage", () => {
    const cases: Array<[string, number, ErrorCode]> = [
      ["RESUME_NOTHING_TO_RESUME", 409, ErrorCode.CONFLICT],
      ["RESUME_SOURCE_NOT_FOUND", 404, ErrorCode.NOT_FOUND],
      ["RESUME_SOURCE_STILL_RUNNING", 409, ErrorCode.CONFLICT],
      ["RESUME_SCOPE_CONFLICT", 400, ErrorCode.VALIDATION_ERROR],
    ];
    for (const [code, status, errorCode] of cases) {
      const refusal = resumeRefusalError({ data: { code } });
      expect(refusal?.status).toBe(status);
      expect(refusal?.code).toBe(errorCode);
      expect(refusal?.details?.reason).toBe(code);
    }
  });

  it("forwards the backend message verbatim, falling back when absent", () => {
    const withMessage = resumeRefusalError({
      data: { code: "RESUME_NOTHING_TO_RESUME", message: "All cases finished." },
    });
    expect(withMessage?.message).toBe("All cases finished.");
    const withoutMessage = resumeRefusalError({
      data: { code: "RESUME_NOTHING_TO_RESUME" },
    });
    expect(withoutMessage?.message).toMatch(/no unfinished cases/);
  });

  it("returns null for anything that is not a resume refusal", () => {
    expect(resumeRefusalError({ data: { code: "RERUN_NOTHING_TO_RERUN" } })).toBeNull();
    expect(resumeRefusalError(new Error("boom"))).toBeNull();
    expect(resumeRefusalError(null)).toBeNull();
  });
});
