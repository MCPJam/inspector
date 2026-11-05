import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  buildCreateCasePayload,
  buildUpdateCasePayload,
  normalizeCasePredicates,
} from "../case-save-payload";

const promptOnly: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Sketch a two-node flow" },
];
const withTool: TestStep[] = [
  ...promptOnly,
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "create_view",
      args: { args: {} },
    },
  },
];

describe("buildUpdateCasePayload", () => {
  it("sends the expected outcome as written and clears it with an empty string", () => {
    const payload = buildUpdateCasePayload(
      { title: "Flow", steps: promptOnly, expectedOutput: "  Two boxes  " },
      "case-1",
    );
    expect(payload.expectedOutput).toBe("Two boxes");
    expect(
      buildUpdateCasePayload({ title: "Flow", steps: promptOnly }, "case-1")
        .expectedOutput,
    ).toBe("");
  });

  it("clears stored overrides with null and leaves other fields out", () => {
    const payload = buildUpdateCasePayload(
      { title: "Flow", steps: promptOnly },
      "case-1",
    );
    expect(payload).toMatchObject({
      testCaseId: "case-1",
      predicates: null,
      judgeConfigOverride: null,
    });
    expect(payload).not.toHaveProperty("matchOptions");
    expect(payload).not.toHaveProperty("models");
    expect(payload).not.toHaveProperty("query");
  });

  it("drops a negative-test flag once the case asserts a tool call", () => {
    expect(
      buildUpdateCasePayload(
        { title: "Flow", steps: withTool, isNegativeTest: true },
        "case-1",
      ).isNegativeTest,
    ).toBe(false);
    expect(
      buildUpdateCasePayload(
        { title: "Flow", steps: promptOnly, isNegativeTest: true },
        "case-1",
      ).isNegativeTest,
    ).toBe(true);
  });
});

describe("buildCreateCasePayload", () => {
  it("derives the display fields the create mutation requires", () => {
    const payload = buildCreateCasePayload(
      { title: "  ", steps: withTool },
      { suiteId: "suite-1", caseId: "c_1", models: [], runs: 5 },
    );
    expect(payload).toMatchObject({
      suiteId: "suite-1",
      caseId: "c_1",
      title: "Untitled test case",
      query: "Sketch a two-node flow",
      runs: 5,
    });
    expect(payload.expectedToolCalls).toEqual([
      expect.objectContaining({ toolName: "create_view" }),
    ]);
    expect(payload).not.toHaveProperty("predicates");
  });
});

describe("normalizeCasePredicates", () => {
  it("empties the list of an inheriting envelope", () => {
    expect(
      normalizeCasePredicates({
        mode: "inherit",
        list: [{ type: "noToolErrors" }],
      }),
    ).toEqual({ mode: "inherit", list: [] });
  });
});
