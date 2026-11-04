import { describe, expect, it } from "vitest";
import {
  acceptsEmptyToolArguments,
  acceptsToolArguments,
} from "../conformance-tool-input";

describe("automatic task tool arguments", () => {
  it("requires supplied arguments to match the tool schema", () => {
    const schema = {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    };
    expect(acceptsToolArguments(schema, {})).toBe(false);
    expect(acceptsToolArguments(schema, { projectId: 123 })).toBe(false);
    expect(acceptsToolArguments(schema, { projectId: "project-1" })).toBe(true);
  });
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

  it.each([
    "http://json-schema.org/draft-04/schema#",
    "https://json-schema.org/draft-04/schema#",
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft-07/schema#",
    "http://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2019-09/schema",
    "http://json-schema.org/draft/2020-12/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("checks optional and required arguments for %s", ($schema) => {
    const schema = {
      $schema,
      type: "object",
      properties: { q: { type: "string" } },
    };
    expect(acceptsEmptyToolArguments(schema)).toBe(true);
    expect(acceptsEmptyToolArguments({ ...schema, required: ["q"] })).toBe(
      false,
    );
    expect(
      acceptsToolArguments({ ...schema, required: ["q"] }, { q: "ready" }),
    ).toBe(true);
    expect(
      acceptsToolArguments({ ...schema, required: ["q"] }, { q: 123 }),
    ).toBe(false);
  });

  it("preserves draft-04 rules for references and boolean exclusiveMinimum", () => {
    const schema = {
      $schema: "https://json-schema.org/draft-04/schema#",
      definitions: {
        args: {
          type: "object",
          properties: {
            q: { type: "number", minimum: 0, exclusiveMinimum: true },
          },
        },
      },
      $ref: "#/definitions/args",
      required: ["q"],
    };
    // Draft-04 ignores siblings of $ref; newer dialects apply required here.
    expect(acceptsEmptyToolArguments(schema)).toBe(true);
    expect(acceptsToolArguments(schema, { q: 0 })).toBe(false);
    expect(acceptsToolArguments(schema, { q: 1 })).toBe(true);
    expect(
      acceptsEmptyToolArguments({
        ...schema,
        definitions: { args: { ...schema.definitions.args, required: ["q"] } },
      }),
    ).toBe(false);
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
