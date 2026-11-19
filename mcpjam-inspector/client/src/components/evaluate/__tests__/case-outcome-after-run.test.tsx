import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalJudgeConfig } from "@/components/evals/types";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import type { CaseStepsDraft } from "../case-steps/case-step-edits";
import { afterRunSection } from "../case-steps/case-steps-model";
import { CaseAfterRun } from "../case-steps/case-after-run";
import { CaseOutcome } from "../case-steps/case-outcome";
import { chooseNoTool } from "../case-steps/case-step-edits";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "List my workspaces" },
];

const judge = {
  goalCompletion: {
    enabled: true,
    autoRun: true,
    judgeModel: "openai/gpt-5.4-mini",
    threshold: 0.7,
    role: "advisory",
  },
} as unknown as EvalJudgeConfig;

const suiteDefaults: Predicate[] = [{ type: "noToolErrors" }];

const draftOf = (over: Partial<CaseStepsDraft> = {}): CaseStepsDraft => ({
  title: "List workspaces",
  runs: 1,
  steps,
  expectedOutput: "",
  toolsChoice: "unset",
  stashedTools: [],
  ...over,
});

function cardOf(draft: CaseStepsDraft, suiteJudgeConfig = judge) {
  return buildCaseScorecard({
    steps: draft.steps,
    toolsChoice: draft.toolsChoice,
    kind: draft.kind,
    matchOptions: draft.matchOptions,
    predicates: draft.predicates,
    suiteDefaultPredicates: suiteDefaults,
    expectedOutput: draft.expectedOutput,
    judgeConfigOverride: draft.judgeConfigOverride,
    suiteJudgeConfig,
    numbering: "action",
  });
}

function Outcome({
  initial,
  readOnly = false,
  onChange,
  suiteJudgeConfig = judge,
  onOpenSuiteSettings = vi.fn(),
}: {
  initial: CaseStepsDraft;
  readOnly?: boolean;
  onChange?: (draft: CaseStepsDraft) => void;
  suiteJudgeConfig?: EvalJudgeConfig;
  onOpenSuiteSettings?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const card = useMemo(
    () => cardOf(draft, suiteJudgeConfig),
    [draft, suiteJudgeConfig],
  );
  return (
    <CaseOutcome
      ordinal={2}
      draft={draft}
      card={card}
      readOnly={readOnly}
      onEdit={(edit) =>
        setDraft((current) => {
          const next = edit(current);
          onChange?.(next);
          return next;
        })
      }
      onOpenSuiteSettings={onOpenSuiteSettings}
    />
  );
}

const toolErrorSwitch = () =>
  screen.getByRole("switch", {
    name: "Fail this case when a tool call returns an error",
  });

describe("CaseOutcome", () => {
  it("shows the goal, the suite's judge and the skip switch", () => {
    renderWithProviders(
      <Outcome initial={draftOf({ expectedOutput: "Two workspaces" })} />,
    );
    expect(
      screen.getByRole("textbox", { name: "Expected outcome" }),
    ).toHaveValue("Two workspaces");
    expect(
      screen.getByText(/openai\/gpt-5\.4-mini · threshold 0\.7/),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Skip the judge for this case" }),
    ).not.toBeChecked();
  });

  it("turns the tool-error setting off and back on", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Outcome initial={draftOf()} onChange={onChange} />);
    const user = userEvent.setup();
    expect(toolErrorSwitch()).toBeChecked();
    await user.click(toolErrorSwitch());
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ advancedConfig: { failOnToolError: false } }),
    );
    expect(toolErrorSwitch()).not.toBeChecked();
    await user.click(toolErrorSwitch());
    expect(onChange.mock.lastCall?.[0].advancedConfig).toBeUndefined();
  });

  it("shows a case's stored tool-error setting", () => {
    renderWithProviders(
      <Outcome
        initial={draftOf({ advancedConfig: { failOnToolError: false } })}
      />,
    );
    expect(toolErrorSwitch()).not.toBeChecked();
  });

  it("says the judge is off for the suite, with a way to its settings", async () => {
    const onOpenSuiteSettings = vi.fn();
    renderWithProviders(
      <Outcome
        initial={draftOf()}
        suiteJudgeConfig={
          {
            goalCompletion: { ...judge.goalCompletion, enabled: false },
          } as EvalJudgeConfig
        }
        onOpenSuiteSettings={onOpenSuiteSettings}
      />,
    );
    expect(screen.getByText("Judge is off for this suite.")).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Skip the judge for this case" }),
    ).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Expected outcome" }),
    ).not.toHaveAttribute("aria-describedby");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Edit in suite settings" }));
    expect(onOpenSuiteSettings).toHaveBeenCalled();
  });

  it("skips the judge for this case and back, leaving no override", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Outcome initial={draftOf()} onChange={onChange} />);
    const user = userEvent.setup();
    const skip = () =>
      screen.getByRole("switch", { name: "Skip the judge for this case" });
    await user.click(skip());
    expect(onChange.mock.lastCall![0].judgeConfigOverride).toEqual({
      goalCompletion: { enabled: false },
    });
    await user.click(skip());
    expect(onChange.mock.lastCall![0].judgeConfigOverride).toBeUndefined();
  });

  it("writes the expected outcome as typed", async () => {
    const onChange = vi.fn();
    renderWithProviders(<Outcome initial={draftOf()} onChange={onChange} />);
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Expected outcome" }), " Two ");
    expect(onChange.mock.lastCall![0].expectedOutput).toBe(" Two ");
  });

  it("hides the tool-error switch when the case is read-only", () => {
    renderWithProviders(<Outcome initial={draftOf()} readOnly />);
    expect(
      screen.queryByRole("switch", {
        name: "Fail this case when a tool call returns an error",
      }),
    ).toBeNull();
  });
});

describe("CaseAfterRun", () => {
  function renderAfterRun(
    draft: CaseStepsDraft,
    openKey: string | null = null,
    readOnly = false,
  ) {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    renderWithProviders(
      <CaseAfterRun
        ordinal={3}
        section={afterRunSection(cardOf(draft))}
        draft={draft}
        suiteName="Asana basics"
        suiteDefaultMatchOptions={undefined}
        availableTools={[]}
        readOnly={readOnly}
        checkPolicy
        openKey={openKey}
        onToggle={vi.fn()}
        onOpen={onOpen}
        onEdit={onEdit}
        onOpenSuiteSettings={vi.fn()}
      />,
    );
    return { onOpen, onEdit };
  }

  const twoCase = () =>
    draftOf({
      predicates: {
        mode: "extend",
        list: [
          { type: "responseContains", needle: "One" },
          { type: "responseContains", needle: "Two" },
        ],
      },
    });

  it.each([
    ["case:0", null],
    ["case:1", "case:0"],
  ])(
    "removing the first case row with %s open opens %s",
    async (open, next) => {
      const { onOpen, onEdit } = renderAfterRun(twoCase(), open);
      const user = userEvent.setup();
      const [first] = screen.getAllByLabelText(/Options for Response contains/);
      await user.click(first!);
      await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
      expect(onOpen).toHaveBeenCalledWith(next);
      const removed = onEdit.mock.lastCall![0](twoCase());
      expect(removed.predicates.list).toEqual([
        { type: "responseContains", needle: "Two" },
      ]);
    },
  );

  it("lists the suite's defaults under its heading", () => {
    renderAfterRun(draftOf());
    expect(
      screen.getByRole("heading", { name: "After-run assertions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No tool errors")).toBeInTheDocument();
  });

  it("says how many suite evaluators a replacing case leaves out", () => {
    renderAfterRun(
      draftOf({
        predicates: {
          mode: "replace",
          list: [{ type: "finalAssistantMessageNonEmpty" }],
        },
      }),
    );
    expect(
      screen.getByText(
        "Suite evaluators are replaced for this case, so 1 is not applied.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply suite evaluators too" }),
    ).toBeInTheDocument();
  });

  const user = () => userEvent.setup();
  const openMenu = async (label: RegExp) => {
    const u = user();
    await u.click(screen.getAllByLabelText(label)[0]!);
    return u;
  };
  const tool = (id: string, toolName: string): TestStep => ({
    id,
    kind: "assert",
    assertion: { type: "toolCalledWith", toolName, args: { args: {} } },
  });

  it("No tools → Remove brings the parked tool assertions back", async () => {
    const parked = chooseNoTool(
      draftOf({
        steps: [...steps, tool("t1", "get_me")],
        toolsChoice: "tools",
      }),
    );
    const { onEdit } = renderAfterRun(parked);
    const u = await openMenu(/Options for No tools/);
    await u.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const next = onEdit.mock.lastCall![0](parked);
    expect(next.toolsChoice).toBe("tools");
    expect(next.steps).toEqual([...steps, tool("t1", "get_me")]);
  });

  it("Exact order → Remove gives back the case it was added to", async () => {
    const before = draftOf();
    const exact = draftOf({
      steps: [...steps, tool("t1", "")],
      toolsChoice: "tools",
      kind: "regression",
      matchOptions: {
        toolCallOrder: "strict",
        maxExtraToolCalls: 0,
        argumentMatching: "partial",
      },
    });
    const { onEdit } = renderAfterRun(exact);
    const u = await openMenu(
      /Options for Tools must be called in this exact order/,
    );
    await u.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(onEdit.mock.lastCall![0](exact)).toEqual({
      ...before,
      kind: undefined,
      matchOptions: undefined,
    });
  });

  it("switches the suite's evaluators off and back on, keeping the case's", async () => {
    const list: Predicate[] = [{ type: "responseContains", needle: "One" }];
    const extend = draftOf({ predicates: { mode: "extend", list } });
    const { onEdit } = renderAfterRun(extend);
    const u = await openMenu(/Options for No tool errors/);
    await u.click(
      await screen.findByRole("menuitem", {
        name: "Replace suite evaluators for this case",
      }),
    );
    const replaced = onEdit.mock.lastCall![0](extend);
    expect(replaced.predicates).toEqual({ mode: "replace", list });
  });

  it("Apply suite evaluators too brings the suite rows back", async () => {
    const list: Predicate[] = [{ type: "responseContains", needle: "One" }];
    const replace = draftOf({ predicates: { mode: "replace", list } });
    const { onEdit } = renderAfterRun(replace);
    expect(screen.queryByText("No tool errors")).toBeNull();
    await user().click(
      screen.getByRole("button", { name: "Apply suite evaluators too" }),
    );
    const extended = onEdit.mock.lastCall![0](replace);
    expect(extended.predicates).toEqual({ mode: "extend", list });
    expect(
      afterRunSection(cardOf(extended)).suiteRows.map((row) => row.label),
    ).toHaveLength(1);
  });

  describe("the add drawer", () => {
    const pick = async (name: RegExp) => {
      const u = user();
      await u.click(
        screen.getByRole("button", { name: "Add after-run assertion" }),
      );
      await u.click(await screen.findByRole("button", { name }));
    };

    it("offers whole-run assertions and both route rules, no per-step kinds", async () => {
      renderAfterRun(draftOf());
      await user().click(
        screen.getByRole("button", { name: "Add after-run assertion" }),
      );
      expect(
        await screen.findByRole("button", {
          name: /^No tools should be called/,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: /^Tools must be called in this exact order/,
        }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /^Tool was called with/ }),
      ).toBeNull();
    });

    it("adds a whole-run assertion at the end of the case list", async () => {
      const { onEdit, onOpen } = renderAfterRun(draftOf());
      await pick(/^Token budget under N/);
      const next = onEdit.mock.lastCall![0](draftOf());
      expect(next.predicates).toEqual({
        mode: "extend",
        list: [expect.objectContaining({ type: "tokenBudgetUnder" })],
      });
      expect(onOpen).toHaveBeenCalledWith("case:0");
    });

    it("Exact order on a case with no tools adds a blank tool assertion", async () => {
      const { onEdit, onOpen } = renderAfterRun(draftOf());
      await pick(/^Tools must be called in this exact order/);
      const next = onEdit.mock.lastCall![0](draftOf());
      expect(next.kind).toBe("regression");
      expect(next.steps[1]).toMatchObject({
        kind: "assert",
        assertion: { type: "toolCalledWith", toolName: "" },
      });
      expect(onOpen).toHaveBeenCalledWith("route");
    });

    it("No tools parks the tool assertions", async () => {
      const withTool = draftOf({
        steps: [...steps, tool("t1", "get_me")],
        toolsChoice: "tools",
      });
      const { onEdit } = renderAfterRun(withTool);
      await pick(/^No tools should be called/);
      const next = onEdit.mock.lastCall![0](withTool);
      expect(next.toolsChoice).toBe("noTool");
      expect(next.steps).toEqual(steps);
      expect(next.stashedTools.map((parked) => parked.id)).toEqual(["t1"]);
    });
  });

  it("skips a case row that has no predicate index", () => {
    const draft = twoCase();
    const section = afterRunSection(cardOf(draft));
    renderWithProviders(
      <CaseAfterRun
        ordinal={3}
        section={{
          ...section,
          caseRows: section.caseRows.map((row, i) =>
            i === 0 ? { ...row, predicateIndex: undefined } : row,
          ),
        }}
        draft={draft}
        suiteName="Asana basics"
        suiteDefaultMatchOptions={undefined}
        availableTools={[]}
        readOnly={false}
        checkPolicy
        openKey={null}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onOpenSuiteSettings={vi.fn()}
      />,
    );
    expect(
      screen.getAllByLabelText(/Options for Response contains/),
    ).toHaveLength(1);
  });

  it("shows no menus, adds or switches, and locks fields when read-only", () => {
    renderAfterRun(
      draftOf({
        predicates: {
          mode: "replace",
          list: [{ type: "responseContains", needle: "One" }],
        },
      }),
      "case:0",
      true,
    );
    expect(screen.queryByLabelText(/^Options for/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add after-run assertion" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Apply suite evaluators too" }),
    ).toBeNull();
    expect(document.querySelector("fieldset")).toBeDisabled();
  });
});
