import { describe, expect, it } from "vitest";
import { SdkError } from "../src/errors.js";
import {
  admissionError,
  EvalAdmissionError,
} from "../src/eval-admission-contract.js";
import { ReportingHttpError } from "../src/eval-reporting-transport.js";

describe("admission error contract", () => {
  it.each([
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [402, "PAYMENT_REQUIRED"],
    [426, "UPGRADE_REQUIRED"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
    [503, "INTERNAL_ERROR"],
  ])("uses the public code for HTTP %s", (status, code) => {
    const cause = new ReportingHttpError(status, {});
    expect(admissionError(cause)).toMatchObject({ code, cause });
  });

  it("preserves the envelope code, remedy, details and HTTP cause", () => {
    const details = { code: "admission_closed" };
    const cause = new ReportingHttpError(409, {
      code: "PAYMENT_REQUIRED",
      message: "Start a new run.",
      details,
    });
    expect(admissionError(cause)).toMatchObject({
      code: "PAYMENT_REQUIRED",
      message: "Start a new run.",
      details,
      cause,
    });
    expect(admissionError(cause)).toBeInstanceOf(SdkError);
  });

  it("retains local admission errors and the original transport failure", () => {
    const local = new EvalAdmissionError("Missing key.", "CREDENTIALS_MISSING");
    expect(admissionError(local)).toBe(local);
    const cause = new Error("connection reset");
    expect(admissionError(cause)).toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
      cause,
    });
  });
});
