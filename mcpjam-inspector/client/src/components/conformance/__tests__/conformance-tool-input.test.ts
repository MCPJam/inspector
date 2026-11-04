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
    expect(acceptsEmptyToolArguments({ $async: true, type: "object" })).toBe(
      false,
    );
  });

  it("checks refetched schemas with the same ID independently", () => {
    const schema = { $id: "urn:mcpjam:task-input", type: "object" };
    expect(acceptsEmptyToolArguments(schema)).toBe(true);
    expect(acceptsEmptyToolArguments({ ...schema })).toBe(true);
    expect(
      acceptsEmptyToolArguments({
        ...schema,
        properties: { message: { type: "string" } },
        required: ["message"],
      }),
    ).toBe(false);
    expect(acceptsEmptyToolArguments({ ...schema })).toBe(true);
  });

  it("supports explicit draft-07 schemas", () => {
    expect(
      acceptsEmptyToolArguments({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
      }),
    ).toBe(true);
  });

  it("validates 2020-12 schemas without dropping their dialect", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        args: { type: "object", properties: { message: { type: "string" } } },
      },
      $ref: "#/$defs/args",
    };
    expect(acceptsEmptyToolArguments(schema)).toBe(true);
    expect(
      acceptsEmptyToolArguments({
        ...schema,
        $defs: { args: { ...schema.$defs.args, required: ["message"] } },
      }),
    ).toBe(false);
  });
});
