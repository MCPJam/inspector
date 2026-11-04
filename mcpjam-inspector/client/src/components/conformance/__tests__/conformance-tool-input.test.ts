import { describe, expect, it } from "vitest";
import { acceptsEmptyToolArguments } from "../conformance-tool-input";

describe("automatic task tool arguments", () => {
  it("accepts a tool whose arguments are optional", () => {
    expect(
      acceptsEmptyToolArguments({
        type: "object",
        properties: { message: { type: "string" } },
      }),
    ).toBe(true);
  });

  it("rejects required arguments, including inside composite schemas", () => {
    const schema = {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    };
    expect(acceptsEmptyToolArguments(schema)).toBe(false);
    expect(acceptsEmptyToolArguments({ anyOf: [schema] })).toBe(false);
  });

  it("keeps the warning when the schema cannot be checked", () => {
    expect(acceptsEmptyToolArguments(undefined)).toBe(false);
    expect(acceptsEmptyToolArguments({ type: "invalid" })).toBe(false);
    expect(acceptsEmptyToolArguments({ $async: true, type: "object" })).toBe(false);
  });
});
