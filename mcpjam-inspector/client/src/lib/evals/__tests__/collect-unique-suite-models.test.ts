import { describe, expect, it } from "vitest";
import { collectUniqueModelsFromTestCases } from "../collect-unique-suite-models";

describe("collectUniqueModelsFromTestCases", () => {
  it("returns default Haiku when no test cases", () => {
    expect(collectUniqueModelsFromTestCases(null)).toEqual([
      { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
    ]);
    expect(collectUniqueModelsFromTestCases([])).toEqual([
      { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
    ]);
  });

  it("dedupes provider:model keys and preserves order", () => {
    const out = collectUniqueModelsFromTestCases([
      {
        _id: "a",
        testSuiteId: "s",
        createdBy: "u",
        title: "t",
        query: "",
        models: [
          { model: "m1", provider: "p1" },
          { model: "m2", provider: "p2" },
          { model: "m1", provider: "p1" },
        ],
        runs: 1,
        expectedToolCalls: [],
      },
    ]);
    expect(out).toEqual([
      { model: "m1", provider: "p1" },
      { model: "m2", provider: "p2" },
    ]);
  });

  it("falls back when suite cases have no models", () => {
    const out = collectUniqueModelsFromTestCases([
      {
        _id: "a",
        testSuiteId: "s",
        createdBy: "u",
        title: "t",
        query: "",
        models: [],
        runs: 1,
        expectedToolCalls: [],
      },
    ]);
    expect(out[0]?.provider).toBe("anthropic");
  });
});
