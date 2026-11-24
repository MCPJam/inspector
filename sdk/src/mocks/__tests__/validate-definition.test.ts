import { describe, expect, it } from "vitest";
import {
  MOCK_DEFINITION_CAPS,
  checkDefinitionCaps,
  validateMockDefinition,
} from "../index.js";

function codes(input: unknown): string[] {
  const result = validateMockDefinition(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("validateMockDefinition shape", () => {
  it("accepts an empty definition and a description edit", () => {
    expect(validateMockDefinition({}).ok).toBe(true);
    const edit = { tools: { echo: { description: "Echoes a message." } } };
    const result = validateMockDefinition(edit);
    expect(result).toEqual({ ok: true, definition: edit });
  });

  it("accepts every tool field, params and an answer from the real server", () => {
    const result = validateMockDefinition({
      serverInfo: { name: "docs", version: "1.2.3" },
      instructions: "Be brief.",
      capabilities: { logging: {}, prompts: null },
      tools: {
        search: {
          title: "Search",
          description: "Search the docs.",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          icons: [{ src: "https://example.test/i.png" }],
          _meta: { a: 1 },
          params: {
            limit: { fixed: 10 },
            lang: { hidden: true },
            q: { description: "Words to find." },
          },
          answer: { from: "real", tool: "search_v2", arguments: { limit: 5 } },
        },
        old_search: { hidden: true },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses unknown fields and says which are allowed", () => {
    const result = validateMockDefinition({
      tools: { echo: { descripton: "typo" } },
      colour: "red",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => [i.code, i.path])).toEqual([
      ["unknown_field", "colour"],
      ["unknown_field", "tools.echo.descripton"],
    ]);
    expect(result.issues[1].message).toContain("description");
  });

  it("refuses prompts, resources and resourceTemplates as not available yet", () => {
    for (const key of ["prompts", "resources", "resourceTemplates"]) {
      const result = validateMockDefinition({ [key]: {} });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        code: "not_available_yet",
        path: key,
      });
    }
  });

  it("accepts answer.from real or omitted and refuses saved, model and anything else", () => {
    const answer = (value: unknown) => ({ tools: { t: { answer: value } } });
    expect(codes(answer({ from: "real" }))).toEqual([]);
    expect(codes(answer({ tool: "other" }))).toEqual([]);
    expect(codes(answer({ from: "saved", cases: [] }))).toEqual([
      "answer_not_supported",
    ]);
    expect(codes(answer({ from: "model" }))).toEqual(["answer_not_supported"]);
    expect(codes(answer({ from: "base" }))).toEqual(["invalid_value"]);
    expect(codes(answer({ from: "real", cases: [] }))).toEqual([
      "unknown_field",
    ]);
  });

  it("refuses a hidden tool that also carries edits, and a param that is hidden and described", () => {
    expect(codes({ tools: { t: { hidden: true, description: "x" } } })).toEqual(
      ["param_conflict"]
    );
    expect(
      codes({ tools: { t: { hidden: true, answer: { tool: "u" } } } })
    ).toEqual([]);
    expect(
      codes({ tools: { t: { params: { p: { fixed: 1, description: "x" } } } } })
    ).toEqual(["param_conflict"]);
    expect(codes({ tools: { t: { params: { p: {} } } } })).toEqual([
      "invalid_value",
    ]);
  });

  it("refuses wrong types, a non-object schema and removing the tools capability", () => {
    expect(codes({ tools: { t: { description: 4 } } })).toEqual([
      "invalid_type",
    ]);
    expect(
      codes({ tools: { t: { inputSchema: { type: "string" } } } })
    ).toEqual(["invalid_value"]);
    expect(codes({ capabilities: { tools: null } })).toEqual(["invalid_value"]);
    expect(codes([])).toEqual(["invalid_type"]);
    expect(
      codes({ tools: { t: { annotations: { readOnlyHint: "yes" } } } })
    ).toEqual(["invalid_type"]);
  });
});

/** A definition whose JSON is exactly `bytes` long, by padding one description. */
function definitionOfBytes(bytes: number): unknown {
  const base = { tools: { t: { description: "" } } };
  const overhead = new TextEncoder().encode(JSON.stringify(base)).length;
  return { tools: { t: { description: "x".repeat(bytes - overhead) } } };
}

/** `depth` levels of nesting counting the root object as 1. */
function nested(depth: number): unknown {
  let value: unknown = {};
  for (let level = 1; level < depth; level += 1) value = { n: value };
  return value;
}

describe("structural caps", () => {
  it("pins the numbers shared with the backend", () => {
    expect(MOCK_DEFINITION_CAPS).toEqual({
      maxBytes: 524288,
      maxDepth: 32,
      maxNodes: 20000,
      maxPatternLength: 1000,
    });
  });

  it("allows exactly maxBytes and refuses one byte more", () => {
    expect(checkDefinitionCaps(definitionOfBytes(524288))).toEqual([]);
    expect(
      checkDefinitionCaps(definitionOfBytes(524289)).map((i) => i.code)
    ).toEqual(["too_large"]);
  });

  it("counts bytes as UTF-8, not characters", () => {
    const wide = { tools: { t: { description: "é".repeat(262144) } } };
    expect(checkDefinitionCaps(wide).map((i) => i.code)).toEqual(["too_large"]);
  });

  it("allows depth 32 and refuses depth 33", () => {
    expect(checkDefinitionCaps(nested(32))).toEqual([]);
    expect(checkDefinitionCaps(nested(33)).map((i) => i.code)).toEqual([
      "too_deep",
    ]);
    expect(checkDefinitionCaps(nested(40)).map((i) => i.code)).toEqual([
      "too_deep",
    ]);
  });

  it("counts each object, array and primitive once: 20000 passes, 20001 fails", () => {
    // Root object (1) + array (1) + n primitives.
    const withNodes = (n: number) => ({ list: new Array(n - 2).fill(0) });
    expect(checkDefinitionCaps(withNodes(20000))).toEqual([]);
    expect(checkDefinitionCaps(withNodes(20001)).map((i) => i.code)).toEqual([
      "too_many_nodes",
    ]);
  });

  it("limits a string under a key named pattern to 1000 characters", () => {
    const schema = (length: number) => ({
      tools: {
        t: {
          inputSchema: {
            type: "object",
            properties: { q: { type: "string", pattern: "a".repeat(length) } },
          },
        },
      },
    });
    expect(checkDefinitionCaps(schema(1000))).toEqual([]);
    const over = checkDefinitionCaps(schema(1001));
    expect(over.map((i) => i.code)).toEqual(["pattern_too_long"]);
    expect(over[0].path).toBe("tools.t.inputSchema.properties.q.pattern");
    // A long string under any other key is not a pattern.
    expect(
      checkDefinitionCaps({ tools: { t: { description: "a".repeat(1001) } } })
    ).toEqual([]);
  });

  it("requires a $ref to start with # and ignores a parameter that is named $ref", () => {
    const withRef = (ref: string) => ({
      tools: {
        t: {
          inputSchema: { type: "object", properties: { a: { $ref: ref } } },
        },
      },
    });
    expect(checkDefinitionCaps(withRef("#/$defs/a"))).toEqual([]);
    expect(checkDefinitionCaps(withRef("#")).length).toBe(0);
    expect(
      checkDefinitionCaps(withRef("https://evil.test/s.json")).map(
        (i) => i.code
      )
    ).toEqual(["ref_not_local"]);
    expect(
      checkDefinitionCaps(withRef("./local.json")).map((i) => i.code)
    ).toEqual(["ref_not_local"]);
    expect(
      checkDefinitionCaps({
        tools: {
          t: {
            inputSchema: {
              type: "object",
              properties: { $ref: { type: "string" } },
            },
          },
        },
      })
    ).toEqual([]);
  });

  it("refuses values JSON cannot carry without throwing, cycles included", () => {
    expect(checkDefinitionCaps({ a: undefined }).map((i) => i.code)).toEqual([
      "not_json",
    ]);
    expect(checkDefinitionCaps({ a: () => 1 }).map((i) => i.code)).toEqual([
      "not_json",
    ]);
    expect(checkDefinitionCaps({ a: Number.NaN }).map((i) => i.code)).toEqual([
      "not_json",
    ]);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(checkDefinitionCaps(cycle).length).toBeGreaterThan(0);
  });

  it("runs the caps before the shape checks", () => {
    const result = validateMockDefinition(nested(40));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].code).toBe("too_deep");
  });
});
