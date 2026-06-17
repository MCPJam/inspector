import { describe, expect, it } from "vitest";
import {
  countModelTurns,
  flattenAssertedExpectedToolCalls,
  hasPinnedTurn,
  isPinnedOnly,
  isPinnedTurn,
  legacyProbeToPinnedTurn,
  needsModel,
  resolveIterationDisplayExpectedToolCalls,
} from "../prompt-turns";
import type { ProbeConfig } from "../probe-config";

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
      }),
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
      }),
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
      }),
    ).toEqual([{ toolName: "greet", arguments: {} }]);
  });
});

describe("resolveIterationDisplayExpectedToolCalls", () => {
  it("prefers snapshot over fallback", () => {
    expect(
      resolveIterationDisplayExpectedToolCalls(
        {
          promptTurns: [
            {
              id: "1",
              prompt: "a",
              expectedToolCalls: [{ toolName: "from_snap", arguments: {} }],
            },
          ],
        },
        {
          query: "b",
          expectedToolCalls: [{ toolName: "from_fallback", arguments: {} }],
        },
      ),
    ).toEqual([{ toolName: "from_snap", arguments: {} }]);
  });

  it("uses fallback when snapshot is missing", () => {
    expect(
      resolveIterationDisplayExpectedToolCalls(undefined, {
        query: "solo",
        expectedToolCalls: [{ toolName: "solo", arguments: { k: 1 } }],
      }),
    ).toEqual([{ toolName: "solo", arguments: { k: 1 } }]);
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

  describe("hasPinnedTurn", () => {
    it("detects a pinned turn anywhere in the list", () => {
      expect(hasPinnedTurn([promptTurn, pinnedTurn])).toBe(true);
      expect(hasPinnedTurn([promptTurn])).toBe(false);
      expect(hasPinnedTurn(undefined)).toBe(false);
      expect(hasPinnedTurn("not-an-array")).toBe(false);
    });
  });

  describe("isPinnedOnly / needsModel", () => {
    it("treats legacy widget_probe as pinned-only (parity with caseType)", () => {
      expect(isPinnedOnly({ caseType: "widget_probe" })).toBe(true);
      expect(needsModel({ caseType: "widget_probe" })).toBe(false);
    });

    it("treats a normal prompt case as model-driven", () => {
      expect(isPinnedOnly({ caseType: "prompt", promptTurns: [promptTurn] })).toBe(
        false,
      );
      expect(isPinnedOnly({ promptTurns: [promptTurn] })).toBe(false);
      expect(needsModel({ promptTurns: [promptTurn] })).toBe(true);
    });

    it("does not classify an empty/absent turn list as pinned-only", () => {
      expect(isPinnedOnly({})).toBe(false);
      expect(isPinnedOnly({ promptTurns: [] })).toBe(false);
    });

    it("is pinned-only when every turn is pinned", () => {
      expect(isPinnedOnly({ promptTurns: [pinnedTurn] })).toBe(true);
      expect(isPinnedOnly({ promptTurns: [pinnedTurn, pinnedTurn] })).toBe(true);
    });

    it("is model-driven for a hybrid (pinned + prompt) case", () => {
      expect(isPinnedOnly({ promptTurns: [pinnedTurn, promptTurn] })).toBe(false);
      expect(needsModel({ promptTurns: [pinnedTurn, promptTurn] })).toBe(true);
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
