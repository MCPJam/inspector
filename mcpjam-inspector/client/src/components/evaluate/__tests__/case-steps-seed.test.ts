import { describe, expect, it } from "vitest";
import { buildCaseSavePayload } from "@/components/evals/case-save-payload";
import type { EvalCase } from "@/components/evals/types";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import { withFailOnToolError } from "@/shared/tool-error-policy";
import {
  addCasePredicate,
  chooseNoTool,
  setCasePredicates,
  setEnvelopeMode,
  type CaseStepsDraft,
} from "../case-steps/case-step-edits";
import {
  isCaseStepsDirty,
  seedCaseStepsDraft,
} from "../case-steps/case-steps-seed";
import { matchOptionsForKind } from "../simple-case/simple-case-model";

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
      stashedTools: [],
    });
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
    ["the trials", { runs: 5 }],
    ["the expected outcome", { expectedOutput: "One workspace" }],
    ["the steps", { steps: [steps[0]] }],
  ])("is dirty after editing %s", (_name, edit) => {
    const testCase = makeCase();
    const draft = { ...seedCaseStepsDraft(testCase), ...edit };
    expect(isCaseStepsDirty(draft, testCase)).toBe(true);
  });

  it("is clean for a case with no stored trials", () => {
    const testCase = makeCase({ runs: undefined });
    expect(isCaseStepsDirty(seedCaseStepsDraft(testCase), testCase)).toBe(
      false,
    );
  });

  it("leaves the stash empty: only No tools fills it", () => {
    expect(seedCaseStepsDraft(makeCase()).stashedTools).toEqual([]);
    const parked = chooseNoTool(seedCaseStepsDraft(makeCase()));
    expect(parked.stashedTools.map((tool) => tool.id)).toEqual(["a1"]);
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

  it("treats a field set to undefined like the saved case without it", () => {
    const callStep = {
      id: "c1",
      kind: "toolCall",
      serverName: "workspaces",
      toolName: "list_workspaces",
      arguments: {},
    } as unknown as TestStep;
    const testCase = makeCase({ steps: [...steps, callStep] });
    const edited = {
      ...callStep,
      serverId: undefined,
      renderTimeoutMs: undefined,
    };
    const draft = {
      ...seedCaseStepsDraft(testCase),
      steps: [...steps, edited] as TestStep[],
    };
    expect(isCaseStepsDirty(draft, testCase)).toBe(false);
  });

  it("is dirty when a tool argument is set to null", () => {
    const testCase = makeCase();
    const withNull = steps.map((step) =>
      step.id === "a1" && step.kind === "assert"
        ? ({
            ...step,
            assertion: {
              type: "toolCalledWith",
              toolName: "list_workspaces",
              args: { args: { filter: null } },
            },
          } as TestStep)
        : step,
    );
    const draft = { ...seedCaseStepsDraft(testCase), steps: withNull };
    expect(isCaseStepsDirty(draft, testCase)).toBe(true);
  });
});

// ── dirty iff the save changes ──────────────────────────────────

const C1: Predicate = { type: "responseContains", needle: "one" };
const C2: Predicate = { type: "responseContains", needle: "two" };
const payload = (draft: CaseStepsDraft) =>
  JSON.stringify(
    buildCaseSavePayload(draft, {
      isNegativeTest: draft.toolsChoice === "noTool",
    }),
  );

describe("isCaseStepsDirty against the save", () => {
  // A case with a scenario and its own envelope, so each field has room to move.
  const stored = makeCase({
    scenario: "Signed in",
    predicates: { mode: "extend", list: [C1] },
  });

  it.each<[string, Partial<CaseStepsDraft>]>([
    ["title", { title: "Renamed" }],
    ["runs", { runs: 5 }],
    ["scenario", { scenario: "Signed out" }],
    ["scenario whitespace", { scenario: "  Signed in  " }],
    ["steps", { steps: [steps[0]!] }],
    ["advancedConfig", { advancedConfig: { failOnToolError: false } }],
    ["matchOptions", { matchOptions: matchOptionsForKind("regression") }],
    ["predicates mode", { predicates: { mode: "replace", list: [C1] } }],
    ["predicates list", { predicates: { mode: "extend", list: [C1, C2] } }],
    [
      "suppressedSuiteStandardCheckIds",
      { suppressedSuiteStandardCheckIds: ["response.errors"] },
    ],
    ["expectedOutput", { expectedOutput: "One workspace" }],
    ["expectedOutput whitespace", { expectedOutput: "  " }],
    ["kind", { kind: "regression" }],
    [
      "judgeConfigOverride",
      { judgeConfigOverride: { goalCompletion: { enabled: false } } },
    ],
    ["toolsChoice", { toolsChoice: "noTool" }],
  ])("is dirty exactly when the save changes: %s", (_name, edit) => {
    const seeded = seedCaseStepsDraft(stored);
    const next = { ...seeded, ...edit };
    const changesSave = payload(next) !== payload(seeded);
    expect(isCaseStepsDirty(next, stored)).toBe(changesSave);
  });

  // These change the envelope's shape but not what is graded.
  it("is clean after adding an after-run assertion and removing it", () => {
    const testCase = makeCase();
    const added = addCasePredicate(seedCaseStepsDraft(testCase), C1);
    expect(isCaseStepsDirty(added, testCase)).toBe(true);
    const removed = setCasePredicates(added, () => []);
    expect(removed.predicates).toEqual({ mode: "extend", list: [] });
    expect(isCaseStepsDirty(removed, testCase)).toBe(false);
  });

  it("is clean for an inherit list, which save blanks", () => {
    const testCase = makeCase({ predicates: { mode: "inherit", list: [] } });
    const draft = {
      ...seedCaseStepsDraft(testCase),
      predicates: { mode: "inherit" as const, list: [C1] },
    };
    expect(isCaseStepsDirty(draft, testCase)).toBe(false);
  });

  it("is dirty for an empty replace list, which drops the suite's", () => {
    const testCase = makeCase();
    const draft = setEnvelopeMode(seedCaseStepsDraft(testCase), "replace");
    expect(isCaseStepsDirty(draft, testCase)).toBe(true);
  });
});
