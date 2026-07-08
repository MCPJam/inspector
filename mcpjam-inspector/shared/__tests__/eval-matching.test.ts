import { describe, it, expect } from "vitest";
import {
  appendToolCallsForPrompt,
  argumentsMatch,
  matchToolCalls,
  resolveCasePredicates,
  resolveCaseSuccessPredicates,
  resolveExtrasCap,
  summarizeRenderObservations,
  mergeToolCallsByPromptIndex,
  widgetCallToToolCall,
  widgetToolCallsByPromptIndex,
  widgetToolCallsToToolCalls,
  type ToolCall,
  type Predicate,
  type CasePredicates,
} from "../eval-matching.js";
import type {
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "../eval-trace.js";

describe("argumentsMatch", () => {
  it("returns true for empty expected args", () => {
    expect(argumentsMatch({}, { foo: "bar" })).toBe(true);
  });

  it("returns true when all expected keys match", () => {
    expect(
      argumentsMatch(
        { name: "test", value: 123 },
        { name: "test", value: 123, extra: "ignored" },
      ),
    ).toBe(true);
  });

  it("returns false when a key value differs", () => {
    expect(argumentsMatch({ name: "test" }, { name: "different" })).toBe(false);
  });

  it("returns false when expected key is missing from actual", () => {
    expect(argumentsMatch({ name: "test" }, {})).toBe(false);
  });

  it("handles nested objects", () => {
    expect(
      argumentsMatch(
        { config: { nested: true } },
        { config: { nested: true } },
      ),
    ).toBe(true);

    expect(
      argumentsMatch(
        { config: { nested: true } },
        { config: { nested: false } },
      ),
    ).toBe(false);
  });

  it("handles arrays", () => {
    expect(argumentsMatch({ items: [1, 2, 3] }, { items: [1, 2, 3] })).toBe(
      true,
    );

    expect(argumentsMatch({ items: [1, 2, 3] }, { items: [1, 2] })).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(argumentsMatch({ value: null }, { value: null })).toBe(true);
    expect(argumentsMatch({ value: null }, { value: undefined })).toBe(false);
  });

  it("treats simple type placeholder strings as wildcard type checks", () => {
    expect(
      argumentsMatch(
        { text: "string", count: "number", ok: "boolean" },
        { text: "hello", count: 3, ok: false },
      ),
    ).toBe(true);
    expect(
      argumentsMatch(
        { payload: "object", items: "array", anything: "any" },
        { payload: { nested: true }, items: [1, 2], anything: "x" },
      ),
    ).toBe(true);
    expect(argumentsMatch({ text: "string" }, { text: 3 })).toBe(false);
  });
});

describe("matchToolCalls", () => {
  describe("negative tests (isNegativeTest=true)", () => {
    it("passes when no tools are called", () => {
      const result = matchToolCalls([], [], true);
      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.unexpected).toEqual([]);
      expect(result.argumentMismatches).toEqual([]);
    });

    it("fails when tools are called", () => {
      const actual: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const result = matchToolCalls([], actual, true);
      expect(result.passed).toBe(false);
      expect(result.unexpected).toEqual(actual);
    });
  });

  describe("positive tests (default)", () => {
    it("fails when no tools are called but some expected", () => {
      const expected: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const result = matchToolCalls(expected, []);
      expect(result.passed).toBe(false);
      expect(result.missing).toEqual(expected);
    });

    it("passes with exact tool match and matching arguments", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/test.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/test.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.unexpected).toEqual([]);
      expect(result.argumentMismatches).toEqual([]);
    });

    it("passes when expected has empty args (matches any)", () => {
      const expected: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/anything.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });

    it("passes when actual has extra args beyond expected", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/test.txt" } },
      ];
      const actual: ToolCall[] = [
        {
          toolName: "read_file",
          arguments: { path: "/test.txt", extra: "value" },
        },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });

    it("reports missing tool calls", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: {} },
        { toolName: "write_file", arguments: {} },
      ];
      const actual: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(false);
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0].toolName).toBe("write_file");
    });

    it("reports unexpected tool calls", () => {
      const expected: ToolCall[] = [{ toolName: "read_file", arguments: {} }];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: {} },
        { toolName: "delete_file", arguments: {} },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true); // unexpected doesn't fail the test
      expect(result.unexpected).toHaveLength(1);
      expect(result.unexpected[0].toolName).toBe("delete_file");
    });

    it("reports argument mismatches", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/expected.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/actual.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(false);
      expect(result.argumentMismatches).toHaveLength(1);
      expect(result.argumentMismatches[0]).toEqual({
        toolName: "read_file",
        expectedArgs: { path: "/expected.txt" },
        actualArgs: { path: "/actual.txt" },
      });
    });

    it("passes when expected arguments use placeholder types", () => {
      const expected: ToolCall[] = [
        { toolName: "create_view", arguments: { elements: "string" } },
      ];
      const actual: ToolCall[] = [
        {
          toolName: "create_view",
          arguments: { elements: '[{"type":"rectangle"}]' },
        },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
      expect(result.argumentMismatches).toEqual([]);
    });

    it("handles multiple tool calls with some matching", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/a.txt" } },
        { toolName: "write_file", arguments: { path: "/b.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/a.txt" } },
        { toolName: "write_file", arguments: { path: "/c.txt" } }, // wrong path
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(false);
      expect(result.missing).toEqual([]);
      expect(result.argumentMismatches).toHaveLength(1);
      expect(result.argumentMismatches[0].toolName).toBe("write_file");
    });

    it("handles duplicate tool names with different args", () => {
      const expected: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/first.txt" } },
        { toolName: "read_file", arguments: { path: "/second.txt" } },
      ];
      const actual: ToolCall[] = [
        { toolName: "read_file", arguments: { path: "/first.txt" } },
        { toolName: "read_file", arguments: { path: "/second.txt" } },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });

    it("handles null/undefined inputs gracefully", () => {
      // @ts-expect-error - testing runtime behavior
      const result1 = matchToolCalls(null, []);
      expect(result1.passed).toBe(false);
      expect(result1.missing).toEqual([]);

      // @ts-expect-error - testing runtime behavior
      const result2 = matchToolCalls([], null);
      expect(result2.passed).toBe(false);
    });

    it("matches tools regardless of order", () => {
      const expected: ToolCall[] = [
        { toolName: "tool_a", arguments: {} },
        { toolName: "tool_b", arguments: {} },
      ];
      const actual: ToolCall[] = [
        { toolName: "tool_b", arguments: {} },
        { toolName: "tool_a", arguments: {} },
      ];
      const result = matchToolCalls(expected, actual);
      expect(result.passed).toBe(true);
    });
  });
});

describe("resolveCasePredicates", () => {
  const suiteDefault: Predicate[] = [
    { type: "noToolErrors" } as unknown as Predicate,
  ];
  const caseList: Predicate[] = [
    { type: "toolCalledAtLeastOnce", toolName: "search" } as unknown as Predicate,
  ];

  it("returns undefined when both suite defaults and case envelope are absent", () => {
    expect(resolveCasePredicates(undefined, undefined)).toBeUndefined();
  });

  it("returns suite defaults when no case envelope is supplied", () => {
    expect(resolveCasePredicates(suiteDefault, undefined)).toEqual(suiteDefault);
  });

  it("returns suite defaults under inherit mode and ignores case list", () => {
    const override: CasePredicates = { mode: "inherit", list: caseList };
    expect(resolveCasePredicates(suiteDefault, override)).toEqual(suiteDefault);
  });

  it("returns the case list alone under replace mode", () => {
    const override: CasePredicates = { mode: "replace", list: caseList };
    expect(resolveCasePredicates(suiteDefault, override)).toEqual(caseList);
  });

  it("concatenates defaults followed by case list under extend mode", () => {
    const override: CasePredicates = { mode: "extend", list: caseList };
    expect(resolveCasePredicates(suiteDefault, override)).toEqual([
      ...suiteDefault,
      ...caseList,
    ]);
  });

  it("collapses an empty effective list to undefined", () => {
    const override: CasePredicates = { mode: "replace", list: [] };
    expect(resolveCasePredicates(undefined, override)).toBeUndefined();
  });
});

describe("resolveCaseSuccessPredicates", () => {
  const suiteDefault: Predicate[] = [
    { type: "noToolErrors" } as unknown as Predicate,
  ];
  const caseList: Predicate[] = [
    { type: "toolCalledAtLeastOnce", toolName: "search" } as unknown as Predicate,
  ];
  const legacyList: Predicate[] = [
    { type: "toolCalledAtLeastOnce", toolName: "legacy" } as unknown as Predicate,
  ];
  const runList: Predicate[] = [
    { type: "toolCalledAtLeastOnce", toolName: "run" } as unknown as Predicate,
  ];

  it("returns run override when present, ignoring everything else", () => {
    expect(
      resolveCaseSuccessPredicates({
        suiteDefaults: suiteDefault,
        runOverride: runList,
        envelope: { mode: "replace", list: caseList },
        legacyCase: legacyList,
      }),
    ).toEqual(runList);
  });

  it("treats an empty replace envelope as an explicit opt-out — must NOT fall back to legacy or suite defaults", () => {
    expect(
      resolveCaseSuccessPredicates({
        suiteDefaults: suiteDefault,
        envelope: { mode: "replace", list: [] },
        legacyCase: legacyList,
      }),
    ).toBeUndefined();
  });

  it("treats an inherit envelope as authoritative (does not fall back to legacy)", () => {
    expect(
      resolveCaseSuccessPredicates({
        suiteDefaults: suiteDefault,
        envelope: { mode: "inherit", list: [] },
        legacyCase: legacyList,
      }),
    ).toEqual(suiteDefault);
  });

  it("uses legacy case predicates only when no envelope is supplied", () => {
    expect(
      resolveCaseSuccessPredicates({
        suiteDefaults: suiteDefault,
        legacyCase: legacyList,
      }),
    ).toEqual(legacyList);
  });

  it("legacy predicates win over suite defaults when no envelope is supplied", () => {
    expect(
      resolveCaseSuccessPredicates({
        suiteDefaults: suiteDefault,
        legacyCase: legacyList,
      }),
    ).toEqual(legacyList);
  });

  it("falls through to suite defaults when no per-case signal at all", () => {
    expect(
      resolveCaseSuccessPredicates({
        suiteDefaults: suiteDefault,
      }),
    ).toEqual(suiteDefault);
  });

  it("returns undefined when nothing is set anywhere", () => {
    expect(resolveCaseSuccessPredicates({ suiteDefaults: undefined })).toBeUndefined();
  });
});

describe("resolveExtrasCap", () => {
  it("returns null when matchOptions is absent", () => {
    expect(resolveExtrasCap(undefined)).toBeNull();
    expect(resolveExtrasCap(null)).toBeNull();
    expect(resolveExtrasCap({})).toBeNull();
  });

  it("returns the explicit maxExtraToolCalls when set (including 0 and null)", () => {
    expect(resolveExtrasCap({ maxExtraToolCalls: 0 })).toBe(0);
    expect(resolveExtrasCap({ maxExtraToolCalls: 3 })).toBe(3);
    expect(resolveExtrasCap({ maxExtraToolCalls: null })).toBeNull();
  });

  it("translates the legacy allowExtraToolCalls field when new field absent", () => {
    expect(resolveExtrasCap({ allowExtraToolCalls: false })).toBe(0);
    expect(resolveExtrasCap({ allowExtraToolCalls: true })).toBeNull();
  });

  it("prefers the new field over the legacy field when both are set", () => {
    expect(
      resolveExtrasCap({ maxExtraToolCalls: 5, allowExtraToolCalls: false }),
    ).toBe(5);
    expect(
      resolveExtrasCap({ maxExtraToolCalls: null, allowExtraToolCalls: false }),
    ).toBeNull();
  });
});

describe("summarizeRenderObservations", () => {
  const observation = (
    over: Partial<RunnerWidgetRenderObservation> = {},
  ): RunnerWidgetRenderObservation => ({
    toolCallId: "call-1",
    toolName: "show_map",
    serverId: "maps",
    status: "rendered",
    elapsedMs: 850,
    ts: 1700000000000,
    promptIndex: 0,
    ...over,
  });

  it("returns an empty array for absent/empty input", () => {
    expect(summarizeRenderObservations(undefined)).toEqual([]);
    expect(summarizeRenderObservations([])).toEqual([]);
  });

  it("keeps only the predicate-relevant fields and drops the screenshot", () => {
    const summaries = summarizeRenderObservations([
      observation({
        screenshotBase64: "aaaa",
        blockedRequests: ["https://blocked.example"],
        resourceUri: "ui://widget",
        consoleErrors: ["TypeError: boom"],
      }),
    ]);
    expect(summaries).toEqual([
      {
        toolCallId: "call-1",
        toolName: "show_map",
        serverId: "maps",
        status: "rendered",
        elapsedMs: 850,
        consoleErrors: ["TypeError: boom"],
      },
    ]);
  });

  it("omits consoleErrors when empty so absence stays meaningful", () => {
    const [summary] = summarizeRenderObservations([
      observation({ consoleErrors: [] }),
    ]);
    expect(summary).not.toHaveProperty("consoleErrors");
  });
});

describe("widget tool calls → transcript tool calls", () => {
  const step = (
    partial: Partial<RunnerBrowserInteractionStep>,
  ): RunnerBrowserInteractionStep => ({
    toolCallId: "tc",
    stepIndex: 0,
    promptIndex: 0,
    action: "left_click",
    elapsedMs: 1,
    ts: 0,
    ...partial,
  });

  it("widgetCallToToolCall maps name/args and coerces non-object args to {}", () => {
    expect(
      widgetCallToToolCall({ name: "checkout", args: { cartId: "c1" } }),
    ).toEqual({ toolName: "checkout", arguments: { cartId: "c1" } });
    // A non-object payload (sanitized `unknown`) must not corrupt arg matching.
    expect(widgetCallToToolCall({ name: "x", args: "oops" })).toEqual({
      toolName: "x",
      arguments: {},
    });
    expect(widgetCallToToolCall({ name: "y", args: null })).toEqual({
      toolName: "y",
      arguments: {},
    });
  });

  it("flattens widget calls across steps in order", () => {
    const calls = widgetToolCallsToToolCalls([
      step({
        widgetToolCalls: [
          { name: "a", args: {}, ok: true, elapsedMs: 1 },
          { name: "b", args: { k: 1 }, ok: true, elapsedMs: 1 },
        ],
      }),
      step({}), // no widget calls
      step({ widgetToolCalls: [{ name: "c", args: {}, ok: true, elapsedMs: 1 }] }),
    ]);
    expect(calls.map((c) => c.toolName)).toEqual(["a", "b", "c"]);
  });

  it("groups widget calls by promptIndex (sparse) and merges per turn without losing model calls", () => {
    const byPrompt = widgetToolCallsByPromptIndex([
      step({
        promptIndex: 2,
        widgetToolCalls: [{ name: "checkout", args: {}, ok: true, elapsedMs: 1 }],
      }),
    ]);
    expect(byPrompt[0]).toBeUndefined();
    expect(byPrompt[2]).toEqual([{ toolName: "checkout", arguments: {} }]);

    const model: ToolCall[][] = [[{ toolName: "search", arguments: {} }]];
    const merged = mergeToolCallsByPromptIndex(model, byPrompt);
    expect(merged[0]).toEqual([{ toolName: "search", arguments: {} }]);
    expect(merged[2]).toEqual([{ toolName: "checkout", arguments: {} }]);
  });
});

describe("appendToolCallsForPrompt", () => {
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
    toolName: name,
    arguments: args,
  });

  it("creates the bucket on first write for a fresh turn", () => {
    const buckets: ToolCall[][] = [];
    appendToolCallsForPrompt(buckets, 0, [call("search-products")]);
    expect(buckets[0]).toEqual([call("search-products")]);
  });

  it("folds a widget follow-up's calls INTO the parent turn's bucket", () => {
    // Parent authored turn (promptIndex 0) calls search-products; clicking the
    // cart fires a `ui/message` follow-up that REUSES promptIndex 0 and the
    // model calls view-cart. Both must land in bucket 0 — never an orphan slot.
    const buckets: ToolCall[][] = [];
    appendToolCallsForPrompt(buckets, 0, [call("search-products", { query: "redbull" })]);
    appendToolCallsForPrompt(buckets, 0, [call("view-cart")]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toEqual([
      call("search-products", { query: "redbull" }),
      call("view-cart"),
    ]);
  });

  it("keeps later authored turns aligned with their promptIndex despite a follow-up", () => {
    // Drive order: turn0, follow-up(of turn0), turn1. Without index-based
    // folding the follow-up would push an orphan slot and shift turn1's bucket.
    const buckets: ToolCall[][] = [];
    appendToolCallsForPrompt(buckets, 0, [call("t0")]);
    appendToolCallsForPrompt(buckets, 0, [call("t0-followup")]); // shares ordinal 0
    appendToolCallsForPrompt(buckets, 1, [call("t1")]);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual([call("t0"), call("t0-followup")]);
    expect(buckets[1]).toEqual([call("t1")]);
  });

  it("preserves an empty-bucket write so the turn index stays occupied", () => {
    const buckets: ToolCall[][] = [];
    appendToolCallsForPrompt(buckets, 0, []);
    expect(buckets[0]).toEqual([]);
  });

  it("is a no-op for a negative promptIndex (no active turn)", () => {
    const buckets: ToolCall[][] = [];
    appendToolCallsForPrompt(buckets, -1, [call("x")]);
    expect(buckets).toEqual([]);
  });
});
