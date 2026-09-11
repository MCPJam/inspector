import { expect, it } from "vitest";
import { normalizeGeneratedDraft } from "../normalize-generated-draft";
import type { CreateEvalTestCaseInput } from "../generate-and-persist-tests";

const input: CreateEvalTestCaseInput = {
  title: "Find issue",
  suiteId: "s",
  query: "",
  models: [],
  runs: 1,
  isNegativeTest: false,
  expectedToolCalls: [],
  expectedOutput: " Issue details ",
  steps: [
    { id: "p1", kind: "prompt", prompt: "Find an issue" },
    {
      id: "a1",
      kind: "assert",
      assertion: { type: "toolCalledAtLeastOnce", toolName: "search" },
    },
    { id: "p2", kind: "prompt", prompt: "Show details for that issue" },
    {
      id: "a2",
      kind: "assert",
      assertion: { type: "toolCalledAtLeastOnce", toolName: "get" },
    },
  ],
};
it("preserves discovery prompts and inherits defaults with one extra assertion", () => {
  const draft = normalizeGeneratedDraft(input, [
    { type: "toolCalledAtLeastOnce", toolName: "search" },
  ]);
  expect(draft.steps?.map((step) => step.id)).toEqual(["p1", "p2", "a2"]);
  expect(draft.predicates).toEqual({ mode: "inherit", list: [] });
  expect(draft.expectedOutput).toBe("Issue details");
  expect(draft.query).toBeTruthy();
  expect(input.steps).toHaveLength(4);
});
it("shares the assertion budget across steps and case predicates without replacing defaults", () => {
  const draft = normalizeGeneratedDraft({
    ...input,
    predicates: {
      mode: "replace",
      list: [{ type: "toolCalledAtLeastOnce", toolName: "extra" }],
    },
  });
  expect(draft.steps?.filter((step) => step.kind === "assert")).toHaveLength(1);
  expect(draft.predicates).toEqual({ mode: "inherit", list: [] });
});
it("extends suite defaults when only a case-level assertion is present", () => {
  const draft = normalizeGeneratedDraft({
    ...input,
    steps: input.steps?.filter((step) => step.kind === "prompt"),
    predicates: {
      mode: "replace",
      list: [{ type: "toolCalledAtLeastOnce", toolName: "get" }],
    },
  });
  expect(draft.predicates).toEqual({
    mode: "extend",
    list: [{ type: "toolCalledAtLeastOnce", toolName: "get" }],
  });
});
it("rejects empty prompt or outcome instead of staging incomplete drafts", () => {
  expect(() =>
    normalizeGeneratedDraft({ ...input, expectedOutput: " " }),
  ).toThrow(/user prompt and expected outcome/);
  expect(() => normalizeGeneratedDraft({ ...input, steps: [] })).toThrow(
    /user prompt and expected outcome/,
  );
});
