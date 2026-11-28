import { describe, expect, it, vi } from "vitest";
import {
  MOCK_DEFINITION_CAPS,
  checkDefinitionCaps,
  checkSavedOutputs,
  checkStructuredOutput,
  validateMockDefinition,
} from "../index.js";
import type { MockDefinition } from "../index.js";

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

  it("accepts prompts and resources (skills and apps among them)", () => {
    const definition = {
      prompts: {
        summarize: {
          description: "Summarize a topic.",
          arguments: [{ name: "topic", required: true }],
          messages: [
            {
              role: "user",
              content: { type: "text", text: "Summarize {{input.topic}}." },
            },
          ],
        },
        old_prompt: { hidden: true },
        titled: { title: "Better title" },
      },
      resources: {
        "skill://triage/SKILL.md": {
          text: "---\nname: triage\ndescription: Sort issues.\n---\nBody",
        },
        "ui://counter/app.html": { text: "<button>+1</button>" },
        "file:///logo.png": {
          name: "logo",
          blob: "aGVsbG8=",
          mimeType: "image/png",
        },
        "file:///hidden.txt": { hidden: true },
      },
    };
    expect(validateMockDefinition(definition).ok).toBe(true);
  });

  it("checks the shape of prompts and resources, naming the path of each problem", () => {
    const issues = (input: unknown) => {
      const result = validateMockDefinition(input);
      return result.ok ? [] : result.issues.map((i) => [i.code, i.path]);
    };
    expect(issues({ prompts: { p: { messages: [] } } })).toEqual([
      ["invalid_type", "prompts.p.messages"],
    ]);
    expect(
      issues({
        prompts: {
          p: { messages: [{ role: "system", content: { type: "text" } }] },
        },
      })
    ).toEqual([["invalid_value", "prompts.p.messages.0.role"]]);
    expect(
      issues({ prompts: { p: { hidden: true, description: "x" } } })
    ).toEqual([["param_conflict", "prompts.p"]]);
    expect(issues({ prompts: { p: { descripton: "x" } } })).toEqual([
      ["unknown_field", "prompts.p.descripton"],
    ]);
    expect(issues({ resources: { "no-scheme": { text: "x" } } })).toEqual([
      ["invalid_value", "resources.no-scheme"],
    ]);
    expect(
      issues({ resources: { "file:///a": { text: "x", blob: "eA==" } } })
    ).toEqual([["param_conflict", "resources.file:///a"]]);
    expect(
      issues({ resources: { "file:///a": { blob: "not base64!" } } })
    ).toEqual([["invalid_value", "resources.file:///a.blob"]]);
    expect(
      issues({
        resources: { "ui://a/app.html": { text: "x", mimeType: "text/html" } },
      })
    ).toEqual([["invalid_value", "resources.ui://a/app.html.mimeType"]]);
    expect(
      issues({ resources: { "skill://s/SKILL.md": { blob: "eA==" } } })
    ).toEqual([["invalid_type", "resources.skill://s/SKILL.md"]]);
    expect(issues({ prompts: "x" })).toEqual([["invalid_type", "prompts"]]);
  });

  it("refuses adding prompts or resources while removing their capability", () => {
    const issues = (input: unknown) => {
      const result = validateMockDefinition(input);
      return result.ok ? [] : result.issues.map((i) => [i.code, i.path]);
    };
    expect(
      issues({
        capabilities: { prompts: null },
        prompts: {
          p: {
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          },
        },
      })
    ).toEqual([["param_conflict", "capabilities.prompts"]]);
    // Hiding a real prompt while removing the capability is consistent.
    expect(
      issues({
        capabilities: { prompts: null },
        prompts: { p: { hidden: true } },
      })
    ).toEqual([]);
  });

  it("takes steps and tasks on a saved case, and refuses a malformed one", () => {
    const saved = (entry: object) => ({
      tools: {
        t: {
          answer: {
            from: "saved",
            cases: [{ result: { content: [] }, ...entry }],
          },
        },
      },
    });
    expect(
      codes(saved({ steps: [{ kind: "progress", progress: 1 }], task: true }))
    ).toEqual([]);
    expect(codes(saved({ steps: [] }))).toEqual(["invalid_type"]);
    expect(codes(saved({ task: false }))).toEqual(["invalid_value"]);
  });

  it("accepts answer.from real, saved or omitted and refuses anything else", () => {
    const answer = (value: unknown) => ({ tools: { t: { answer: value } } });
    expect(codes(answer({ from: "real" }))).toEqual([]);
    expect(codes(answer({ tool: "other" }))).toEqual([]);
    expect(codes(answer({ from: "saved", cases: [] }))).toEqual([
      "invalid_type",
    ]);
    expect(codes(answer({ from: "model" }))).toEqual(["unsupported"]);
    expect(
      codes(answer({ from: "model", instructions: "Return invoices." }))
    ).toEqual(["unsupported"]);
    expect(codes(answer({ from: "base" }))).toEqual(["invalid_value"]);
    expect(codes(answer({ from: "real", cases: [] }))).toEqual([
      "unknown_field",
    ]);
  });

  it("checks the shape of saved cases", () => {
    const saved = (cases: unknown) => ({
      tools: { t: { answer: { from: "saved", cases } } },
    });
    expect(
      codes(
        saved([
          { when: { a: 1 }, result: { content: [] } },
          { error: { code: -32000, message: "no" } },
          { result: { content: [{ type: "text", text: "{{input.a}}" }] } },
        ])
      )
    ).toEqual([]);
    // Both, neither, a result with no content, a fractional code, an unknown key.
    expect(
      codes(
        saved([{ result: { content: [] }, error: { code: 1, message: "x" } }])
      )
    ).toEqual(["invalid_value"]);
    expect(codes(saved([{ when: {} }]))).toEqual(["invalid_value"]);
    expect(codes(saved([{ result: { isError: true } }]))).toEqual([
      "invalid_type",
    ]);
    expect(codes(saved([{ error: { code: 1.5, message: "x" } }]))).toEqual([
      "invalid_type",
    ]);
    expect(codes(saved([{ result: { content: [] }, extra: 1 }]))).toEqual([
      "unknown_field",
    ]);
    expect(
      codes(
        saved(Array.from({ length: 201 }, () => ({ result: { content: [] } })))
      )
    ).toEqual(["invalid_value"]);
    expect(
      codes({
        tools: {
          t: {
            answer: {
              from: "saved",
              cases: [{ result: { content: [] } }],
              tool: "u",
            },
          },
        },
      })
    ).toEqual(["unknown_field"]);
  });

  it("accepts a page size from 1 to 1000 and refuses others", () => {
    expect(codes({ pageSize: 1 })).toEqual([]);
    expect(codes({ pageSize: 1000 })).toEqual([]);
    expect(codes({ pageSize: 0 })).toEqual(["invalid_value"]);
    expect(codes({ pageSize: 1001 })).toEqual(["invalid_value"]);
    expect(codes({ pageSize: 2.5 })).toEqual(["invalid_value"]);
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

describe("model answers", () => {
  it("refuses answer.from model with a message that says what to do instead", () => {
    const result = validateMockDefinition({
      tools: { t: { answer: { from: "model" } } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({
      code: "unsupported",
      path: "tools.t.answer.from",
    });
    expect(result.issues[0].message).toContain('from "saved"');
  });
});

describe("structured output of tools with an output schema", () => {
  const outputSchema = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  };

  it("accepts structured content that fits and refuses content that does not", () => {
    expect(
      checkStructuredOutput(outputSchema, { structuredContent: { count: 2 } })
    ).toEqual({ ok: true });
    const wrong = checkStructuredOutput(outputSchema, {
      structuredContent: { count: "two" },
    });
    expect(wrong.ok).toBe(false);
  });

  it("refuses a successful result with no structured content, and exempts an error", () => {
    const missing = checkStructuredOutput(outputSchema, {});
    expect(missing).toEqual({
      ok: false,
      message: expect.stringContaining("must include structuredContent"),
    });
    expect(checkStructuredOutput(outputSchema, { isError: true })).toEqual({
      ok: true,
    });
  });

  it("checks nothing for a tool without an output schema", () => {
    expect(checkStructuredOutput(undefined, {})).toEqual({ ok: true });
  });

  it("refuses a saved result that breaks the entry's own output schema, naming the path", () => {
    const definition: MockDefinition = {
      tools: {
        count: {
          outputSchema,
          answer: {
            from: "saved",
            cases: [
              { result: { content: [], structuredContent: { count: 1 } } },
              { result: { content: [], structuredContent: { count: "x" } } },
              { result: { content: [] } },
              { result: { isError: true, content: [] } },
            ],
          },
        },
      },
    };
    expect(checkSavedOutputs(definition).map((i) => i.path)).toEqual([
      "tools.count.answer.cases.1.result",
      "tools.count.answer.cases.2.result",
    ]);
    expect(checkSavedOutputs(definition)[0].message).toContain(
      "Fix the result"
    );
  });

  it("leaves a result with placeholders to the call, which fills them first", () => {
    expect(
      checkSavedOutputs({
        tools: {
          count: {
            outputSchema,
            answer: {
              from: "saved",
              cases: [
                {
                  result: {
                    content: [],
                    structuredContent: { count: "{{input.n}}" },
                  },
                },
              ],
            },
          },
        },
      })
    ).toEqual([]);
  });
});

describe("hostile in-process values", () => {
  const savedWith = (result: unknown) => ({
    tools: { t: { answer: { from: "saved", cases: [{ result }] } } },
  });

  it("reports an array hole as not_json instead of throwing", () => {
    const result = validateMockDefinition(savedWith({ content: new Array(1) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toEqual(["not_json"]);
      expect(result.issues[0].path).toBe(
        "tools.t.answer.cases[0].result.content[0]"
      );
    }
  });

  it("stops a huge array at the node cap", () => {
    const issues = checkDefinitionCaps(new Array(500000).fill(0));
    expect(issues.map((i) => i.code)).toEqual(["too_many_nodes"]);
  });

  it("contains a throwing getter as one top-level not_json", () => {
    const hostile = {
      get tools(): unknown {
        throw new Error("boom");
      },
    };
    const result = validateMockDefinition(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toEqual(["not_json"]);
      expect(result.issues[0].path).toBe("");
    }
  });

  it("refuses a toJSON hook, even a hidden one that returns nothing", () => {
    const hidden = {};
    Object.defineProperty(hidden, "toJSON", {
      value: () => undefined,
      enumerable: false,
    });
    expect(codes(hidden)).toEqual(["not_json"]);
    expect(codes({ tools: { t: { _meta: { toJSON: () => 1 } } } })).toEqual([
      "not_json",
    ]);
  });
});

describe("saved result shape", () => {
  const withResult = (result: unknown) => ({
    tools: { t: { answer: { from: "saved", cases: [{ result }] } } },
  });
  const issuesAt = (input: unknown): string[] => {
    const result = validateMockDefinition(input);
    return result.ok ? [] : result.issues.map((i) => i.path);
  };
  const prefix = "tools.t.answer.cases.0.result";

  it("needs isError to be a boolean when present", () => {
    expect(issuesAt(withResult({ content: [], isError: "true" }))).toEqual([
      `${prefix}.isError`,
    ]);
    expect(codes(withResult({ content: [], isError: true }))).toEqual([]);
    expect(codes(withResult({ content: [], isError: false }))).toEqual([]);
    expect(codes(withResult({ content: [] }))).toEqual([]);
  });

  it("accepts every MCP content block, placeholders included", () => {
    expect(
      codes(
        withResult({
          content: [
            { type: "text", text: "{{input.x}}" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "audio", data: "AAAA", mimeType: "audio/wav" },
            { type: "resource_link", uri: "file:///a", name: "a" },
            { type: "resource", resource: { uri: "file:///a", text: "hi" } },
            { type: "resource", resource: { uri: "file:///a", blob: "AAAA" } },
          ],
        })
      )
    ).toEqual([]);
  });

  it("names each malformed content block at its index", () => {
    expect(
      issuesAt(
        withResult({
          content: [
            { type: "text", text: "ok" },
            { type: "text" },
            null,
            { type: "video" },
            { type: "image", data: "AAAA" },
            { type: "resource_link", uri: "file:///a" },
            { type: "resource", resource: { uri: "file:///a" } },
          ],
        })
      )
    ).toEqual([
      `${prefix}.content.1.text`,
      `${prefix}.content.2`,
      `${prefix}.content.3.type`,
      `${prefix}.content.4.mimeType`,
      `${prefix}.content.5.name`,
      `${prefix}.content.6.resource`,
    ]);
  });
});

describe("tool field checks", () => {
  const issuesAt = (input: unknown): string[] => {
    const result = validateMockDefinition(input);
    return result.ok ? [] : result.issues.map((i) => i.path);
  };

  it("refuses a parameter that is both hidden and fixed, each alone stays valid", () => {
    const edit = (param: unknown) => ({
      tools: { t: { params: { p: param } } },
    });
    expect(codes(edit({ hidden: true, fixed: null }))).toEqual([
      "param_conflict",
    ]);
    expect(codes(edit({ hidden: true }))).toEqual([]);
    expect(codes(edit({ fixed: null }))).toEqual([]);
  });

  it("lets a hidden tool carry only answer.tool", () => {
    expect(
      codes({ tools: { t: { hidden: true, answer: { tool: "u" } } } })
    ).toEqual([]);
    for (const answer of [
      { from: "saved", cases: [{ result: { content: [] } }] },
      { tool: "u", arguments: {} },
      { from: "real", tool: "u" },
    ]) {
      expect(codes({ tools: { t: { hidden: true, answer } } })).toEqual([
        "param_conflict",
      ]);
    }
  });

  it("says an output schema needs an object root because 2025-11-25 clients require it", () => {
    const result = validateMockDefinition({
      tools: { t: { outputSchema: { type: "array" } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].message).toContain("2025-11-25");
  });

  it("needs annotations.title to be a string", () => {
    expect(issuesAt({ tools: { t: { annotations: { title: 42 } } } })).toEqual([
      "tools.t.annotations.title",
    ]);
    expect(codes({ tools: { t: { annotations: { title: "T" } } } })).toEqual(
      []
    );
  });

  it("needs each icon to be an object with a string src", () => {
    expect(
      issuesAt({
        tools: { t: { icons: [{ src: "https://x.test/i.png" }, 0, {}] } },
      })
    ).toEqual(["tools.t.icons.1", "tools.t.icons.2.src"]);
    expect(codes({ tools: { t: { icons: [] } } })).toEqual([]);
  });
});

describe("placeholders in saved outputs", () => {
  const outputSchema = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  };
  const check = (structuredContent: Record<string, number | string>) =>
    checkSavedOutputs({
      tools: {
        t: {
          outputSchema,
          answer: {
            from: "saved",
            cases: [{ result: { content: [], structuredContent } }],
          },
        },
      },
    });

  it("looks at string values, never keys", () => {
    expect(check({ count: "two", "{{x}}": 0 }).map((i) => i.code)).toEqual([
      "invalid_value",
    ]);
    expect(check({ count: "{{input.n}}" })).toEqual([]);
  });
});

describe("saved result: round 2 shape checks", () => {
  const withResult = (result: unknown) => ({
    tools: { t: { answer: { from: "saved", cases: [{ result }] } } },
  });
  const prefix = "tools.t.answer.cases.0.result";
  const issuesOf = (input: unknown) => {
    const result = validateMockDefinition(input);
    return result.ok ? [] : result.issues;
  };
  const blockAt = (block: unknown) =>
    issuesOf(withResult({ content: [block] }));

  it("gives invalid_value, not a TypeError, for a block type named like an inherited property", () => {
    for (const type of ["constructor", "toString", "__proto__"]) {
      const issues = blockAt({ type });
      expect(issues.map((i) => [i.code, i.path])).toEqual([
        ["invalid_value", `${prefix}.content.0.type`],
      ]);
    }
    const parsed = JSON.parse(
      `{"tools":{"t":{"answer":{"from":"saved","cases":[{"result":{"content":[{"type":"__proto__"}]}}]}}}}`
    );
    expect(() => validateMockDefinition(parsed)).not.toThrow();
  });

  it("needs mimeType to be a string when present on a resource and a resource_link", () => {
    const resourceWith = (mimeType: unknown) => ({
      type: "resource",
      resource: { uri: "file:///a", text: "hi", mimeType },
    });
    expect(blockAt(resourceWith(5)).map((i) => [i.code, i.path])).toEqual([
      ["invalid_type", `${prefix}.content.0.resource.mimeType`],
    ]);
    expect(
      blockAt({
        type: "resource_link",
        uri: "file:///a",
        name: "a",
        mimeType: 5,
      }).map((i) => [i.code, i.path])
    ).toEqual([["invalid_type", `${prefix}.content.0.mimeType`]]);
    expect(blockAt(resourceWith("{{input.m}}"))).toEqual([]);
    expect(blockAt(resourceWith("text/plain"))).toEqual([]);
    expect(
      blockAt({ type: "resource", resource: { uri: "file:///a", text: "hi" } })
    ).toEqual([]);
    expect(
      blockAt({ type: "resource_link", uri: "file:///a", name: "a" })
    ).toEqual([]);
  });

  it("needs a resource_link's size to be a number when present", () => {
    const link = (size: unknown) => ({
      type: "resource_link",
      uri: "file:///a",
      name: "a",
      size,
    });
    expect(blockAt(link("12")).map((i) => [i.code, i.path])).toEqual([
      ["invalid_type", `${prefix}.content.0.size`],
    ]);
    expect(blockAt(link(null)).map((i) => i.path)).toEqual([
      `${prefix}.content.0.size`,
    ]);
    expect(blockAt(link(12))).toEqual([]);
  });

  it("needs a content block's _meta to be an object when present", () => {
    const text = (meta: unknown) => ({ type: "text", text: "ok", _meta: meta });
    for (const bad of [42, null, [], "x"]) {
      expect(blockAt(text(bad)).map((i) => [i.code, i.path])).toEqual([
        ["invalid_type", `${prefix}.content.0._meta`],
      ]);
    }
    expect(blockAt(text({ a: 1 }))).toEqual([]);
    expect(blockAt({ type: "text", text: "ok" })).toEqual([]);
  });

  it("checks a content block's annotations when present", () => {
    const text = (annotations: unknown) => ({
      type: "text",
      text: "ok",
      annotations,
    });
    expect(
      blockAt(text({ audience: ["operator"] })).map((i) => [i.code, i.path])
    ).toEqual([["invalid_value", `${prefix}.content.0.annotations.audience`]]);
    expect(blockAt(text({ priority: 2 })).map((i) => i.path)).toEqual([
      `${prefix}.content.0.annotations.priority`,
    ]);
    expect(blockAt(text({ lastModified: 5 })).map((i) => i.path)).toEqual([
      `${prefix}.content.0.annotations.lastModified`,
    ]);
    expect(blockAt(text(3)).map((i) => i.path)).toEqual([
      `${prefix}.content.0.annotations`,
    ]);
    expect(
      blockAt(
        text({
          audience: ["user", "assistant"],
          priority: 0.5,
          lastModified: "2025-01-01T00:00:00Z",
        })
      )
    ).toEqual([]);
  });

  it("checks a resource_link's title, description and icons when present", () => {
    const link = (extra: object) => ({
      type: "resource_link",
      uri: "file:///a",
      name: "a",
      ...extra,
    });
    expect(blockAt(link({ title: 42 })).map((i) => i.path)).toEqual([
      `${prefix}.content.0.title`,
    ]);
    expect(blockAt(link({ description: 7 })).map((i) => i.path)).toEqual([
      `${prefix}.content.0.description`,
    ]);
    expect(blockAt(link({ icons: [0] })).map((i) => i.path)).toEqual([
      `${prefix}.content.0.icons.0`,
    ]);
    expect(blockAt(link({ icons: "x" })).map((i) => i.path)).toEqual([
      `${prefix}.content.0.icons`,
    ]);
    expect(
      blockAt(
        link({
          title: "A",
          description: "The file",
          icons: [{ src: "https://example.com/a.png" }],
        })
      )
    ).toEqual([]);
  });

  it("needs an embedded resource's _meta to be an object when present", () => {
    const embedded = (meta: unknown) => ({
      type: "resource",
      resource: { uri: "file:///a", text: "ok", _meta: meta },
    });
    expect(blockAt(embedded(42)).map((i) => [i.code, i.path])).toEqual([
      ["invalid_type", `${prefix}.content.0.resource._meta`],
    ]);
    expect(blockAt(embedded({ a: 1 }))).toEqual([]);
  });

  it("needs structuredContent to be an object or one whole placeholder", () => {
    const at = `${prefix}.structuredContent`;
    for (const bad of [null, [1], "text", "a {{input.x}}", 3, "{{a}}{{b}}"]) {
      const issues = issuesOf(
        withResult({ content: [], structuredContent: bad })
      );
      expect(issues.map((i) => [i.code, i.path])).toEqual([
        ["invalid_type", at],
      ]);
      expect(issues[0].message).toContain("MCP requires an object");
    }
    for (const good of [{}, { a: 1 }, "{{input.obj}}"]) {
      expect(
        issuesOf(withResult({ content: [], structuredContent: good }))
      ).toEqual([]);
    }
    expect(issuesOf(withResult({ content: [] }))).toEqual([]);
    // With an output schema too.
    expect(
      issuesOf({
        tools: {
          t: {
            outputSchema: { type: "object" },
            answer: {
              from: "saved",
              cases: [{ result: { content: [], structuredContent: [] } }],
            },
          },
        },
      }).map((i) => i.path)
    ).toEqual([at]);
  });
});

describe("the shape pass reads a plain copy", () => {
  it("does not read a non-enumerable instructions string, and stores none", () => {
    const input = { tools: {} };
    Object.defineProperty(input, "instructions", {
      value: "hidden",
      enumerable: false,
    });
    const result = validateMockDefinition(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("instructions" in result.definition).toBe(false);
      expect(result.definition).toEqual({ tools: {} });
    }
  });

  it("returns a result for a non-enumerable tools getter that throws", () => {
    const input = {};
    Object.defineProperty(input, "tools", {
      get() {
        throw new Error("boom");
      },
      enumerable: false,
    });
    let result: ReturnType<typeof validateMockDefinition> | undefined;
    expect(() => {
      result = validateMockDefinition(input);
    }).not.toThrow();
    expect(result?.ok).toBe(true);
  });

  it("stores a copy, not the caller's object", () => {
    const input = { tools: { t: { description: "d" } } };
    const result = validateMockDefinition(input);
    expect(result.ok && result.definition).toEqual(input);
    expect(result.ok && result.definition).not.toBe(input);
  });
});

describe("array holes count toward the node cap", () => {
  it("stops a 500,000-slot sparse array at the node cap", () => {
    const issues = checkDefinitionCaps({ content: new Array(500_000) });
    expect(issues.at(-1)?.code).toBe("too_many_nodes");
    expect(issues.length).toBeLessThanOrEqual(51);
  });

  it("stops reading slots at the node cap instead of visiting all of them", () => {
    let checked = 0;
    const sparse = new Proxy(new Array(500_000), {
      has(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) checked += 1;
        return Reflect.has(target, key);
      },
    });
    const issues = checkDefinitionCaps({ content: sparse });
    expect(issues.at(-1)?.code).toBe("too_many_nodes");
    // The root and the array are two nodes, so slots 0 to maxNodes - 3 are
    // counted and the next one trips the cap: maxNodes - 1 index checks.
    expect(checked).toBe(MOCK_DEFINITION_CAPS.maxNodes - 1);
  });

  it("still reports a hole under the cap at its index", () => {
    const issues = checkDefinitionCaps({ content: new Array(3) });
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ["not_json", "content[0]"],
      ["not_json", "content[1]"],
      ["not_json", "content[2]"],
    ]);
  });
});

describe("asynchronous and uncompilable output schemas", () => {
  const asyncSchema = {
    $async: true,
    type: "object",
    properties: { n: { type: "number" } },
  };

  it("refuses a root $async in an input or output schema", () => {
    for (const key of ["inputSchema", "outputSchema"]) {
      const result = validateMockDefinition({
        tools: { t: { [key]: asyncSchema } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((i) => [i.code, i.path])).toEqual([
          ["invalid_value", `tools.t.${key}.$async`],
        ]);
        expect(result.issues[0].message).toContain("Remove $async");
      }
    }
    expect(
      validateMockDefinition({
        tools: {
          t: { outputSchema: { type: "object", $async: false } },
        },
      }).ok
    ).toBe(true);
  });

  it("never hands a root $async schema to the validator", async () => {
    const seen = vi.fn();
    process.on("unhandledRejection", seen);
    try {
      const verdict = checkStructuredOutput(asyncSchema, {
        structuredContent: { n: "x" },
      });
      expect(verdict).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", seen);
    }
  });

  it("reports a fixed reason when the compiler throws a value that cannot be read", () => {
    const schema = { type: "object" };
    Object.defineProperty(schema, "$async", {
      get() {
        throw Object.create(null);
      },
    });
    expect(
      checkStructuredOutput(schema, { structuredContent: { n: 1 } })
    ).toEqual({ ok: true });
    const issues = checkSavedOutputs({
      tools: {
        t: {
          outputSchema: schema,
          answer: {
            from: "saved",
            cases: [{ result: { content: [], structuredContent: {} } }],
          },
        },
      },
    } as MockDefinition);
    expect(issues.map((i) => i.path)).toEqual(["tools.t.outputSchema"]);
    expect(issues[0].message).toContain("cannot be read");
  });

  it("answers unchecked, not a throw, when a schema's $async getter throws", () => {
    const schema = { type: "object" };
    Object.defineProperty(schema, "$async", {
      get() {
        throw new Error("getter");
      },
    });
    expect(
      checkStructuredOutput(schema, { structuredContent: { n: 1 } })
    ).toEqual({ ok: true });
  });

  it("reports a schema that does not compile at the tool's outputSchema", () => {
    const issues = checkSavedOutputs({
      tools: {
        t: {
          outputSchema: {
            type: "object",
            properties: { a: { $ref: "#/$defs/missing" } },
          },
          answer: {
            from: "saved",
            cases: [{ result: { content: [], structuredContent: { a: 1 } } }],
          },
        },
      },
    });
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ["invalid_value", "tools.t.outputSchema"],
    ]);
    expect(issues[0].message).toContain("refuses to call");
    expect(issues[0].message).toContain("remove it");
  });

  it("reports an uncompilable schema even when the tool answers from the real server", () => {
    const issues = checkSavedOutputs({
      tools: {
        t: {
          outputSchema: {
            type: "object",
            properties: { a: { $ref: "#/$defs/missing" } },
          },
        },
      },
    });
    expect(issues.map((i) => i.path)).toEqual(["tools.t.outputSchema"]);
  });

  it("says nothing about a schema in a dialect the validator does not know", () => {
    const outputSchema = {
      $schema: "https://example.com/unknown-dialect",
      type: "object",
      properties: { n: { type: "number" } },
    };
    expect(
      checkSavedOutputs({
        tools: {
          t: {
            outputSchema,
            answer: {
              from: "saved",
              cases: [
                { result: { content: [], structuredContent: { n: "x" } } },
              ],
            },
          },
        },
      })
    ).toEqual([]);
  });

  it("checks a literal '{{' in a number field, and defers a whole token", () => {
    const outputSchema = {
      type: "object",
      properties: { n: { type: "number" } },
    };
    const check = (n: string) =>
      checkSavedOutputs({
        tools: {
          t: {
            outputSchema,
            answer: {
              from: "saved",
              cases: [{ result: { content: [], structuredContent: { n } } }],
            },
          },
        },
      });
    expect(check("literal {{").map((i) => i.path)).toEqual([
      "tools.t.answer.cases.0.result",
    ]);
    expect(check("{{input.n}}")).toEqual([]);
  });
});

describe("a getter that succeeds while the caps step reads it", () => {
  it("cannot pass a remote $ref by answering differently when serialized", () => {
    const changing = () => {
      let reads = 0;
      return {
        tools: {
          t: {
            inputSchema: {
              type: "object",
              properties: {
                a: {
                  get $ref() {
                    reads += 1;
                    return reads === 1
                      ? "#/$defs/a"
                      : "https://evil.test/s.json";
                  },
                },
              },
            },
          },
        },
      };
    };
    const result = validateMockDefinition(changing());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "ref_not_local",
          path: "tools.t.inputSchema.properties.a.$ref",
        }),
      ]);
    }
    expect(checkDefinitionCaps(changing()).map((i) => i.code)).toEqual([
      "ref_not_local",
    ]);
  });

  it("cannot make the shape pass throw on a later read", () => {
    let reads = 0;
    const input = {
      get serverInfo() {
        if (++reads > 2) throw new Error("boom");
        return {};
      },
    };
    let result: ReturnType<typeof validateMockDefinition> | undefined;
    expect(() => {
      result = validateMockDefinition(input);
    }).not.toThrow();
    expect(result).toBeDefined();
  });
});

describe("caps that stop the walk are always reported", () => {
  it("reports too_deep even when 50 other issues fill the list", () => {
    const refs = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [
        `r${i}`,
        { $ref: "https://x.test" },
      ])
    );
    const issues = checkDefinitionCaps({ refs, deep: nested(40) });
    expect(issues.filter((i) => i.code === "ref_not_local")).toHaveLength(50);
    expect(issues.at(-1)?.code).toBe("too_deep");
  });

  it("reports a 600,000-character string as too_large without serializing", () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const issues = checkDefinitionCaps({ instructions: "a".repeat(600_000) });
      expect(issues.map((i) => [i.code, i.path])).toEqual([["too_large", ""]]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("counts object keys toward the early size stop", () => {
    const issues = checkDefinitionCaps({ ["k".repeat(600_000)]: 1 });
    expect(issues.map((i) => i.code)).toEqual(["too_large"]);
  });
});

describe("placeholders defer only structuredContent", () => {
  const outputSchema = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
  };
  const check = (result: Record<string, unknown>) =>
    checkSavedOutputs({
      tools: {
        t: {
          outputSchema,
          answer: {
            from: "saved",
            cases: [{ result: { content: [], ...result } }],
          },
        },
      },
    }).map((i) => i.path);
  const text = [{ type: "text" as const, text: "{{input.n}}" }];
  const path = "tools.t.answer.cases.0.result";

  it("reports a missing structuredContent when only a text block has a placeholder", () => {
    expect(check({ content: text })).toEqual([path]);
  });

  it("reports wrong structuredContent when a text block has a placeholder", () => {
    expect(
      check({ content: text, structuredContent: { count: "two" } })
    ).toEqual([path]);
  });

  it("defers a placeholder in structuredContent itself", () => {
    expect(check({ structuredContent: "{{input.obj}}" })).toEqual([]);
    expect(check({ structuredContent: { count: "{{input.n}}" } })).toEqual([]);
  });

  it("still exempts an error result with a text placeholder", () => {
    expect(check({ content: text, isError: true })).toEqual([]);
  });
});

describe("saved results of a schema in an unknown dialect", () => {
  const outputSchema = {
    $schema: "https://example.com/unknown-dialect",
    type: "object",
    properties: { n: { type: "number" } },
  };
  const check = (result: Record<string, unknown>) =>
    checkSavedOutputs({
      tools: {
        t: {
          outputSchema,
          answer: {
            from: "saved",
            cases: [{ result: { content: [], ...result } }],
          },
        },
      },
    }).map((i) => i.path);

  it("still reports a success result with no structuredContent", () => {
    expect(check({})).toEqual(["tools.t.answer.cases.0.result"]);
  });

  it("does not validate the content, and exempts errors and placeholders", () => {
    expect(check({ structuredContent: { n: "x" } })).toEqual([]);
    expect(check({ isError: true })).toEqual([]);
    expect(check({ structuredContent: "{{input.obj}}" })).toEqual([]);
  });
});

describe("icon fields and result _meta", () => {
  const icons = (icon: unknown) => ({ tools: { t: { icons: [icon] } } });
  const paths = (input: unknown): string[] => {
    const result = validateMockDefinition(input);
    return result.ok ? [] : result.issues.map((i) => i.path);
  };
  const src = "https://x.test/i.png";

  it("checks sizes, mimeType and theme at the icon's index", () => {
    expect(paths(icons({ src, sizes: [42] }))).toEqual([
      "tools.t.icons.0.sizes",
    ]);
    expect(paths(icons({ src, sizes: "48x48" }))).toEqual([
      "tools.t.icons.0.sizes",
    ]);
    expect(paths(icons({ src, mimeType: 1 }))).toEqual([
      "tools.t.icons.0.mimeType",
    ]);
    expect(paths(icons({ src, theme: "blue" }))).toEqual([
      "tools.t.icons.0.theme",
    ]);
  });

  it("accepts src-only icons and valid optional fields", () => {
    expect(paths(icons({ src }))).toEqual([]);
    expect(
      paths(
        icons({
          src,
          sizes: ["48x48", "any"],
          mimeType: "image/png",
          theme: "dark",
        })
      )
    ).toEqual([]);
  });

  it("needs a saved result's _meta to be an object when present", () => {
    const withMeta = (meta: unknown) => ({
      tools: {
        t: {
          answer: {
            from: "saved",
            cases: [{ result: { content: [], _meta: meta } }],
          },
        },
      },
    });
    const meta = "tools.t.answer.cases.0.result._meta";
    expect(paths(withMeta(42))).toEqual([meta]);
    expect(paths(withMeta(null))).toEqual([meta]);
    expect(paths(withMeta([]))).toEqual([meta]);
    expect(paths(withMeta({}))).toEqual([]);
    expect(
      paths({
        tools: {
          t: {
            answer: { from: "saved", cases: [{ result: { content: [] } }] },
          },
        },
      })
    ).toEqual([]);
  });
});
