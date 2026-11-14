import { describe, expect, it } from "vitest";
import type { EvalCase } from "@/components/evals/types";
import type { TestStep } from "@/shared/steps";
import { withFailOnToolError } from "@/shared/tool-error-policy";
import {
  isCaseStepsDirty,
  seedCaseStepsDraft,
} from "../case-steps/case-steps-seed";

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "List my workspaces" },
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "list_workspaces",
      args: { args: {} },
    },
  },
];

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    _id: "case-1",
    testSuiteId: "suite-1",
    createdBy: "u1",
    title: "List workspaces",
    query: "List my workspaces",
    models: [{ model: "gpt-5-nano", provider: "openai" }],
    runs: 2,
    expectedToolCalls: [],
    steps,
    ...overrides,
  };
}

describe("seedCaseStepsDraft", () => {
  it("reads the stored case into a draft", () => {
    const draft = seedCaseStepsDraft(
      makeCase({ expectedOutput: "Two workspaces", scenario: "Signed in" }),
    );
    expect(draft).toMatchObject({
      title: "List workspaces",
      runs: 2,
      scenario: "Signed in",
      steps,
      expectedOutput: "Two workspaces",
      toolsChoice: "tools",
    });
    expect(draft.stashedTools.map((tool) => tool.toolName)).toEqual([
      "list_workspaces",
    ]);
  });

  it("answers No tools for a stored negative case without tool asserts", () => {
    const draft = seedCaseStepsDraft(
      makeCase({ steps: [steps[0]], isNegativeTest: true }),
    );
    expect(draft.toolsChoice).toBe("noTool");
  });

  it("keeps the case's tool-error setting", () => {
    const draft = seedCaseStepsDraft(
      makeCase({ advancedConfig: { failOnToolError: false } }),
    );
    expect(draft.advancedConfig).toEqual({ failOnToolError: false });
  });
});

describe("isCaseStepsDirty", () => {
  it("is clean right after seeding", () => {
    const testCase = makeCase({ advancedConfig: { failOnToolError: false } });
    expect(isCaseStepsDirty(seedCaseStepsDraft(testCase), testCase)).toBe(
      false,
    );
  });

  it.each([
    ["the title", { title: "Renamed" }],
    ["the expected outcome", { expectedOutput: "One workspace" }],
    ["the steps", { steps: [steps[0]] }],
  ])("is dirty after editing %s", (_name, edit) => {
    const testCase = makeCase();
    const draft = { ...seedCaseStepsDraft(testCase), ...edit };
    expect(isCaseStepsDirty(draft, testCase)).toBe(true);
  });

  it("is dirty after turning the tool-error switch off or back on", () => {
    const on = makeCase();
    const off = makeCase({ advancedConfig: { failOnToolError: false } });
    const turnOff = seedCaseStepsDraft(on);
    turnOff.advancedConfig = withFailOnToolError(turnOff.advancedConfig, false);
    const turnOn = seedCaseStepsDraft(off);
    turnOn.advancedConfig = withFailOnToolError(turnOn.advancedConfig, true);
    expect(isCaseStepsDirty(turnOff, on)).toBe(true);
    expect(isCaseStepsDirty(turnOn, off)).toBe(true);
  });

  it("ignores whitespace around the outcome and scenario", () => {
    const testCase = makeCase({ expectedOutput: "Done", scenario: "" });
    const draft = {
      ...seedCaseStepsDraft(testCase),
      expectedOutput: "  Done  ",
      scenario: "   ",
    };
    expect(isCaseStepsDirty(draft, testCase)).toBe(false);
  });
});
