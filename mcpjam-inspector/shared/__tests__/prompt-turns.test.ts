import { describe, expect, it } from "vitest";
import {
  flattenAssertedExpectedToolCalls,
  resolveIterationDisplayExpectedToolCalls,
} from "../prompt-turns";

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
