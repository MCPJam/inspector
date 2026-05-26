import { describe, it, expect } from "vitest";
import {
  evaluateToolCalls,
  MATCH_OPTIONS_DEFAULTS,
  resolveMatchOptions,
} from "../src/matchers.js";
import type { EvalToolCall } from "../src/matchers.js";

const tc = (toolName: string, args: Record<string, unknown> = {}): EvalToolCall => ({
  toolName,
  arguments: args,
});

describe("evaluateToolCalls — defaults preserve inspector behavior", () => {
  it("returns passed=false when both sides are empty (preserves today's inspector behavior; use isNegativeTest for no-op assertions)", () => {
    expect(evaluateToolCalls([], [])).toMatchObject({
      passed: false,
      missing: [],
      extra: [],
      outOfOrder: [],
      argumentMismatches: [],
    });
  });

  it("matches tools regardless of order by default", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("b")],
      [tc("b"), tc("a")],
    );
    expect(result.passed).toBe(true);
    expect(result.outOfOrder).toEqual([]);
  });

  it("empty expected args match anything (partial default)", () => {
    const result = evaluateToolCalls(
      [tc("search")],
      [tc("search", { q: "anything" })],
    );
    expect(result.passed).toBe(true);
    expect(result.argumentMismatches).toEqual([]);
  });

  it("extra args on actual are allowed (partial default)", () => {
    const result = evaluateToolCalls(
      [tc("add", { a: 1 })],
      [tc("add", { a: 1, b: 2 })],
    );
    expect(result.passed).toBe(true);
  });

  it("nested object args match regardless of key order (partial default)", () => {
    const result = evaluateToolCalls(
      [tc("save", { meta: { x: 1, y: 2 } })],
      [tc("save", { meta: { y: 2, x: 1 } })],
    );
    expect(result.passed).toBe(true);
  });

  it("reports missing calls", () => {
    const result = evaluateToolCalls([tc("a"), tc("b")], [tc("a")]);
    expect(result.passed).toBe(false);
    expect(result.missing.map((c) => c.toolName)).toEqual(["b"]);
  });

  it("reports extra calls but does NOT fail when allowExtraToolCalls is default-true", () => {
    const result = evaluateToolCalls([tc("a")], [tc("a"), tc("b")]);
    expect(result.passed).toBe(true);
    expect(result.extra.map((c) => c.toolName)).toEqual(["b"]);
  });

  it("reports argument mismatches", () => {
    const result = evaluateToolCalls(
      [tc("add", { a: 1, b: 2 })],
      [tc("add", { a: 1, b: 99 })],
    );
    expect(result.passed).toBe(false);
    expect(result.argumentMismatches).toHaveLength(1);
    expect(result.argumentMismatches[0]).toMatchObject({
      toolName: "add",
      expectedArgs: { a: 1, b: 2 },
      actualArgs: { a: 1, b: 99 },
    });
  });

  it("supports placeholder type checks (string/number/any)", () => {
    const result = evaluateToolCalls(
      [tc("echo", { msg: "string", n: "number", anything: "any" })],
      [tc("echo", { msg: "hi", n: 7, anything: { nested: true } })],
    );
    expect(result.passed).toBe(true);
  });

  it("handles null / undefined inputs gracefully (does not throw)", () => {
    expect(() =>
      evaluateToolCalls(
        null as unknown as EvalToolCall[],
        undefined as unknown as EvalToolCall[],
      ),
    ).not.toThrow();
    const result = evaluateToolCalls(
      null as unknown as EvalToolCall[],
      undefined as unknown as EvalToolCall[],
    );
    // Both sides normalize to []; the positive-test branch fails empty-actual.
    expect(result.passed).toBe(false);
  });
});

describe("evaluateToolCalls — toolCallOrder: strict", () => {
  it("passes when actual order matches expected order", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("b"), tc("c")],
      [tc("a"), tc("b"), tc("c")],
      { toolCallOrder: "strict" },
    );
    expect(result.passed).toBe(true);
    expect(result.outOfOrder).toEqual([]);
  });

  it("fails and reports outOfOrder when calls are reversed", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("b")],
      [tc("b"), tc("a")],
      { toolCallOrder: "strict" },
    );
    expect(result.passed).toBe(false);
    expect(result.outOfOrder).toHaveLength(1);
    expect(result.outOfOrder[0].toolName).toBe("b");
  });

  it("does not flag absences as out-of-order", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("b"), tc("c")],
      [tc("a"), tc("c")],
      { toolCallOrder: "strict" },
    );
    expect(result.missing.map((c) => c.toolName)).toEqual(["b"]);
    expect(result.outOfOrder).toEqual([]);
  });
});

describe("evaluateToolCalls — allowExtraToolCalls: false", () => {
  it("fails when actual contains extras", () => {
    const result = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b")],
      { allowExtraToolCalls: false },
    );
    expect(result.passed).toBe(false);
    expect(result.extra.map((c) => c.toolName)).toEqual(["b"]);
  });
});

describe("evaluateToolCalls — argumentMatching: exact", () => {
  it("fails when actual has extra arg keys", () => {
    const result = evaluateToolCalls(
      [tc("add", { a: 1 })],
      [tc("add", { a: 1, b: 2 })],
      { argumentMatching: "exact" },
    );
    expect(result.passed).toBe(false);
    expect(result.argumentMismatches).toHaveLength(1);
  });

  it("does not treat placeholder strings as type checks", () => {
    const result = evaluateToolCalls(
      [tc("echo", { msg: "string" })],
      [tc("echo", { msg: "hello" })],
      { argumentMatching: "exact" },
    );
    expect(result.passed).toBe(false);
  });

  it("reports a mismatch when expected args are {} but actual has keys", () => {
    const result = evaluateToolCalls(
      [tc("add", {})],
      [tc("add", { a: 1 })],
      { argumentMatching: "exact" },
    );
    expect(result.passed).toBe(false);
    expect(result.argumentMismatches).toEqual([
      { toolName: "add", expectedArgs: {}, actualArgs: { a: 1 } },
    ]);
  });

  it("matches regardless of top-level key order", () => {
    const result = evaluateToolCalls(
      [tc("add", { a: 1, b: 2 })],
      [tc("add", { b: 2, a: 1 })],
      { argumentMatching: "exact" },
    );
    expect(result.passed).toBe(true);
  });

  it("matches regardless of nested object key order", () => {
    const result = evaluateToolCalls(
      [tc("save", { meta: { x: 1, y: 2 } })],
      [tc("save", { meta: { y: 2, x: 1 } })],
      { argumentMatching: "exact" },
    );
    expect(result.passed).toBe(true);
  });
});

describe("evaluateToolCalls — argumentMatching: ignore", () => {
  it("matches purely by tool name", () => {
    const result = evaluateToolCalls(
      [tc("add", { a: 1 })],
      [tc("add", { a: 99 })],
      { argumentMatching: "ignore" },
    );
    expect(result.passed).toBe(true);
    expect(result.argumentMismatches).toEqual([]);
  });
});

describe("evaluateToolCalls — negative tests", () => {
  it("passes when no tools were called", () => {
    expect(
      evaluateToolCalls([], [], { isNegativeTest: true }).passed,
    ).toBe(true);
  });

  it("fails when a tool was called", () => {
    const result = evaluateToolCalls([], [tc("a")], {
      isNegativeTest: true,
    });
    expect(result.passed).toBe(false);
    expect(result.extra.map((c) => c.toolName)).toEqual(["a"]);
  });
});

describe("MATCH_OPTIONS_DEFAULTS", () => {
  it("matches the inline defaults documented for evaluateToolCalls", () => {
    expect(MATCH_OPTIONS_DEFAULTS).toEqual({
      toolCallOrder: "ignore",
      allowExtraToolCalls: true,
      argumentMatching: "partial",
    });
  });
});

describe("resolveMatchOptions precedence", () => {
  it("returns defaults when every layer is undefined", () => {
    expect(resolveMatchOptions()).toEqual(MATCH_OPTIONS_DEFAULTS);
  });

  it("suite < case < run override", () => {
    const merged = resolveMatchOptions(
      { toolCallOrder: "strict" },
      { argumentMatching: "exact" },
      { allowExtraToolCalls: false },
    );
    expect(merged).toEqual({
      toolCallOrder: "strict",
      argumentMatching: "exact",
      allowExtraToolCalls: false,
    });
  });

  it("run override wins over case override on overlapping fields", () => {
    const merged = resolveMatchOptions(
      undefined,
      { toolCallOrder: "ignore", argumentMatching: "exact" },
      { toolCallOrder: "strict" },
    );
    expect(merged.toolCallOrder).toBe("strict");
    expect(merged.argumentMatching).toBe("exact");
  });

  it("case override wins over suite default on overlapping fields", () => {
    const merged = resolveMatchOptions(
      { allowExtraToolCalls: true },
      { allowExtraToolCalls: false },
      undefined,
    );
    expect(merged.allowExtraToolCalls).toBe(false);
  });

  it("treats explicit undefined fields as inherit (does not clobber lower layers)", () => {
    const merged = resolveMatchOptions(
      { toolCallOrder: "strict" },
      { toolCallOrder: undefined, argumentMatching: "exact" },
      undefined,
    );
    expect(merged.toolCallOrder).toBe("strict");
    expect(merged.argumentMatching).toBe("exact");
  });
});
