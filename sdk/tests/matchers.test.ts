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

  it("reports extra calls but does NOT fail when maxExtraToolCalls is default-null", () => {
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

describe("evaluateToolCalls — trajectory verification fixtures from the plan", () => {
  // E = [A, B, C] with maxExtraToolCalls: null (default).
  const expected = [tc("A"), tc("B"), tc("C")];

  it("[A,B,C] passes all three modes", () => {
    const actual = [tc("A"), tc("B"), tc("C")];
    for (const mode of ["strict", "superset", "ignore"] as const) {
      expect(
        evaluateToolCalls(expected, actual, { toolCallOrder: mode }).passed,
      ).toBe(true);
    }
  });

  it("[A,X,B,C] passes superset and ignore; fails strict", () => {
    const actual = [tc("A"), tc("X"), tc("B"), tc("C")];
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "strict" }).passed,
    ).toBe(false);
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "superset" }).passed,
    ).toBe(true);
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "ignore" }).passed,
    ).toBe(true);
  });

  it("[C,B,A] passes ignore only", () => {
    const actual = [tc("C"), tc("B"), tc("A")];
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "strict" }).passed,
    ).toBe(false);
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "superset" }).passed,
    ).toBe(false);
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "ignore" }).passed,
    ).toBe(true);
  });

  it("[A,B] fails all three (C missing, regardless of order mode)", () => {
    const actual = [tc("A"), tc("B")];
    for (const mode of ["strict", "superset", "ignore"] as const) {
      const result = evaluateToolCalls(expected, actual, {
        toolCallOrder: mode,
      });
      expect(result.passed).toBe(false);
      expect(result.missing.map((c) => c.toolName)).toContain("C");
    }
  });

  it("[A,A,B,C] with maxExtraToolCalls:0 fails all (one extra A)", () => {
    const actual = [tc("A"), tc("A"), tc("B"), tc("C")];
    for (const mode of ["strict", "superset", "ignore"] as const) {
      expect(
        evaluateToolCalls(expected, actual, {
          toolCallOrder: mode,
          maxExtraToolCalls: 0,
        }).passed,
      ).toBe(false);
    }
  });

  it("[A,A,B,C] with maxExtraToolCalls:1 passes superset/ignore, fails strict (position mismatch)", () => {
    const actual = [tc("A"), tc("A"), tc("B"), tc("C")];
    expect(
      evaluateToolCalls(expected, actual, {
        toolCallOrder: "superset",
        maxExtraToolCalls: 1,
      }).passed,
    ).toBe(true);
    expect(
      evaluateToolCalls(expected, actual, {
        toolCallOrder: "ignore",
        maxExtraToolCalls: 1,
      }).passed,
    ).toBe(true);
    expect(
      evaluateToolCalls(expected, actual, {
        toolCallOrder: "strict",
        maxExtraToolCalls: 1,
      }).passed,
    ).toBe(false);
  });
});

describe("evaluateToolCalls — duplicate handling fixtures from the plan", () => {
  const expected = [tc("A"), tc("A"), tc("B")];

  it("E=[A,A,B] vs A=[A,B] fails all three (second A missing)", () => {
    const actual = [tc("A"), tc("B")];
    for (const mode of ["strict", "superset", "ignore"] as const) {
      const result = evaluateToolCalls(expected, actual, {
        toolCallOrder: mode,
      });
      expect(result.passed).toBe(false);
      expect(result.missing.map((c) => c.toolName)).toContain("A");
    }
  });

  it("E=[A,A,B] vs A=[A,A,B] passes all three with extras=0", () => {
    const actual = [tc("A"), tc("A"), tc("B")];
    for (const mode of ["strict", "superset", "ignore"] as const) {
      const result = evaluateToolCalls(expected, actual, {
        toolCallOrder: mode,
        maxExtraToolCalls: 0,
      });
      expect(result.passed).toBe(true);
      expect(result.extra).toEqual([]);
    }
  });

  it("E=[A,A,B] vs A=[B,A,A] passes ignore, fails strict and superset", () => {
    const actual = [tc("B"), tc("A"), tc("A")];
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "ignore" }).passed,
    ).toBe(true);
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "strict" }).passed,
    ).toBe(false);
    expect(
      evaluateToolCalls(expected, actual, { toolCallOrder: "superset" }).passed,
    ).toBe(false);
  });
});

describe("evaluateToolCalls — maxExtraToolCalls boundary", () => {
  it("null: unlimited extras allowed", () => {
    const result = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b"), tc("c"), tc("d")],
      { maxExtraToolCalls: null },
    );
    expect(result.passed).toBe(true);
    expect(result.extra).toHaveLength(3);
  });

  it("0: no extras allowed (strict-extras gate)", () => {
    const result = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b")],
      { maxExtraToolCalls: 0 },
    );
    expect(result.passed).toBe(false);
    expect(result.extra.map((c) => c.toolName)).toEqual(["b"]);
  });

  it("N=2: up to two extras allowed, three fails", () => {
    const pass = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b"), tc("c")],
      { maxExtraToolCalls: 2 },
    );
    expect(pass.passed).toBe(true);

    const fail = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b"), tc("c"), tc("d")],
      { maxExtraToolCalls: 2 },
    );
    expect(fail.passed).toBe(false);
  });

  it("evaluated independently of toolCallOrder", () => {
    // 1 expected, 2 actuals → 1 extra. Should fail with cap=0 even in
    // ignore (any-order) mode.
    const result = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b")],
      { toolCallOrder: "ignore", maxExtraToolCalls: 0 },
    );
    expect(result.passed).toBe(false);
  });
});

describe("evaluateToolCalls — maxExtraToolCalls runtime validation", () => {
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws on invalid value %p",
    (value) => {
      expect(() =>
        evaluateToolCalls([tc("a")], [tc("a")], {
          maxExtraToolCalls: value as number,
        }),
      ).toThrow(/Invalid maxExtraToolCalls/);
    },
  );

  it("accepts 0, 1, and null without throwing", () => {
    for (const v of [0, 1, 100, null] as Array<number | null>) {
      expect(() =>
        evaluateToolCalls([tc("a")], [tc("a")], { maxExtraToolCalls: v }),
      ).not.toThrow();
    }
  });
});

describe("evaluateToolCalls — legacy allowExtraToolCalls shim", () => {
  it("true translates to null (unlimited)", () => {
    const result = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b"), tc("c")],
      { allowExtraToolCalls: true },
    );
    expect(result.passed).toBe(true);
  });

  it("false translates to 0 (strict, no extras)", () => {
    const result = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b")],
      { allowExtraToolCalls: false },
    );
    expect(result.passed).toBe(false);
    expect(result.extra.map((c) => c.toolName)).toEqual(["b"]);
  });

  it("explicit maxExtraToolCalls wins over legacy allowExtraToolCalls", () => {
    // maxExtraToolCalls: 2 (pass) vs allowExtraToolCalls: false (would
    // become 0 → fail). The explicit field must win.
    const result = evaluateToolCalls(
      [tc("a")],
      [tc("a"), tc("b"), tc("c")],
      { allowExtraToolCalls: false, maxExtraToolCalls: 2 },
    );
    expect(result.passed).toBe(true);
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
  });

  it("fails when calls are reversed", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("b")],
      [tc("b"), tc("a")],
      { toolCallOrder: "strict" },
    );
    expect(result.passed).toBe(false);
    expect(result.missing.map((c) => c.toolName).sort()).toEqual(["a", "b"]);
  });

  it("does not flag absences as out-of-order", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("b"), tc("c")],
      [tc("a"), tc("c")],
      { toolCallOrder: "strict" },
    );
    // strict: index 0 matches (a==a). index 1 fails (b vs c). index 2 is
    // out of range → missing. `b` and `c` are both missing.
    expect(result.missing.map((c) => c.toolName).sort()).toEqual(["b", "c"]);
    expect(result.outOfOrder).toEqual([]);
  });
});

describe("evaluateToolCalls — toolCallOrder: superset", () => {
  it("allows gaps between expected calls", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("c")],
      [tc("a"), tc("b"), tc("c")],
      { toolCallOrder: "superset" },
    );
    expect(result.passed).toBe(true);
    expect(result.extra.map((c) => c.toolName)).toEqual(["b"]);
  });

  it("rejects reversed actual (cursor cannot backtrack)", () => {
    const result = evaluateToolCalls(
      [tc("a"), tc("b")],
      [tc("b"), tc("a")],
      { toolCallOrder: "superset" },
    );
    expect(result.passed).toBe(false);
  });

  it("diagnostics pass preserves the superset cursor with argumentMatching:ignore", () => {
    // E=[a,b], A=[b,a]: pass 1 pairs E[0]=a with A[1]=a (cursor advances
    // past A[0]=b). E[1]=b is unpaired. With the cursor preserved into
    // pass 2 we must NOT pair E[1]=b against A[0]=b (which sits BEFORE
    // the prior successful match at A[1]) — that pairing would
    // misrepresent the trajectory. So b stays "missing" (unmatched
    // expected) and the leading A[0]=b shows up as "extra".
    const result = evaluateToolCalls(
      [tc("a"), tc("b")],
      [tc("b"), tc("a")],
      { toolCallOrder: "superset", argumentMatching: "ignore" },
    );
    expect(result.passed).toBe(false);
    expect(result.missing.map((c) => c.toolName)).toEqual(["b"]);
    expect(result.extra.map((c) => c.toolName)).toEqual(["b"]);
    // The b in argumentMismatches would only appear if pass 2 wrongly
    // paired E[1]=b against A[0]=b — assert it didn't.
    expect(result.argumentMismatches).toEqual([]);
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
      maxExtraToolCalls: null,
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
      { maxExtraToolCalls: 0 },
    );
    expect(merged).toEqual({
      toolCallOrder: "strict",
      argumentMatching: "exact",
      maxExtraToolCalls: 0,
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
      { maxExtraToolCalls: null },
      { maxExtraToolCalls: 0 },
      undefined,
    );
    expect(merged.maxExtraToolCalls).toBe(0);
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

  it("supports the new superset trajectory mode", () => {
    const merged = resolveMatchOptions(
      undefined,
      undefined,
      { toolCallOrder: "superset" },
    );
    expect(merged.toolCallOrder).toBe("superset");
  });

  it("LEGACY: shims allowExtraToolCalls → maxExtraToolCalls on each layer", () => {
    const allowTrue = resolveMatchOptions({ allowExtraToolCalls: true });
    expect(allowTrue.maxExtraToolCalls).toBeNull();

    const allowFalse = resolveMatchOptions({ allowExtraToolCalls: false });
    expect(allowFalse.maxExtraToolCalls).toBe(0);
  });

  it("LEGACY: explicit maxExtraToolCalls wins over allowExtraToolCalls on the same layer", () => {
    const merged = resolveMatchOptions({
      allowExtraToolCalls: false,
      maxExtraToolCalls: 3,
    });
    expect(merged.maxExtraToolCalls).toBe(3);
  });
});
