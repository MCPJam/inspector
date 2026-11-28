import { describe, expect, it } from "vitest";
import type { CreateEvalTestCaseInput } from "@/lib/evals/generate-and-persist-tests";
import type { TestStep } from "@/shared/steps";
import {
  generatedDraftPatch,
  generatedDraftToSteps,
  stepsFormFields,
} from "../case-steps/draft-case-steps-model";

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Draw a box" },
  {
    id: "a1",
    kind: "assert",
    assertion: { type: "toolCalledAtLeastOnce", toolName: "create_view" },
  } as TestStep,
];
const input: CreateEvalTestCaseInput = {
  suiteId: "suite-1",
  title: "Draw a box",
  query: "Draw a box",
  models: [],
  expectedToolCalls: [],
  runs: 3,
  isNegativeTest: false,
  expectedOutput: "A box",
  steps,
};

describe("generatedDraftToSteps", () => {
  it("reads a generated draft like a stored case", () => {
    const draft = generatedDraftToSteps(input);
    expect(draft).toMatchObject({
      title: "Draw a box",
      runs: 3,
      steps,
      expectedOutput: "A box",
    });
    expect(draft.toolsChoice).not.toBe("noTool");
  });

  it("answers the tool question No tools for a negative draft", () => {
    expect(
      generatedDraftToSteps({
        ...input,
        isNegativeTest: true,
        steps: [steps[0]],
      }).toolsChoice,
    ).toBe("noTool");
  });
});

describe("generatedDraftPatch", () => {
  it("keeps what a save keeps and leaves out what a draft cannot store", () => {
    const draft = {
      ...generatedDraftToSteps(input),
      expectedOutput: "  A box  ",
      judgeConfigOverride: { goalCompletion: { enabled: false } },
      advancedConfig: { failOnToolError: false },
    };
    expect(generatedDraftPatch(draft)).toEqual({
      steps,
      expectedOutput: "A box",
      matchOptions: undefined,
      predicates: undefined,
      isNegativeTest: false,
    });
  });

  it("sends the negative flag from the tool question", () => {
    const draft = {
      ...generatedDraftToSteps(input),
      toolsChoice: "noTool" as const,
    };
    expect(generatedDraftPatch(draft).isNegativeTest).toBe(true);
  });
});

describe("stepsFormFields", () => {
  it("returns the fields the steps editor edits, not the title or runs", () => {
    const fields = stepsFormFields(generatedDraftToSteps(input));
    expect(Object.keys(fields).sort()).toEqual(
      [
        "advancedConfig",
        "expectedOutput",
        "judgeConfigOverride",
        "matchOptions",
        "predicates",
        "steps",
        "suppressedSuiteStandardCheckIds",
      ].sort(),
    );
  });
});
