import { describe, expect, it } from "vitest";
import {
  badToolArgsMessage,
  checkToolArgs,
} from "../src/conformance-tool-args.js";

const weather = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

describe("checkToolArgs", () => {
  it("accepts arguments that fit the tool's schema", () => {
    expect(checkToolArgs(weather, { city: "Lima" })).toEqual({
      verdict: "valid",
    });
  });

  it("names what is wrong with arguments the schema rejects", () => {
    const verdict = checkToolArgs(weather, {});
    expect(verdict.verdict).toBe("invalid");
    expect(verdict.verdict === "invalid" && verdict.message).toMatch(/city/);
  });

  it("treats missing arguments as an empty object", () => {
    expect(checkToolArgs(weather, undefined).verdict).toBe("invalid");
    expect(checkToolArgs({ type: "object" }, undefined)).toEqual({
      verdict: "valid",
    });
  });

  it("cannot tell without a schema", () => {
    expect(checkToolArgs(undefined, {})).toEqual({ verdict: "unknown" });
    expect(checkToolArgs("not a schema", {})).toEqual({ verdict: "unknown" });
  });

  it("cannot tell for a dialect it does not speak", () => {
    expect(
      checkToolArgs(
        { ...weather, $schema: "https://example.test/custom-dialect" },
        {}
      )
    ).toEqual({ verdict: "unknown" });
  });

  it("cannot tell for a schema that does not compile", () => {
    expect(
      checkToolArgs(
        { type: "object", properties: { a: { $ref: "#/nowhere" } } },
        { a: 1 }
      )
    ).toEqual({ verdict: "unknown" });
  });

  it("says how to fix it in plain words", () => {
    expect(badToolArgsMessage("get_weather", "missing city")).toBe(
      'Your arguments for "get_weather" don\'t match its input schema (missing city), so this check could not run. Fix the arguments in setup, then run again.'
    );
  });
});
