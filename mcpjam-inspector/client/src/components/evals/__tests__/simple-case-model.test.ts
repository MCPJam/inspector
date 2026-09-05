import { describe, expect, it } from "vitest";
import {
  MATCH_OPTIONS_DEFAULTS,
  resolveMatchOptions,
} from "@/shared/eval-matching";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { type TestStep } from "@/shared/steps";
import {
  deriveCaseKind,
  displayCaseKind,
  EXCLUDED_FROM_MORE_CHECKS,
  initialToolsChoice,
  isSimpleCaseShape,
  matchOptionsForKind,
  MORE_CHECK_GROUPS,
  readSimpleCase,
  writeSimpleCase,
} from "../simple-case/simple-case-model";

const prompt = (id: string, text: string): TestStep => ({
  id,
  kind: "prompt",
  prompt: text,
});

const toolCalledWith = (
  id: string,
  toolName: string,
  args: Record<string, unknown> = {},
): TestStep => ({
  id,
  kind: "assert",
  assertion: {
    type: "toolCalledWith",
    toolName,
    args: { args },
  },
});

describe("deriveCaseKind", () => {
  it("reads capability from SDK defaults (no matchOptions, no migration)", () => {
    expect(deriveCaseKind(MATCH_OPTIONS_DEFAULTS)).toBe("capability");
    expect(deriveCaseKind(resolveMatchOptions())).toBe("capability");
  });

  it("reads regression from the strict-order + zero-extras pair", () => {
    expect(
      deriveCaseKind({
        toolCallOrder: "strict",
        maxExtraToolCalls: 0,
      }),
    ).toBe("regression");
  });

  it("does not treat argumentMatching as part of the discriminant", () => {
    expect(
      deriveCaseKind({
        toolCallOrder: "strict",
        maxExtraToolCalls: 0,
      }),
    ).toBe("regression");
    expect(
      deriveCaseKind({
        toolCallOrder: "ignore",
        maxExtraToolCalls: 0,
      }),
    ).toBe("capability");
    expect(
      deriveCaseKind({
        toolCallOrder: "strict",
        maxExtraToolCalls: null,
      }),
    ).toBe("capability");
  });

  it("resolves through suite defaults then case override", () => {
    expect(
      deriveCaseKind(
        resolveMatchOptions(
          { toolCallOrder: "strict", maxExtraToolCalls: 0 },
          undefined,
        ),
      ),
    ).toBe("regression");
    expect(
      deriveCaseKind(
        resolveMatchOptions(
          { toolCallOrder: "strict", maxExtraToolCalls: 0 },
          { toolCallOrder: "ignore" },
        ),
      ),
    ).toBe("capability");
    expect(
      deriveCaseKind(
        resolveMatchOptions(undefined, {
          toolCallOrder: "strict",
          maxExtraToolCalls: 0,
        }),
      ),
    ).toBe("regression");
  });

  it("lets a persisted kind win over derived matchOptions", () => {
    expect(displayCaseKind("regression", MATCH_OPTIONS_DEFAULTS)).toBe(
      "regression",
    );
    expect(
      displayCaseKind("capability", {
        toolCallOrder: "strict",
        maxExtraToolCalls: 0,
      }),
    ).toBe("capability");
    expect(displayCaseKind(undefined, MATCH_OPTIONS_DEFAULTS)).toBe(
      "capability",
    );
  });
});

describe("initialToolsChoice", () => {
  it("is unset for a prompt-only unfinished case", () => {
    expect(initialToolsChoice({ tools: [], isNegativeTest: false })).toBe(
      "unset",
    );
  });

  it("is noTool when the saved case is already negative", () => {
    expect(initialToolsChoice({ tools: [], isNegativeTest: true })).toBe(
      "noTool",
    );
  });

  it("is tools when toolCalledWith asserts exist", () => {
    expect(
      initialToolsChoice({
        tools: [{ id: "a1", toolName: "search", arguments: {} }],
      }),
    ).toBe("tools");
  });
});

describe("matchOptionsForKind", () => {
  it("writes capability as byte-identical MATCH_OPTIONS_DEFAULTS", () => {
    expect(matchOptionsForKind("capability")).toEqual(MATCH_OPTIONS_DEFAULTS);
  });

  it("writes regression as strict order, 0 extras, partial args", () => {
    expect(matchOptionsForKind("regression")).toEqual({
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
      argumentMatching: "partial",
    });
  });
});

describe("isSimpleCaseShape", () => {
  it("accepts a prompt-only case", () => {
    expect(isSimpleCaseShape([prompt("p1", "What is the status?")])).toBe(true);
  });

  it("accepts a prompt plus toolCalledWith asserts", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "List incidents"),
        toolCalledWith("a1", "list_incidents"),
        toolCalledWith("a2", "get_incident", { id: "1" }),
      ]),
    ).toBe(true);
  });

  it("rejects empty steps", () => {
    expect(isSimpleCaseShape([])).toBe(false);
  });

  it("rejects a toolCall step", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "c1",
          kind: "toolCall",
          serverName: "srv",
          toolName: "list_incidents",
          arguments: {},
        },
      ]),
    ).toBe(false);
  });

  it("rejects an interact step", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "i1",
          kind: "interact",
          toolName: "create_view",
          action: { kind: "click", target: { testId: "canvas" } },
        },
      ]),
    ).toBe(false);
  });

  it("rejects a widget assert", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "w1",
          kind: "assert",
          assertion: { kind: "textVisible", text: "ok" },
        },
      ]),
    ).toBe(false);
  });

  it("rejects a non-toolCalledWith inline predicate", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "go"),
        {
          id: "a1",
          kind: "assert",
          assertion: { type: "responseContains", needle: "ok" },
        },
      ]),
    ).toBe(false);
  });

  it("rejects a second prompt", () => {
    expect(
      isSimpleCaseShape([
        prompt("p1", "first"),
        toolCalledWith("a1", "search"),
        prompt("p2", "second"),
      ]),
    ).toBe(false);
  });
});

describe("readSimpleCase / writeSimpleCase", () => {
  it("round-trips prompt, tool ids, and args", () => {
    const steps: TestStep[] = [
      prompt("p1", "Find the latest incidents"),
      toolCalledWith("a1", "list_incidents", { limit: 5 }),
      toolCalledWith("a2", "get_incident", { id: "abc" }),
    ];
    const view = readSimpleCase(steps);
    expect(view).toEqual({
      prompt: "Find the latest incidents",
      noTool: false,
      tools: [
        { id: "a1", toolName: "list_incidents", arguments: { limit: 5 } },
        { id: "a2", toolName: "get_incident", arguments: { id: "abc" } },
      ],
    });
    expect(writeSimpleCase(steps, view)).toEqual(steps);
  });

  it("keeps step 0's id when rewriting the prompt", () => {
    const next = writeSimpleCase([prompt("turn-1", "old")], {
      prompt: "new",
      tools: [],
      noTool: false,
    });
    expect(next[0]).toEqual({ id: "turn-1", kind: "prompt", prompt: "new" });
  });

  it("noTool drops only toolCalledWith asserts", () => {
    const steps: TestStep[] = [
      prompt("p1", "Do not call anything"),
      toolCalledWith("a1", "search"),
      {
        id: "extra",
        kind: "assert",
        assertion: { type: "responseContains", needle: "ok" },
      },
    ];
    const next = writeSimpleCase(steps, {
      prompt: "Do not call anything",
      tools: [{ id: "a1", toolName: "search", arguments: {} }],
      noTool: true,
    });
    expect(next).toEqual([
      prompt("p1", "Do not call anything"),
      {
        id: "extra",
        kind: "assert",
        assertion: { type: "responseContains", needle: "ok" },
      },
    ]);
    expect(next.some((s) => s.id === "a1")).toBe(false);
  });

  it("reuses existing tool assert ids by index when ids are omitted", () => {
    const prev: TestStep[] = [
      prompt("p1", "go"),
      toolCalledWith("a1", "search", { q: "old" }),
    ];
    const next = writeSimpleCase(prev, {
      prompt: "go",
      noTool: false,
      tools: [{ toolName: "search", arguments: { q: "new" } }],
    });
    expect(next[1]).toEqual(toolCalledWith("a1", "search", { q: "new" }));
  });
});

describe("matchOptionsForKind carries argument matching over", () => {
  it("keeps an authored exact when the kind flips", () => {
    expect(
      matchOptionsForKind("regression", { argumentMatching: "exact" }),
    ).toEqual({
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
      argumentMatching: "exact",
    });
    expect(
      matchOptionsForKind("capability", { argumentMatching: "exact" }),
    ).toEqual({ ...MATCH_OPTIONS_DEFAULTS, argumentMatching: "exact" });
  });

  it("falls back to the SDK default without a current value", () => {
    expect(matchOptionsForKind("capability")).toEqual(MATCH_OPTIONS_DEFAULTS);
  });
});

describe("More checks groups partition the predicate catalog", () => {
  it("files every predicate kind exactly once, or excludes it on purpose", () => {
    const filed = new Map<string, string[]>();
    for (const group of MORE_CHECK_GROUPS) {
      for (const kind of group.kinds) {
        filed.set(kind, [...(filed.get(kind) ?? []), group.id]);
      }
    }
    for (const kind of Object.keys(PREDICATE_KIND_LABELS)) {
      const groups = filed.get(kind) ?? [];
      const excluded = EXCLUDED_FROM_MORE_CHECKS.has(
        kind as Parameters<typeof EXCLUDED_FROM_MORE_CHECKS.has>[0],
      );
      expect(
        { kind, groups, excluded },
        `predicate kind "${kind}" must be in exactly one More checks group or excluded on purpose`,
      ).toSatisfy(
        (entry: { groups: string[]; excluded: boolean }) =>
          (entry.groups.length === 1 && !entry.excluded) ||
          (entry.groups.length === 0 && entry.excluded),
      );
    }
    for (const kind of EXCLUDED_FROM_MORE_CHECKS) {
      expect(kind in PREDICATE_KIND_LABELS).toBe(true);
    }
  });
});
