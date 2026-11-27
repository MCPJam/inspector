import { describe, expect, it } from "vitest";
import { findInvalidSchemas } from "../index.js";

describe("findInvalidSchemas", () => {
  it("passes a tool with no schemas and tools with valid ones", () => {
    expect(
      findInvalidSchemas({
        tools: {
          a: { description: "x" },
          b: {
            inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            outputSchema: { type: "object", properties: { n: { type: "number" } } },
          },
        },
      }),
    ).toEqual([]);
  });

  it("names an unknown type by its path and lists what it may be", () => {
    const [issue, ...rest] = findInvalidSchemas({ tools: { a: { inputSchema: { type: "bogus-type" } } } });
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ code: "invalid_schema", path: "tools.a.inputSchema.type" });
    expect(issue.message).toContain('"type" must be one of array, boolean, integer, null, number, object, string');
    expect(issue.message).toContain('input schema of tool "a"');
  });

  it("names a required list that is not a list", () => {
    const issues = findInvalidSchemas({ tools: { a: { inputSchema: { type: "object", required: "id" } } } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "tools.a.inputSchema.required" });
    expect(issues[0].message).toContain('"required" must be array');
  });

  it("reaches a nested property and an output schema", () => {
    const issues = findInvalidSchemas({
      tools: { a: { outputSchema: { type: "object", properties: { n: { type: "numbr" } } } } },
    });
    expect(issues.map((issue) => issue.path)).toEqual(["tools.a.outputSchema.properties.n.type"]);
  });

  it("judges draft-07 by its own meta-schema and leaves an unknown dialect alone", () => {
    expect(
      findInvalidSchemas({
        tools: {
          a: { inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", required: ["id"] } },
          b: { inputSchema: { $schema: "https://example.com/own", type: "bogus" } },
        },
      }),
    ).toEqual([]);
    expect(
      findInvalidSchemas({
        tools: { a: { inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "nope" } } },
      }),
    ).toHaveLength(1);
  });
});
