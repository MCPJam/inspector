import { describe, expect, it } from "vitest";
import {
  PREDICATE_STAGE,
  USER_VALUE_STAGES,
} from "@mcpjam/sdk/contract";
import {
  blankPredicate,
  formatCriterion,
  PREDICATE_KIND_LABELS,
  type PredicateKind,
} from "@/shared/predicate-kinds";
import { hostedCriterionId } from "@/shared/hosted-criterion-id";
import {
  resolveCasePredicates,
  type CasePredicates,
} from "@/shared/eval-matching";
import type { Predicate } from "@/shared/eval-matching";
import { WIDGET_ASSERTION_LABELS, type TestStep } from "@/shared/steps";
import {
  LIBRARY_OPT_IN_KINDS,
  scorerLibraryCategories,
} from "@/components/evals/suite-scorer-table-model";
import {
  appendCaseScorer,
  buildCaseScorecard,
  caseLibraryKinds,
  deriveRubricSource,
  removeCaseScorer,
  ROUTE_OWNED_KINDS,
  purposeOf,
  scorerRowLabel,
  spineLibraryKinds,
  stepScope,
  updateCaseScorer,
  withCaseJudgeSkipped,
  type CaseScorecardInput,
} from "../case-scorecard/case-scorecard-model";

const prompt = (id: string, text: string): TestStep =>
  ({ id, kind: "prompt", prompt: text }) as TestStep;
const assert = (id: string, assertion: Predicate): TestStep =>
  ({ id, kind: "assert", assertion }) as TestStep;

const base: CaseScorecardInput = {
  steps: [prompt("p1", "Which account am I signed in as?")],
  toolsChoice: "unset",
};

function allRows(input: CaseScorecardInput) {
  return buildCaseScorecard(input).groups.flatMap((group) => group.rows);
}

describe("buildCaseScorecard — shape", () => {
  it("lists stages in chain order and omits the ones with nothing on them", () => {
    // Connection, Discovery and Tool call have nothing a CASE can author.
    // Rendering them empty would offer a reader a control that is not there.
    const card = buildCaseScorecard({
      ...base,
      steps: [
        prompt("p1", "hi"),
        assert("a1", { type: "noToolErrors" } as Predicate),
      ],
    });
    expect(card.groups.map((group) => group.stage)).toEqual([
      "selection",
      "userValue",
    ]);
    const order = card.groups.map((group) => USER_VALUE_STAGES.indexOf(group.stage));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts the route first under Selection and the judge last under User value", () => {
    const card = buildCaseScorecard({
      ...base,
      steps: [
        prompt("p1", "hi"),
        assert("a1", { type: "toolCalledAtLeastOnce", toolName: "get_me" } as Predicate),
      ],
    });
    const selection = card.groups.find((group) => group.stage === "selection");
    expect(selection?.rows[0]).toBe(card.route);
    const userValue = card.groups.find((group) => group.stage === "userValue");
    expect(userValue?.rows.at(-1)).toBe(card.judge);
  });

  it("files a kind this build does not know at User value rather than throwing", () => {
    // A backend that ships a predicate first must not blank the page.
    const rows = allRows({
      ...base,
      predicates: {
        mode: "extend",
        list: [{ type: "somethingNewer" } as unknown as Predicate],
      },
    });
    const row = rows.find((r) => r.provenance === "case");
    expect(row?.stage).toBe("userValue");
    expect(row?.label).toBe("somethingNewer");
  });
});

describe("buildCaseScorecard — provenance", () => {
  const input: CaseScorecardInput = {
    steps: [
      prompt("p1", "hi"),
      assert("a1", { type: "noToolErrors" } as Predicate),
    ],
    toolsChoice: "unset",
    predicates: {
      mode: "extend",
      list: [{ type: "finalAssistantMessageNonEmpty" } as Predicate],
    },
    suiteDefaultPredicates: [
      { type: "tokenBudgetUnder", tokens: 4000 } as Predicate,
    ],
  };

  it("separates what the step wrote, what the case wrote and what the suite wrote", () => {
    const rows = allRows(input);
    expect(
      rows
        .filter((row) => row.predicate)
        .map((row) => [row.provenance, row.label]),
    ).toEqual([
      ["step", "No tool errors so far"],
      ["case", "Final message non-empty"],
      ["suite", "Token budget under 4000"],
    ]);
  });

  it("renders exactly the predicates the runner will evaluate", () => {
    // The rows are a claim about grading, so they have to agree with the real
    // resolver rather than with a second copy of its rules.
    for (const mode of ["inherit", "extend", "replace"] as const) {
      const card = buildCaseScorecard({
        ...input,
        predicates: { mode, list: input.predicates!.list },
      });
      const rendered = card.groups
        .flatMap((group) => group.rows)
        .filter((row) => row.provenance === "case" || row.provenance === "suite")
        .map((row) => row.predicate);
      const resolved = resolveCasePredicates(input.suiteDefaultPredicates, {
        mode,
        list: input.predicates!.list,
      });
      expect(new Set(rendered)).toEqual(new Set(resolved ?? []));
    }
  });

  it("says how many suite scorers a replace envelope is not running", () => {
    const card = buildCaseScorecard({
      ...input,
      predicates: { mode: "replace", list: input.predicates!.list },
    });
    expect(card.hiddenSuiteCount).toBe(1);
    expect(
      card.groups.flatMap((g) => g.rows).some((r) => r.provenance === "suite"),
    ).toBe(false);
  });

  it("cannot claim suite-vs-case provenance for a frozen trial", () => {
    const card = buildCaseScorecard({
      ...input,
      snapshotPredicates: [
        { type: "finalAssistantMessageNonEmpty" } as Predicate,
        { type: "tokenBudgetUnder", tokens: 4000 } as Predicate,
      ],
    });
    const rows = card.groups.flatMap((g) => g.rows).filter((r) => r.predicate);
    expect(rows.map((r) => r.provenance)).toEqual([
      "step",
      "snapshot",
      "snapshot",
    ]);
    expect(rows.every((r) => (r.provenance === "snapshot" ? !r.editable : true))).toBe(
      true,
    );
  });

  it("never offers to edit or role an inherited scorer", () => {
    const suite = allRows(input).find((row) => row.provenance === "suite");
    expect(suite?.editable).toBe(false);
    expect(suite?.roleLock).toBe("inherited");
  });
});

describe("buildCaseScorecard — roles", () => {
  it("reads the authored role off the predicate", () => {
    const rows = allRows({
      ...base,
      predicates: {
        mode: "extend",
        list: [
          { type: "noToolErrors" } as Predicate,
          { type: "noToolErrors", role: "advisory", severity: "warn" } as Predicate,
          { type: "noToolErrors", role: "advisory" } as Predicate,
        ],
      },
    });
    expect(rows.filter((r) => r.provenance === "case").map((r) => r.role)).toEqual([
      "gate",
      "warn",
      "report",
    ]);
  });

  it("keeps the route a gate, because an advisory route is not a route", () => {
    // `deriveExpectedToolCalls` skips an advisory `toolCalledWith`, so it never
    // becomes a matcher expectation. Showing a Warn control here would offer a
    // setting that silently un-routes the case.
    const card = buildCaseScorecard({
      ...base,
      toolsChoice: "tools",
      steps: [
        prompt("p1", "hi"),
        assert("a1", { type: "toolCalledWith", toolName: "get_me", args: { args: {} } } as Predicate),
      ],
    });
    expect(card.route.role).toBe("gate");
    expect(card.route.roleLock).toBe("route");
  });

  it("files an advisory toolCalledWith as a step scorer, not the route", () => {
    const card = buildCaseScorecard({
      ...base,
      steps: [
        prompt("p1", "hi"),
        assert("a1", {
          type: "toolCalledWith",
          toolName: "get_me",
          args: { args: {} },
          role: "advisory",
          severity: "warn",
        } as Predicate),
      ],
    });
    expect(card.route.route?.kind).toBe("checks");
    const step = card.groups
      .flatMap((g) => g.rows)
      .find((row) => row.provenance === "step");
    expect(step?.role).toBe("warn");
    expect(step?.stage).toBe(PREDICATE_STAGE.toolCalledWith);
  });

  it("gives a widget assertion a gate it cannot author, because it has no policy field", () => {
    const card = buildCaseScorecard({
      ...base,
      steps: [
        prompt("p1", "hi"),
        assert("a1", { kind: "widgetRendered" } as never),
      ],
    });
    const row = card.groups.flatMap((g) => g.rows).find((r) => r.widgetAssertion);
    expect(row?.role).toBe("gate");
    expect(row?.roleLock).toBe("widget");
  });
});

describe("buildCaseScorecard — the route question", () => {
  it("asks the question, and blocks the save, when the case asserts nothing", () => {
    const card = buildCaseScorecard(base);
    expect(card.route.route?.kind).toBe("unset");
    expect(card.route.label).toBe("Which tool should handle it?");
    expect(card.unsetBlockReason).toBeTruthy();
  });

  it("calls a checks-only case positive, with no route", () => {
    const card = buildCaseScorecard({
      ...base,
      steps: [prompt("p1", "hi"), assert("a1", { type: "noToolErrors" } as Predicate)],
    });
    expect(card.route.route?.kind).toBe("checks");
    expect(card.route.label).toBe("Any route — graded by the scorers below");
    expect(card.unsetBlockReason).toBeNull();
  });

  it("names the tools, and reads the match mode off the resolved options", () => {
    const steps = [
      prompt("p1", "hi"),
      assert("a1", { type: "toolCalledWith", toolName: "get_me", args: { args: {} } } as Predicate),
      assert("a2", { type: "toolCalledWith", toolName: "list_orgs", args: { args: {} } } as Predicate),
    ];
    expect(
      buildCaseScorecard({ ...base, steps, toolsChoice: "tools" }).route.label,
    ).toBe("Reach get_me, list_orgs");
    expect(
      buildCaseScorecard({
        ...base,
        steps,
        toolsChoice: "tools",
        kind: "regression",
      }).route.label,
    ).toBe("Exact route: get_me → list_orgs");
  });

  it("warns when a negative case still carries a check that needs a tool", () => {
    const card = buildCaseScorecard({
      ...base,
      toolsChoice: "noTool",
      suiteDefaultPredicates: [
        { type: "toolCalledAtLeastOnce", toolName: "get_me" } as Predicate,
      ],
    });
    expect(card.route.route?.kind).toBe("noTool");
    expect(card.negativeContradiction).toBe(true);
  });

  it("locks the route on a case with no model turn to route", () => {
    const card = buildCaseScorecard({
      ...base,
      steps: [{ id: "t1", kind: "toolCall", toolName: "get_me" } as TestStep],
    });
    expect(card.route.route).toEqual({
      kind: "locked",
      reason: "modelFree",
      tools: [],
    });
    expect(card.route.editable).toBe(false);
    expect(card.unsetBlockReason).toBeNull();
  });

  it("still carries a locked case's tool asserts, so they cannot vanish", () => {
    // They are steps in this case, and `leftoverSteps` does not list a
    // `toolCalledWith` — a locked question that dropped them would remove them
    // from every editor on the surface.
    const card = buildCaseScorecard({
      ...base,
      steps: [
        { id: "t1", kind: "toolCall", toolName: "render" } as TestStep,
        assert("a1", {
          type: "toolCalledWith",
          toolName: "get_me",
          args: { args: {} },
        } as Predicate),
      ],
    });
    const route = card.route.route;
    expect(route?.kind).toBe("locked");
    expect(route?.kind === "locked" && route.tools).toHaveLength(1);
  });

  it("locks the route on a case that does not start with a prompt", () => {
    const card = buildCaseScorecard({
      ...base,
      steps: [
        assert("a1", { type: "noToolErrors" } as Predicate),
        prompt("p1", "hi"),
      ],
    });
    expect(card.route.route).toEqual({
      kind: "locked",
      reason: "pinnedFirst",
      tools: [],
    });
  });
});

describe("buildCaseScorecard — join keys", () => {
  it("keys rows uniquely, even when two checks are identical", () => {
    const rows = allRows({
      ...base,
      predicates: {
        mode: "extend",
        list: [
          { type: "noToolErrors" } as Predicate,
          { type: "noToolErrors" } as Predicate,
        ],
      },
    });
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    // ...but they are ONE hosted criterion, because the server de-dupes
    // definitions by id, so both rows must receive the same result.
    const criteria = rows
      .filter((row) => row.join?.kind === "predicate")
      .map((row) => (row.join as { criterionId: string }).criterionId);
    expect(new Set(criteria).size).toBe(1);
  });

  it("mints the criterion id the server persisted", () => {
    const predicate = { type: "noToolErrors" } as Predicate;
    const rows = allRows({
      ...base,
      predicates: { mode: "extend", list: [predicate] },
    });
    const row = rows.find((r) => r.provenance === "case");
    expect(row?.join).toEqual({
      kind: "predicate",
      criterionId: hostedCriterionId(predicate),
    });
  });

  it("scopes a step's criterion to the turn the runner scoped it to", () => {
    const steps = [
      prompt("p1", "one"),
      assert("a1", { type: "noToolErrors" } as Predicate),
      prompt("p2", "two"),
      assert("a2", { type: "noToolErrors" } as Predicate),
    ];
    const rows = allRows({ ...base, steps });
    const stepRows = rows.filter((row) => row.provenance === "step");
    expect(stepRows.map((row) => row.join)).toEqual([
      {
        kind: "step",
        stepId: "a1",
        criterionId: hostedCriterionId({ type: "noToolErrors" } as Predicate, {
          kind: "turn",
          promptIndex: 0,
        }),
        scope: { kind: "turn", promptIndex: 0 },
      },
      {
        kind: "step",
        stepId: "a2",
        criterionId: hostedCriterionId({ type: "noToolErrors" } as Predicate, {
          kind: "turn",
          promptIndex: 1,
        }),
        scope: { kind: "turn", promptIndex: 1 },
      },
    ]);
    // The step's own position in the flat list, matching the Steps pane —
    // NOT the turn it sits in. Three checks inside turn 1 used to read
    // "Step 1" here while the Steps pane called them 2, 3 and 4.
    expect(stepRows[0]?.stepNumber).toBe(2);
    expect(stepRows[1]?.stepNumber).toBe(4);
    expect(stepScope(steps, "a2")).toEqual({ kind: "turn", promptIndex: 1 });
  });

  it("keeps a row's key stable when a different row is edited", () => {
    const list = [
      { type: "noToolErrors" } as Predicate,
      { type: "finalAssistantMessageNonEmpty" } as Predicate,
    ];
    const before = allRows({ ...base, predicates: { mode: "extend", list } });
    const after = allRows({
      ...base,
      predicates: {
        mode: "extend",
        list: [{ type: "responseContains", needle: "x" } as Predicate, list[1]],
      },
    });
    const key = (rows: typeof before, kind: string) =>
      rows.find((row) => row.predicate?.type === kind)?.key;
    expect(key(before, "finalAssistantMessageNonEmpty")).toBe(
      key(after, "finalAssistantMessageNonEmpty"),
    );
  });

  it("gives the route and the judge the platform scorer ids", () => {
    const card = buildCaseScorecard({ ...base, toolsChoice: "noTool" });
    expect(card.route.join).toEqual({
      kind: "toolMatch",
      scorerId: "toolCalls:match",
    });
    expect(card.judge.join).toEqual({
      kind: "judge",
      slot: "goalCompletion",
      scorerId: "judge:goalCompletion",
    });
  });

  it("gives an unanswered route nothing to join, so it cannot claim a result", () => {
    expect(buildCaseScorecard(base).route.join).toBeUndefined();
    expect(
      buildCaseScorecard({
        ...base,
        steps: [prompt("p1", "hi"), assert("a1", { type: "noToolErrors" } as Predicate)],
      }).route.join,
    ).toBeUndefined();
  });
});

describe("labels", () => {
  it("never shows a wire enum for a kind this build knows", () => {
    for (const kind of Object.keys(PREDICATE_KIND_LABELS)) {
      const predicate = { type: kind } as Predicate;
      expect(scorerRowLabel(predicate, "case")).not.toBe(kind);
      expect(scorerRowLabel(predicate, "step")).not.toBe(kind);
    }
  });

  it("says where a step-authored check runs", () => {
    // A step's `noToolErrors` sees the transcript UP TO that step. Labelling
    // it like the whole-run one would claim it checked the entire trial.
    const predicate = { type: "noToolErrors" } as Predicate;
    expect(scorerRowLabel(predicate, "step")).toBe("No tool errors so far");
    expect(scorerRowLabel(predicate, "case")).toBe("No tool errors");
  });
});

describe("the scorer library", () => {
  it("offers every predicate kind exactly once, or the route owns it", () => {
    const offered = scorerLibraryCategories(caseLibraryKinds()).flatMap(
      (category) => category.kinds,
    );
    expect(new Set(offered).size).toBe(offered.length);
    // Three buckets now, and every kind is in exactly one: offered here,
    // owned by the route row, or opt-in (offered only where it replaces an
    // existing control — the spine).
    const covered = new Set([
      ...offered,
      ...ROUTE_OWNED_KINDS,
      ...LIBRARY_OPT_IN_KINDS,
    ]);
    for (const kind of Object.keys(PREDICATE_KIND_LABELS)) {
      expect(covered.has(kind as never)).toBe(true);
    }
  });

  it("offers every kind on the spine except the one the route owns", () => {
    const offered = new Set(spineLibraryKinds());
    for (const kind of Object.keys(PREDICATE_KIND_LABELS)) {
      expect(
        offered.has(kind as never) || ROUTE_OWNED_KINDS.has(kind as never),
      ).toBe(true);
    }
  });

  it("does not offer the kind the route question already owns", () => {
    expect(caseLibraryKinds()).not.toContain("toolCalledWith");
  });
});

describe("the judge", () => {
  const suiteJudgeConfig = {
    goalCompletion: { judgeModel: "anthropic/claude", threshold: 0.8 },
  };

  it("reports what the suite will actually do, and the case's one override", () => {
    const card = buildCaseScorecard({
      ...base,
      suiteJudgeConfig,
      suiteJudgeRubric: {
        criteria: [{ id: "a", label: "A", description: "" }],
      },
    });
    expect(card.judge.judge).toMatchObject({
      model: "anthropic/claude",
      threshold: 0.8,
      suiteCriteriaCount: 1,
      skippedForCase: false,
      runsForCase: true,
      suiteMode: "manual",
    });
  });

  it("says the judge will not run when the case opted out", () => {
    const card = buildCaseScorecard({
      ...base,
      suiteJudgeConfig,
      judgeConfigOverride: { goalCompletion: { enabled: false } },
    });
    expect(card.judge.judge?.skippedForCase).toBe(true);
    expect(card.judge.judge?.runsForCase).toBe(false);
  });

  it("says the judge will not run when the suite turned it off", () => {
    const card = buildCaseScorecard({
      ...base,
      suiteJudgeConfig: { goalCompletion: { enabled: false } },
    });
    expect(card.judge.judge?.suiteMode).toBe("off");
    expect(card.judge.judge?.runsForCase).toBe(false);
  });

  it("names the rubric the backend will actually grade against", () => {
    const route = { kind: "checks" } as const;
    expect(
      deriveRubricSource({ expectedOutput: "  ", route, suiteCriteriaCount: 2 }),
    ).toBe("suite_criteria");
    expect(
      deriveRubricSource({ expectedOutput: "states the email", route, suiteCriteriaCount: 2 }),
    ).toBe("expected_output");
    expect(
      deriveRubricSource({ route: { kind: "noTool" }, suiteCriteriaCount: 2 }),
    ).toBe("assertions");
    expect(deriveRubricSource({ route, suiteCriteriaCount: 0 })).toBe("objective");
  });
});

describe("writers", () => {
  it("writes and clears the only per-case judge field the backend admits", () => {
    expect(withCaseJudgeSkipped(undefined, true)).toEqual({
      goalCompletion: { enabled: false },
    });
    // Clearing must return undefined, not `{}` — the editor sends `null` for
    // undefined, and that is what actually clears the stored override.
    expect(withCaseJudgeSkipped({ goalCompletion: { enabled: false } }, false)).toBeUndefined();
    expect(withCaseJudgeSkipped(undefined, false)).toBeUndefined();
  });

  it("keeps a replace envelope on replace when a scorer is added", () => {
    // A case that deliberately replaced its suite defaults must not be
    // switched back to extending them by the act of adding one more check.
    const next = appendCaseScorer(
      { mode: "replace", list: [] },
      { type: "noToolErrors" } as Predicate,
    );
    expect(next.mode).toBe("replace");
    expect(appendCaseScorer(undefined, { type: "noToolErrors" } as Predicate).mode).toBe(
      "extend",
    );
  });

  it("clears the envelope when the last case scorer is removed", () => {
    const one: CasePredicates = {
      mode: "extend",
      list: [{ type: "noToolErrors" }],
    };
    expect(removeCaseScorer(one, 0)).toBeUndefined();
    expect(
      updateCaseScorer(one, 0, { type: "responseContains", needle: "x" } as Predicate),
    ).toEqual({ mode: "extend", list: [{ type: "responseContains", needle: "x" }] });
  });
});

describe("numbering: action", () => {
  const prompt = (id: string): TestStep => ({
    id,
    kind: "prompt",
    prompt: "ask",
  });
  const check = (id: string): TestStep => ({
    id,
    kind: "assert",
    assertion: { type: "noToolErrors" },
  });
  const click = (id: string): TestStep => ({
    id,
    kind: "interact",
    action: { type: "click", locator: { testId: "x" } },
  });

  const build = (steps: TestStep[], numbering?: "flat" | "action") =>
    buildCaseScorecard({ steps, toolsChoice: "checks", numbering });

  const stepNumbers = (card: ReturnType<typeof buildCaseScorecard>) =>
    card.groups
      .flatMap((group) => group.rows)
      .filter((row) => row.provenance === "step")
      .map((row) => row.stepNumber);

  it("numbers a check by the ACTION it hangs under, not its own offset", () => {
    // Flat numbering calls these checks 2, 3 and 4 — their positions. Under the
    // spine all three hang beneath action 1, and a badge reading "4" would name
    // a step the author cannot see.
    const steps = [prompt("s1"), check("a1"), check("a2"), check("a3")];
    expect(stepNumbers(build(steps, "flat"))).toEqual([2, 3, 4]);
    expect(stepNumbers(build(steps, "action"))).toEqual([1, 1, 1]);
  });

  it("numbers a check under a click by the click's ordinal", () => {
    // The click is action 2 but shares turn 0 with the prompt: turn numbering
    // would put this check under the prompt and mislabel what it grades.
    const steps = [prompt("s1"), check("a1"), click("i1"), check("a2")];
    expect(stepNumbers(build(steps, "action"))).toEqual([1, 2]);
  });

  it("defaults to flat, so surfaces beside the Steps pane are untouched", () => {
    const steps = [prompt("s1"), check("a1")];
    expect(stepNumbers(build(steps))).toEqual(
      stepNumbers(build(steps, "flat")),
    );
  });

  it("leaves a leading check unnumbered rather than inventing an action", () => {
    // An assert before any action belongs to no action; the row falls back to
    // "graded where it sits" instead of claiming a step number.
    expect(stepNumbers(build([check("a0"), prompt("s1")], "action"))).toEqual([
      undefined,
    ]);
  });
});

describe("purposeOf", () => {
  it("gives every predicate kind a purpose that is not its wire type", () => {
    for (const kind of Object.keys(PREDICATE_KIND_LABELS) as PredicateKind[]) {
      const purpose = purposeOf(blankPredicate(kind));
      expect(purpose.length).toBeGreaterThan(0);
      expect(purpose).not.toBe(kind);
      // The purpose says why, so it must not just echo the mechanism label.
      expect(purpose).not.toBe(PREDICATE_KIND_LABELS[kind]);
    }
  });

  it("gives every widget assertion kind a purpose", () => {
    for (const kind of Object.keys(WIDGET_ASSERTION_LABELS) as Array<
      keyof typeof WIDGET_ASSERTION_LABELS
    >) {
      const purpose = purposeOf({ kind } as never);
      expect(purpose.length).toBeGreaterThan(0);
      expect(purpose).not.toBe(kind);
    }
  });

  it("falls back to the type for a kind this build does not know", () => {
    expect(purposeOf({ type: "notARealKind" } as never)).toBe("notARealKind");
  });
});

describe("onlyToolsCalled is offered on the spine and nowhere else", () => {
  it("is not in the suite settings library", () => {
    // The suite page still has the matcher's exclusivity option; offering this
    // beside it would give a reader two controls for one claim.
    const kinds = scorerLibraryCategories().flatMap(
      (category) => category.kinds,
    );
    expect(kinds).not.toContain("onlyToolsCalled");
  });

  it("is not in the pre-spine case library", () => {
    // That page still has the route row's "No tool should be called".
    expect(caseLibraryKinds()).not.toContain("onlyToolsCalled");
  });

  it("IS in the spine's library, which is where it replaces them", () => {
    expect(spineLibraryKinds()).toContain("onlyToolsCalled");
  });

  it("keeps the route's own kind out of every library", () => {
    expect(caseLibraryKinds()).not.toContain("toolCalledWith");
    expect(spineLibraryKinds()).not.toContain("toolCalledWith");
  });

  it("reads as the negative case when the list is empty", () => {
    expect(
      formatCriterion({
        predicate: { type: "onlyToolsCalled", toolNames: [] },
      }),
    ).toBe("No tool should be called");
  });

  it("names the allowed tools when the list is not empty", () => {
    expect(
      formatCriterion({
        predicate: { type: "onlyToolsCalled", toolNames: ["search", "get"] },
      }),
    ).toBe("Only these tools may be called: search, get");
  });

  it("starts blank, so a new check does not assert the negative case", () => {
    // An empty list is a REAL claim; a freshly added check must not make it
    // before the author has said so.
    expect(blankPredicate("onlyToolsCalled")).toEqual({
      type: "onlyToolsCalled",
      toolNames: [],
    });
  });
});

it("removing the last replacement scorer keeps suite defaults excluded", () => {
  expect(
    removeCaseScorer({ mode: "replace", list: [{ type: "noToolErrors" }] }, 0),
  ).toEqual({ mode: "replace", list: [] });
});
