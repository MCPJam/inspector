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
}: {
  initial: CaseStepsDraft;
  readOnly?: boolean;
  onChange?: (draft: CaseStepsDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const card = useMemo(() => cardOf(draft), [draft]);
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
      onOpenSuiteSettings={vi.fn()}
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
        readOnly={false}
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
});
