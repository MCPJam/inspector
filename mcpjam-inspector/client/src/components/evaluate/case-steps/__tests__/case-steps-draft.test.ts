import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import type { EvalCase } from "@/components/evals/types";
import {
  caseSaveBlockReason,
  caseSavePayload,
  draftFromCase,
  draftScorecard,
  draftsEqual,
  newCaseDraft,
} from "../case-steps-draft";
import { applyAddChoice, blockEndId } from "../editor-add";
import {
  anchorFromSearch,
  anchorSearch,
  endOfRunOf,
  stepAssertionRows,
} from "../editor-rows";
import { buildExecutionPreview } from "../case-steps-model";

const prompt: TestStep = { id: "p", kind: "prompt", prompt: "Draw a box" };
const toolAssert = (id: string, toolName: string): TestStep => ({
  id,
  kind: "assert",
  assertion: { type: "toolCalledWith", toolName, args: { args: {} } },
});

const baseCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "u",
  title: "Sketch a two-node flow",
  query: "",
  models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
  runs: 3,
  expectedToolCalls: [],
  steps: [prompt, toolAssert("t1", "read_me")],
  expectedOutput: "Two boxes and an arrow.",
  ...overrides,
});

describe("case steps draft", () => {
  it("loads the case's steps and its goal sentence", () => {
    const draft = draftFromCase(baseCase());
    expect(draft.steps.map((step) => step.id)).toEqual(["p", "t1"]);
    expect(draft.expectedOutput).toBe("Two boxes and an arrow.");
    expect(draft.isNegativeTest).toBe(false);
  });

  it("bridges a legacy case without steps from its query", () => {
    const draft = draftFromCase(
      baseCase({ steps: undefined, query: "Legacy prompt" }),
    );
    expect(draft.steps[0]).toMatchObject({
      kind: "prompt",
      prompt: "Legacy prompt",
    });
  });

  it("saves the Expected outcome into expectedOutput, trimmed", () => {
    const draft = { ...newCaseDraft(), expectedOutput: "  A goal.  " };
    expect(caseSavePayload(draft).expectedOutput).toBe("A goal.");
    expect(
      caseSavePayload({ ...draft, expectedOutput: "" }).expectedOutput,
    ).toBe("");
  });

  it("derives the display projections from the steps", () => {
    const payload = caseSavePayload(draftFromCase(baseCase()));
    expect(payload.query).toBe("Draw a box");
    expect(payload.expectedToolCalls).toEqual([
      { toolName: "read_me", arguments: {} },
    ]);
  });

  it("keeps a stored negative flag until a tool assertion contradicts it", () => {
    const negative = draftFromCase(
      baseCase({ isNegativeTest: true, steps: [prompt] }),
    );
    expect(caseSavePayload(negative).isNegativeTest).toBe(true);
    expect(
      caseSavePayload({
        ...negative,
        steps: [prompt, toolAssert("t1", "read_me")],
      }).isNegativeTest,
    ).toBe(false);
  });

  it("empties an inherited predicate list before it is sent", () => {
    const payload = caseSavePayload({
      ...newCaseDraft(),
      predicates: { mode: "inherit", list: [{ type: "noToolErrors" }] },
    });
    expect(payload.predicates).toEqual({ mode: "inherit", list: [] });
  });

  it("refuses an empty prompt and compares drafts by what they save", () => {
    expect(caseSaveBlockReason(newCaseDraft())).toMatch(/prompt/i);
    const draft = draftFromCase(baseCase());
    expect(draftsEqual(draft, { ...draft })).toBe(true);
    expect(draftsEqual(draft, { ...draft, title: "Renamed" })).toBe(false);
  });
});

describe("adding from the editor", () => {
  const steps = [prompt, toolAssert("t1", "read_me")];

  it("puts a step assertion after the block's last assertion", () => {
    expect(blockEndId(steps, "p")).toBe("t1");
    const result = applyAddChoice({
      choice: { kind: "check", predicateKind: "toolCalledWith" },
      steps,
      predicates: undefined,
      actionId: "p",
      suiteServers: [],
    });
    expect(result.kind).toBe("steps");
    if (result.kind !== "steps") return;
    expect(result.steps.map((step) => step.id)).toEqual([
      "p",
      "t1",
      result.addedId,
    ]);
  });

  it("files a whole-run assertion in the case's after-run list", () => {
    const result = applyAddChoice({
      choice: { kind: "check", predicateKind: "noToolErrors" },
      steps,
      predicates: undefined,
      actionId: null,
      suiteServers: [],
    });
    expect(result).toEqual({
      kind: "predicates",
      predicates: {
        mode: "extend",
        list: [expect.objectContaining({ type: "noToolErrors" })],
      },
    });
  });

  it("adds a new action after the block", () => {
    const result = applyAddChoice({
      choice: { kind: "step", stepKind: "prompt" },
      steps,
      predicates: undefined,
      actionId: "p",
      suiteServers: [],
    });
    if (result.kind !== "steps") throw new Error(result.kind);
    expect(result.steps.at(-1)).toMatchObject({ kind: "prompt" });
  });
});

describe("editor rows and anchors", () => {
  it("gives a required tool assertion its own row under its step", () => {
    const draft = draftFromCase(baseCase());
    const card = draftScorecard(draft, {});
    const rows = stepAssertionRows(card, draft.steps);
    expect(rows.get("t1")).toMatchObject({
      provenance: "step",
      predicate: { type: "toolCalledWith", toolName: "read_me" },
    });
  });

  it("orders end-of-run assertions suite defaults first, then the case's", () => {
    const draft = {
      ...draftFromCase(baseCase()),
      predicates: {
        mode: "extend" as const,
        list: [{ type: "noToolErrors" as const }],
      },
    };
    const card = draftScorecard(draft, {
      defaultPredicates: [{ type: "finalAssistantMessageNonEmpty" }],
    });
    const endOfRun = endOfRunOf(buildExecutionPreview(draft.steps, card));
    expect(endOfRun.assertions.map((item) => item.provenance)).toEqual([
      "suite",
      "case",
    ]);
  });

  it("reads the step a link opens the editor at from ?step=", () => {
    expect(anchorFromSearch(anchorSearch("step:p 1"))).toBe("step:p 1");
    expect(anchorFromSearch("?step=outcome")).toBe("outcome");
    expect(anchorFromSearch("?step=nothing")).toBeNull();
    expect(anchorFromSearch("")).toBeNull();
  });
});
