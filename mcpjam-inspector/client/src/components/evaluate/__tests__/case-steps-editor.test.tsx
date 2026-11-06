import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalJudgeConfig } from "@/components/evals/types";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";
import {
  CaseStepsEditor,
  type CaseStepsDraft,
} from "../case-steps/case-steps-editor";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

const sketch: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Sketch a tiny flow" },
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "read_me",
      args: { args: {} },
    },
  },
  {
    id: "a2",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "create_view",
      args: { args: {} },
    },
  },
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

const suiteDefaults: Predicate[] = [
  { type: "noToolErrors" },
  { type: "finalAssistantMessageNonEmpty" },
  { type: "tokenBudgetUnder", tokens: 250000, role: "advisory" } as Predicate,
];

const base = (over: Partial<CaseStepsDraft> = {}): CaseStepsDraft => ({
  title: "Sketch a two-node flow",
  runs: 1,
  steps: sketch,
  expectedOutput: "Composition: two boxes and an arrow.",
  toolsChoice: "tools",
  stashedTools: [],
  ...over,
});

function Harness({
  initial,
  onChange,
  judgeConfig = judge,
}: {
  initial: CaseStepsDraft;
  onChange?: (draft: CaseStepsDraft) => void;
  judgeConfig?: EvalJudgeConfig;
}) {
  const [draft, setDraft] = useState(initial);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const card = useMemo(
    () =>
      buildCaseScorecard({
        steps: draft.steps,
        toolsChoice: draft.toolsChoice,
        kind: draft.kind,
        matchOptions: draft.matchOptions,
        predicates: draft.predicates,
        suiteDefaultPredicates: suiteDefaults,
        expectedOutput: draft.expectedOutput,
        judgeConfigOverride: draft.judgeConfigOverride,
        suiteJudgeConfig: judgeConfig,
        numbering: "action",
      }),
    [draft, judgeConfig],
  );
  return (
    <CaseStepsEditor
      draft={draft}
      onDraftChange={(update) =>
        setDraft((current) => {
          const next = update(current);
          onChange?.(next);
          return next;
        })
      }
      card={card}
      suite={{
        name: "Excalidraw quickstart",
        judgeConfig,
        defaultPredicates: suiteDefaults,
        servers: ["excalidraw"],
      }}
      availableTools={[]}
      readOnly={false}
      openKey={openKey}
      onOpenKeyChange={setOpenKey}
      flashKey={null}
      arriving={false}
      onOpenSuiteSettings={() => {}}
    />
  );
}

const heading = (name: string) => screen.getByRole("heading", { name });
const markerOf = (name: string) =>
  heading(name).closest("section")!.querySelector("span.rounded-full")!
    .textContent;

describe("CaseStepsEditor structure", () => {
  it("nests the sketch case's assertions under step 1, then outcome 2 and after-run 3", () => {
    render(<Harness initial={base()} />);
    expect(markerOf("User prompt")).toBe("1");
    const group = screen.getByRole("group", {
      name: "Assertions after step 1",
    });
    expect(within(group).getByText("Assertions at this point")).toBeTruthy();
    expect(within(group).getAllByText("Tool was called with:")).toHaveLength(2);
    expect(markerOf("Expected outcome")).toBe("2");
    expect(markerOf("After-run assertions")).toBe("3");
    expect(screen.getByLabelText("What does the user ask?")).toBeTruthy();
    expect(screen.getByText("Token budget under 250000")).toBeTruthy();
  });

  it("a blank draft has no assertions heading", () => {
    render(
      <Harness
        initial={base({
          steps: [{ id: "p1", kind: "prompt", prompt: "" }],
          expectedOutput: "",
          toolsChoice: "unset",
        })}
      />,
    );
    expect(screen.queryByText("Assertions at this point")).toBeNull();
    expect(markerOf("Expected outcome")).toBe("2");
  });

  it("a leading assert shows Before the first step", () => {
    render(
      <Harness
        initial={base({
          steps: [
            { id: "l1", kind: "assert", assertion: { type: "noToolErrors" } },
            ...sketch,
          ],
        })}
      />,
    );
    expect(heading("Before the first step")).toBeTruthy();
    expect(screen.getByText("Graded before anything runs.")).toBeTruthy();
  });

  it("Interact and Call tool steps use STEP_COPY and the follow-up label", () => {
    render(
      <Harness
        initial={base({
          steps: [
            ...sketch,
            {
              id: "i1",
              kind: "interact",
              toolName: "",
              action: { kind: "click", target: { testId: "" } },
            },
            { id: "p2", kind: "prompt", prompt: "" },
          ],
        })}
      />,
    );
    expect(heading("Interact")).toBeTruthy();
    expect(
      screen.getByText("MCPJam acts in the rendered view. No model."),
    ).toBeTruthy();
    expect(screen.getByText("Pick a view")).toBeTruthy();
    expect(screen.getByLabelText("Follow-up prompt")).toBeTruthy();
    expect(screen.getByLabelText("Options for step 2")).toBeTruthy();
  });
});

describe("CaseStepsEditor editing", () => {
  it("typing a prompt and an outcome updates the flat list and expectedOutput", () => {
    const onChange = vi.fn();
    render(<Harness initial={base()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("What does the user ask?"), {
      target: { value: "Draw two boxes" },
    });
    expect(onChange.mock.lastCall![0].steps[0].prompt).toBe("Draw two boxes");
    fireEvent.change(
      screen.getByRole("textbox", { name: "Expected outcome" }),
      {
        target: { value: "Two boxes" },
      },
    );
    expect(onChange.mock.lastCall![0].expectedOutput).toBe("Two boxes");
  });

  it("removing a step with assertions asks first and both choices give the right list", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const twoSteps = [
      ...sketch,
      { id: "p2", kind: "prompt", prompt: "And?" } as TestStep,
    ];
    render(
      <Harness
        initial={base({ steps: [twoSteps[3]!, ...sketch] })}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("Options for step 2"));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(
      screen.getByText(
        "Its 2 assertions will move under step 1 and be graded after it instead.",
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Remove step and its assertions" }),
    );
    expect(onChange.mock.lastCall![0].steps.map((s: TestStep) => s.id)).toEqual(
      ["p2"],
    );
  });

  it("Move down swaps whole blocks", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const p2: TestStep = { id: "p2", kind: "prompt", prompt: "And?" };
    render(
      <Harness
        initial={base({ steps: [...sketch, p2] })}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("Options for step 1"));
    await user.click(
      await screen.findByRole("menuitem", { name: "Move down" }),
    );
    expect(onChange.mock.lastCall![0].steps.map((s: TestStep) => s.id)).toEqual(
      ["p2", "p1", "a1", "a2"],
    );
  });
});

describe("After-run assertions", () => {
  it("orders route, suite, case and offers the suite row menu", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={base({
          toolsChoice: "noTool",
          steps: [sketch[0]!],
          predicates: {
            mode: "extend",
            list: [{ type: "responseContains", needle: "End" }],
          },
        })}
      />,
    );
    const section = heading("After-run assertions").closest("section")!;
    const labels = [...section.querySelectorAll("[data-case-step-toggle]")].map(
      (el) => el.textContent,
    );
    expect(labels[0]).toBe("No tools should be called");
    expect(labels.at(-1)).toContain("Response contains");
    await user.click(
      within(section).getByLabelText("Options for No tool errors"),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Edit in suite settings" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: "Replace suite evaluators for this case",
      }),
    ).toBeTruthy();
  });

  it("replace mode shows the note and Apply suite evaluators too goes back to extend", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={base({ predicates: { mode: "replace", list: [] } })}
        onChange={onChange}
      />,
    );
    expect(
      screen.getByText(
        /Suite evaluators replaced for this case: 3 are not applied\./,
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Apply suite evaluators too" }),
    );
    expect(onChange.mock.lastCall![0].predicates.mode).toBe("extend");
  });

  it("judge off hides the hint and offers Edit in suite settings", () => {
    render(
      <Harness
        initial={base()}
        judgeConfig={
          { goalCompletion: { enabled: false } } as unknown as EvalJudgeConfig
        }
      />,
    );
    expect(screen.getByText("Judge is off for this suite.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit in suite settings" }),
    ).toBeTruthy();
    expect(
      screen.queryByText(/The judge grades against this sentence/),
    ).toBeNull();
  });

  it("the skip switch writes the case's judge opt-out", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={base()} onChange={onChange} />);
    expect(
      screen.getByText(/openai\/gpt-5\.4-mini · threshold 0\.7/),
    ).toBeTruthy();
    await user.click(screen.getByLabelText("Skip the judge for this case"));
    expect(onChange.mock.lastCall![0].judgeConfigOverride).toEqual({
      goalCompletion: { enabled: false },
    });
  });
});
