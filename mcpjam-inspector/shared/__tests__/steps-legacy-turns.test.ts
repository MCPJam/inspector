import { describe, expect, it } from "vitest";
import {
  countModelTurns,
  flattenAssertedExpectedToolCalls,
  isPinnedOnly,
  isPinnedTurn,
  legacyProbeToPinnedTurn,
  turnsNeedModel,
  normalizePromptTurns,
  resolvePromptTurnsWithLegacyProbe,
} from "../steps";
import type { ProbeConfig } from "../probe-config";
import type { ScriptedWidgetCheck } from "../scripted-steps";

describe("flattenAssertedExpectedToolCalls", () => {
  it("returns empty for negative tests", () => {
    expect(
      flattenAssertedExpectedToolCalls({
        isNegativeTest: true,
        promptTurns: [
          {
            id: "1",
            prompt: "x",
            expectedToolCalls: [{ toolName: "a", arguments: {} }],
          },
        ],
      })
    ).toEqual([]);
  });

  it("concatenates asserted turns only (multi-turn)", () => {
    expect(
      flattenAssertedExpectedToolCalls({
        promptTurns: [
          {
            id: "1",
            prompt: "first",
            expectedToolCalls: [
              { toolName: "read_me", arguments: {} },
              { toolName: "create_view", arguments: {} },
            ],
          },
          {
            id: "2",
            prompt: "second",
            expectedToolCalls: [],
          },
          {
            id: "3",
            prompt: "third",
            expectedToolCalls: [
              { toolName: "save_checkpoint", arguments: { x: 1 } },
              { toolName: "read_checkpoint", arguments: { id: "c1" } },
            ],
          },
        ],
      })
    ).toEqual([
      { toolName: "read_me", arguments: {} },
      { toolName: "create_view", arguments: {} },
      { toolName: "save_checkpoint", arguments: { x: 1 } },
      { toolName: "read_checkpoint", arguments: { id: "c1" } },
    ]);
  });

  it("matches single-turn legacy query + expectedToolCalls", () => {
    expect(
      flattenAssertedExpectedToolCalls({
        query: "hello",
        expectedToolCalls: [{ toolName: "greet", arguments: {} }],
      })
    ).toEqual([{ toolName: "greet", arguments: {} }]);
  });
});

describe("pinned-turn selectors", () => {
  const probe: ProbeConfig = {
    serverName: "Weather",
    toolName: "show_map",
    arguments: { city: "SF" },
  };
  const promptTurn = { id: "1", prompt: "hi", expectedToolCalls: [] };
  const pinnedTurn = legacyProbeToPinnedTurn(probe);

  describe("isPinnedTurn", () => {
    it("is true only when pinnedToolCall is present", () => {
      expect(isPinnedTurn(pinnedTurn)).toBe(true);
      expect(isPinnedTurn(promptTurn)).toBe(false);
      expect(isPinnedTurn(null)).toBe(false);
      expect(isPinnedTurn(undefined)).toBe(false);
    });
  });

  describe("isPinnedOnly / turnsNeedModel", () => {
    it("treats legacy widget_probe as pinned-only (parity with caseType)", () => {
      expect(isPinnedOnly({ caseType: "widget_probe" })).toBe(true);
      expect(turnsNeedModel({ caseType: "widget_probe" })).toBe(false);
    });

    it("treats a normal prompt case as model-driven", () => {
      expect(
        isPinnedOnly({ caseType: "prompt", promptTurns: [promptTurn] })
      ).toBe(false);
      expect(isPinnedOnly({ promptTurns: [promptTurn] })).toBe(false);
      expect(turnsNeedModel({ promptTurns: [promptTurn] })).toBe(true);
    });

    it("does not classify an empty/absent turn list as pinned-only", () => {
      expect(isPinnedOnly({})).toBe(false);
      expect(isPinnedOnly({ promptTurns: [] })).toBe(false);
    });

    it("is pinned-only when every turn is pinned", () => {
      expect(isPinnedOnly({ promptTurns: [pinnedTurn] })).toBe(true);
      expect(isPinnedOnly({ promptTurns: [pinnedTurn, pinnedTurn] })).toBe(
        true
      );
    });

    it("is model-driven for a hybrid (pinned + prompt) case", () => {
      expect(isPinnedOnly({ promptTurns: [pinnedTurn, promptTurn] })).toBe(
        false
      );
      expect(turnsNeedModel({ promptTurns: [pinnedTurn, promptTurn] })).toBe(
        true
      );
    });

    it("is model-driven for a widget_probe that carries model prompt turns", () => {
      // Regression: a hybrid widget_probe must NOT route model-free (would throw
      // when the loop hits a model turn with no LLM setup).
      expect(
        isPinnedOnly({ caseType: "widget_probe", promptTurns: [promptTurn] })
      ).toBe(false);
      expect(
        turnsNeedModel({ caseType: "widget_probe", promptTurns: [promptTurn] })
      ).toBe(true);
    });

    it("is pinned-only for a legacy widget_probe with only empty placeholder turns", () => {
      // Regression (P3): a pre-migration widget_probe persisted with the
      // resolvePromptTurns fallback shape [{prompt:"",expectedToolCalls:[]}] is
      // still a pure probe — must stay model-free, not route to the model path.
      const placeholder = { id: "turn-1", prompt: "", expectedToolCalls: [] };
      expect(
        isPinnedOnly({ caseType: "widget_probe", promptTurns: [placeholder] })
      ).toBe(true);
      // But the same shape WITHOUT widget_probe is an unfilled prompt case.
      expect(isPinnedOnly({ promptTurns: [placeholder] })).toBe(false);
    });
  });

  describe("resolvePromptTurnsWithLegacyProbe", () => {
    it("surfaces a pure legacy probe's probeConfig as a single pinned turn", () => {
      const turns = resolvePromptTurnsWithLegacyProbe({
        caseType: "widget_probe",
        probeConfig: probe,
      });
      expect(turns).toHaveLength(1);
      expect(turns[0].pinnedToolCall).toEqual(probe);
    });

    it("does NOT clobber real prompt steps on a widget_probe row", () => {
      // Regression: a widget_probe that also has authored prompt turns must keep
      // them, not have the whole list replaced by the legacy pinned turn.
      const real = {
        id: "t1",
        prompt: "do the thing",
        expectedToolCalls: [{ toolName: "x", arguments: {} }],
      };
      const turns = resolvePromptTurnsWithLegacyProbe({
        caseType: "widget_probe",
        probeConfig: probe,
        promptTurns: [real],
      });
      expect(turns).toEqual([real]);
    });

    it("leaves a normal prompt case untouched", () => {
      const turns = resolvePromptTurnsWithLegacyProbe({
        promptTurns: [promptTurn],
      });
      expect(turns).toEqual([promptTurn]);
    });
  });

  describe("countModelTurns", () => {
    it("counts only non-pinned turns", () => {
      expect(countModelTurns([promptTurn, pinnedTurn, promptTurn])).toBe(2);
      expect(countModelTurns([pinnedTurn])).toBe(0);
      expect(countModelTurns(undefined)).toBe(0);
    });
  });

  describe("legacyProbeToPinnedTurn", () => {
    it("wraps a probe config as a single model-free turn", () => {
      expect(pinnedTurn).toEqual({
        id: "turn-1",
        prompt: "",
        expectedToolCalls: [],
        pinnedToolCall: probe,
      });
      // Copy, not alias — mutating the turn must not touch the source config.
      expect(pinnedTurn.pinnedToolCall).not.toBe(probe);
    });
  });
});

describe("normalizePromptTurns — widgetChecks preservation", () => {
  const widgetChecks: ScriptedWidgetCheck[] = [
    {
      toolName: "create_view",
      steps: [
        { kind: "click", target: { role: { role: "button", name: "Submit" } } },
        { kind: "type", target: { testId: "search" }, text: "hello" },
        { kind: "assert", assertion: { type: "textVisible", text: "Done" } },
      ],
    },
  ];

  it("survives normalization (not stripped) — valid on any turn", () => {
    const [turn] = normalizePromptTurns([
      {
        id: "t1",
        prompt: "Draw a dog",
        expectedToolCalls: [],
        widgetChecks,
      },
    ]);
    expect(turn.widgetChecks).toEqual(widgetChecks);
  });

  it("omits an empty widgetChecks array", () => {
    const [turn] = normalizePromptTurns([
      { id: "t1", prompt: "x", expectedToolCalls: [], widgetChecks: [] },
    ]);
    expect(turn.widgetChecks).toBeUndefined();
  });

  it("ignores a non-array widgetChecks value", () => {
    const [turn] = normalizePromptTurns([
      {
        id: "t1",
        prompt: "x",
        expectedToolCalls: [],
        widgetChecks: "nope" as unknown,
      },
    ]);
    expect(turn.widgetChecks).toBeUndefined();
  });
});
