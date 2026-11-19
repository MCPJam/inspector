import { describe, expect, it } from "vitest";
import { suiteErrorMessage } from "../conformance-suite-state";

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

describe("suiteErrorMessage", () => {
  it("names the time limit when a proxy cut the request off", () => {
    for (const error of [
      httpError(524, "Request failed (524)"),
      httpError(504, "Request failed (504)"),
    ]) {
      expect(suiteErrorMessage(error)).toMatch(
        /^These checks took too long to finish/,
      );
    }
  });

  it("keeps the route's own timeout message", () => {
    const message =
      "The Protocol checks took longer than the 85-second limit for a hosted run.";
    expect(suiteErrorMessage(httpError(504, message))).toBe(message);
  });

  it("keeps any other error as it is", () => {
    expect(suiteErrorMessage(new Error("Server not found"))).toBe(
      "Server not found",
    );
    expect(suiteErrorMessage("boom")).toBe("boom");
  });
});
