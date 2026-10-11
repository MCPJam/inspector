import { describe, expect, it } from "vitest";
import {
  isNumericMultipleOf,
  validateNumericConstraints,
} from "../numeric-validation";

describe("shared numeric constraints", () => {
  it.each([
    [0.3, 0.1, true],
    [-0.3, 0.1, true],
    [0, 0.25, true],
    [1.25, 0.5, false],
    [3, 1.5, true],
    [4, 1.5, false],
    [0.30000000000000004, 0.1, false],
    [1e-7, 1e-8, true],
    [1.5e-7, 1e-7, false],
    [1e21, 1e20, true],
    [Number.MAX_VALUE, Number.MIN_VALUE, true],
    [1, 0, false],
    [1, -1, false],
    [Infinity, 1, false],
    [1, NaN, false],
  ])("checks decimal divisibility for %s / %s", (value, step, expected) => {
    expect(isNumericMultipleOf(value as number, step as number)).toBe(expected);
  });
  it("combines integer, bounds and multipleOf constraints", () => {
    const field = {
      kind: "integer" as const,
      minimum: 0,
      maximum: 6,
      multipleOf: 1.5,
    };
    expect(validateNumericConstraints(3, field, "Quantity")).toBeNull();
    expect(validateNumericConstraints(1.5, field, "Quantity")).toContain(
      "integer",
    );
    expect(validateNumericConstraints(7, field, "Quantity")).toContain(
      "at most 6",
    );
    expect(validateNumericConstraints(4, field, "Quantity")).toContain(
      "multiple of 1.5",
    );
  });
  it("rejects impossible and non-finite constraints rather than claiming validity", () => {
    for (const constraints of [
      { multipleOf: 0 },
      { multipleOf: NaN },
      { maximum: Infinity },
      { minimum: 2, maximum: 1 },
    ])
      expect(
        validateNumericConstraints(
          1,
          { kind: "number", ...constraints },
          "Size",
        ),
      ).toContain("invalid numeric constraints");
  });
});
