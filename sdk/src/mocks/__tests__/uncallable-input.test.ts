import { describe, expect, it } from "vitest";
import { findUncallableInputs } from "../index.js";

const realTools = [
  {
    name: "search",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "number" } },
      required: ["q", "limit"],
      additionalProperties: false,
    },
  },
];

describe("findUncallableInputs", () => {
  it("passes a description-only edit and an entry for a missing real tool", () => {
    expect(
      findUncallableInputs(
        { tools: { search: { description: "x" } } },
        realTools
      )
    ).toEqual([]);
    expect(
      findUncallableInputs(
        { tools: { gone: { params: { x: { hidden: true } } } } },
        realTools
      )
    ).toEqual([]);
  });

  it("refuses hiding a required parameter nothing sets, and names the tool", () => {
    const issues = findUncallableInputs(
      { tools: { search: { params: { limit: { hidden: true } } } } },
      realTools
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "uncallable_input",
      path: "tools.search.params.limit",
    });
    expect(issues[0].message).toContain('"search"');
    expect(issues[0].message).toContain('"limit"');
  });

  it("accepts a hidden required parameter that is fixed or set by answer.arguments", () => {
    expect(
      findUncallableInputs(
        { tools: { search: { params: { limit: { fixed: 10 } } } } },
        realTools
      )
    ).toEqual([]);
    expect(
      findUncallableInputs(
        {
          tools: {
            search: {
              params: { limit: { hidden: true } },
              answer: { arguments: { limit: 10 } },
            },
          },
        },
        realTools
      )
    ).toEqual([]);
  });

  it("refuses a replaced input schema that drops a required parameter", () => {
    const issues = findUncallableInputs(
      {
        tools: {
          search: {
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        },
      },
      realTools
    );
    expect(issues.map((i) => i.path)).toEqual(["tools.search.inputSchema"]);
  });

  it("follows answer.tool to the real tool a renamed entry reaches", () => {
    const issues = findUncallableInputs(
      {
        tools: {
          find: {
            answer: { tool: "search" },
            params: { limit: { hidden: true } },
          },
        },
      },
      realTools
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"find"');
    expect(issues[0].message).toContain('"search"');
  });

  it("skips a hidden tool", () => {
    expect(
      findUncallableInputs({ tools: { search: { hidden: true } } }, realTools)
    ).toEqual([]);
  });

  it("passes an entry with saved answers, which never calls the real tool", () => {
    const saved = {
      from: "saved" as const,
      cases: [{ result: { content: [] } }],
    };
    expect(
      findUncallableInputs(
        {
          tools: {
            search: { params: { limit: { hidden: true } }, answer: saved },
          },
        },
        realTools
      )
    ).toEqual([]);
  });

  it("refuses a listed parameter that a strict real tool would reject as extra", () => {
    const issues = findUncallableInputs(
      {
        tools: {
          search: {
            inputSchema: {
              type: "object",
              properties: { q: {}, limit: {}, lang: {} },
            },
          },
        },
      },
      realTools
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "uncallable_input",
      path: "tools.search.inputSchema.properties.lang",
    });
    expect(issues[0].message).toContain('"lang"');
    // Hiding it, or a real tool that allows extras, is fine.
    expect(
      findUncallableInputs(
        {
          tools: {
            search: {
              inputSchema: {
                type: "object",
                properties: { q: {}, limit: {}, lang: {} },
              },
              params: { lang: { hidden: true } },
            },
          },
        },
        realTools
      )
    ).toEqual([]);
  });
});
