import { describe, expect, it } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalIteration } from "@/components/evals/types";
import type { SelectedTrial } from "../case-workspace/selected-trial";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import type { CaseScorecardInput } from "../case-scorecard/case-scorecard-model";

const prompt = (id: string, text: string): TestStep =>
  ({ id, kind: "prompt", prompt: text }) as TestStep;

const noToolErrors = { type: "noToolErrors" } as Predicate;
const finalNonEmpty = { type: "finalAssistantMessageNonEmpty" } as Predicate;

const draft: CaseScorecardInput = {
  steps: [prompt("p1", "hi")],
  toolsChoice: "unset",
  predicates: { mode: "extend", list: [finalNonEmpty] },
  suiteDefaultPredicates: [noToolErrors],
  expectedOutput: "states the email",
};

function persisted(
  snapshot: Partial<NonNullable<EvalIteration["testCaseSnapshot"]>>,
): SelectedTrial {
  return {
    kind: "persisted",
    source: "history",
    iteration: {
      _id: "it1",
      status: "completed",
      testCaseSnapshot: {
        title: "t",
        query: "hi",
        provider: "p",
        model: "m",
        expectedToolCalls: [],
        ...snapshot,
      },
    } as unknown as EvalIteration,
  };
}

describe("authoredForTrial", () => {
  it("uses the draft when the trial still matches it, so both panes agree", () => {
    const trial = persisted({
      steps: draft.steps,
      predicates: [noToolErrors, finalNonEmpty],
      expectedOutput: "states the email",
    });
    const result = authoredForTrial({ trial, draft, run: null });
    expect(result.basis).toBe("draft");
    expect(result.authored).toBe(draft);
  });

  it("falls back to what the trial actually graded once the case has been edited", () => {
    const trial = persisted({
      steps: [prompt("p1", "an older prompt")],
      predicates: [noToolErrors],
      expectedOutput: "an older goal",
    });
    const result = authoredForTrial({ trial, draft, run: null });
    expect(result.basis).toBe("snapshot");
    expect(result.authored.steps).toEqual([prompt("p1", "an older prompt")]);
    expect(result.authored.expectedOutput).toBe("an older goal");
  });

  it("claims no suite-or-case provenance for a frozen list, because the snapshot has none", () => {
    // `testCaseSnapshot.predicates` is already resolved and `configSnapshot`
    // carries no suite defaults to reconstruct the split from. Matching
    // against the LIVE suite would go wrong exactly when the suite changed —
    // which is why someone opened History in the first place.
    const trial = persisted({
      steps: [prompt("p1", "older")],
      predicates: [noToolErrors, finalNonEmpty],
    });
    const { authored } = authoredForTrial({ trial, draft, run: null });
    expect(authored.snapshotPredicates).toEqual([noToolErrors, finalNonEmpty]);
    expect(authored.predicates).toBeUndefined();
    expect(authored.suiteDefaultPredicates).toBeUndefined();
  });

  it("uses the judge config the run froze, not today's suite settings", () => {
    const trial = persisted({ steps: [prompt("p1", "older")] });
    const { authored } = authoredForTrial({
      trial,
      draft: { ...draft, suiteJudgeConfig: { goalCompletion: { threshold: 0.5 } } },
      run: {
        configSnapshot: { judgeConfig: { goalCompletion: { threshold: 0.9 } } },
      } as never,
    });
    expect(authored.suiteJudgeConfig).toEqual({
      goalCompletion: { threshold: 0.9 },
    });
  });

  it("shows the frozen view when the reader explicitly asked to inspect one", () => {
    const trial = persisted({
      steps: draft.steps,
      predicates: [noToolErrors, finalNonEmpty],
      expectedOutput: "states the email",
    });
    const result = authoredForTrial({
      trial,
      draft,
      run: null,
      forceSnapshot: true,
    });
    expect(result.basis).toBe("snapshot");
  });

  it("grades an in-flight attempt against what it was launched with", () => {
    // The author can keep typing while a run streams; the run will not be
    // graded against what they type next.
    const result = authoredForTrial({
      trial: {
        kind: "live",
        record: {
          launchSnapshot: {
            steps: [prompt("p1", "as launched")],
            predicates: { mode: "extend", list: [noToolErrors] },
            expectedOutput: "as launched",
          },
        },
      } as unknown as SelectedTrial,
      draft,
      run: null,
    });
    expect(result.authored.steps).toEqual([prompt("p1", "as launched")]);
    expect(result.authored.expectedOutput).toBe("as launched");
  });

  it("uses the draft when there is no trial at all", () => {
    expect(authoredForTrial({ trial: null, draft, run: null })).toEqual({
      authored: draft,
      basis: "draft",
    });
  });
});

describe("a frozen trial keeps the route it was graded against", () => {
  const snapshotTrial = (snapshot: Record<string, unknown>) =>
    ({
      kind: "persisted",
      iteration: {
        _id: "it-old",
        iterationNumber: 1,
        status: "completed",
        result: "passed",
        testCaseSnapshot: snapshot,
      },
    }) as never;

  it("reads the historical no-tool flag, not today's setting", () => {
    // The case forbade tools then and is unrestricted now. Showing "Any route"
    // would describe a gate that trial actually graded as absent.
    const { authored, basis } = authoredForTrial({
      trial: snapshotTrial({
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        isNegativeTest: true,
      }),
      draft: { steps: [], toolsChoice: "checks" } as never,
      run: null,
      forceSnapshot: true,
    } as never);
    expect(basis).toBe("snapshot");
    expect(authored.toolsChoice).toBe("noTool");
  });

  it.each([true, false])("detects a no-tool-only edit without forcing History (%s)", (wasNegative) => {
    const sameSteps = [prompt("s1", "hi")];
    const { authored, basis } = authoredForTrial({
      trial: persisted({ steps: sameSteps, isNegativeTest: wasNegative }),
      draft: { steps: sameSteps, toolsChoice: wasNegative ? "unset" : "noTool" },
      run: null,
    });
    expect(basis).toBe("snapshot");
    expect(authored.toolsChoice === "noTool").toBe(wasNegative);
  });

  it("reads pinned route tools out of the frozen steps", () => {
    const { authored } = authoredForTrial({
      trial: snapshotTrial({
        steps: [
          { id: "s1", kind: "prompt", prompt: "hi" },
          {
            id: "t1",
            kind: "assert",
            assertion: {
              type: "toolCalledWith",
              toolName: "get_me",
              args: { args: {} },
            },
          },
        ],
        isNegativeTest: false,
      }),
      draft: { steps: [], toolsChoice: "noTool" } as never,
      run: null,
      forceSnapshot: true,
    } as never);
    expect(authored.toolsChoice).toBe("tools");
  });

  it("says unset when the frozen case asserted no route at all", () => {
    const { authored } = authoredForTrial({
      trial: snapshotTrial({
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
        isNegativeTest: false,
      }),
      draft: { steps: [], toolsChoice: "tools" } as never,
      run: null,
      forceSnapshot: true,
    } as never);
    expect(authored.toolsChoice).toBe("unset");
  });
});
