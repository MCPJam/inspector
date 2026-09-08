/**
 * The spine, and the quiet first-run form in front of it.
 *
 * Two claims are load-bearing here. First, a case that is still just a prompt
 * asks two questions and nothing else — the whole point of the pivot is that a
 * newcomer sees value before they see vocabulary. Second, once the case says
 * more than that, EVERY step is on one list at a position: no leftovers, no
 * hatch to a second editor, and a check nested under the action it grades.
 */

import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestStep } from "@/shared/steps";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { WIDGET_ASSERTION_LABELS } from "@/shared/steps";
import { CaseSpine } from "../case-spine/case-spine";
import { SimpleCaseForm } from "../simple-case/simple-case-form";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

const promptOnly: TestStep[] = [
  { id: "turn-1", kind: "prompt", prompt: "Which account am I signed in as?" },
];

const golden: TestStep[] = [
  ...promptOnly,
  { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
  {
    id: "a2",
    kind: "assert",
    assertion: { type: "toolCalledAtLeastOnce", toolName: "get_me" },
  },
];

const twoTurn: TestStep[] = [
  ...promptOnly,
  { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
  { id: "turn-2", kind: "prompt", prompt: "And my org?" },
  {
    id: "a2",
    kind: "assert",
    assertion: { type: "finalAssistantMessageNonEmpty" },
  },
];

const withClick: TestStep[] = [
  ...promptOnly,
  {
    id: "i1",
    kind: "interact",
    toolName: "cart_view",
    action: { kind: "click", target: { testId: "add" } },
  },
  {
    id: "w1",
    kind: "assert",
    assertion: {
      kind: "widgetToolCalled",
      toolName: "cart_view",
      calledToolName: "add_item",
    },
  },
];

const pinnedFirst: TestStep[] = [
  {
    id: "call-1",
    kind: "toolCall",
    serverName: "srv",
    toolName: "render_widget",
    arguments: {},
  },
];

function StatefulSpine(props: Partial<ComponentProps<typeof CaseSpine>> = {}) {
  const [steps, setSteps] = useState(props.steps ?? promptOnly);
  const [matchOptions, setMatchOptions] = useState(props.matchOptions);
  const [expectedOutput, setExpectedOutput] = useState(
    props.expectedOutput ?? "",
  );
  const [predicates, setPredicates] = useState(props.predicates);
  const [toolsChoice, setToolsChoice] = useState(props.toolsChoice);
  return (
    <CaseSpine
      {...props}
      steps={steps}
      onStepsChange={(next) => {
        setSteps(next);
        props.onStepsChange?.(next);
      }}
      matchOptions={matchOptions}
      onMatchOptionsChange={(next) => {
        setMatchOptions(next);
        props.onMatchOptionsChange?.(next);
      }}
      expectedOutput={expectedOutput}
      onExpectedOutputChange={(next) => {
        setExpectedOutput(next);
        props.onExpectedOutputChange?.(next);
      }}
      predicates={predicates}
      onPredicatesChange={(next) => {
        setPredicates(next);
        props.onPredicatesChange?.(next);
      }}
      toolsChoice={toolsChoice}
      onToolsChoiceChange={(next) => {
        setToolsChoice(next);
        props.onToolsChoiceChange?.(next);
      }}
      availableTools={props.availableTools ?? [{ name: "get_me" }]}
    />
  );
}

const openSpine = async (
  props: Partial<ComponentProps<typeof CaseSpine>> = {},
) => {
  const user = userEvent.setup();
  render(<StatefulSpine {...props} />);
  const more = screen.queryByTestId("spine-more-options");
  if (more) await user.click(more);
  return user;
};

describe("the first-run form", () => {
  it("asks two questions and offers Run — nothing else", () => {
    render(<StatefulSpine runControl={<button>Run test</button>} />);
    expect(screen.getByTestId("case-spine")).toHaveAttribute(
      "data-state",
      "first-run",
    );
    expect(screen.getByLabelText("What does the user ask?")).toBeTruthy();
    expect(
      screen.getByText("What should a successful answer accomplish?"),
    ).toBeTruthy();
    expect(screen.getByText("Run test")).toBeTruthy();
    // The vocabulary a newcomer has not earned yet.
    const text = screen.getByTestId("case-spine").textContent ?? "";
    expect(text).not.toMatch(/Scorers|Gate|Warn|Report|Judge · /);
    expect(screen.queryByTestId("spine-actions")).toBeNull();
    expect(screen.queryByTestId("spine-after-the-run")).toBeNull();
  });

  it("says what the goal sentence is for, in one line", () => {
    render(<StatefulSpine />);
    expect(
      screen.getByText("A model grades each run against this."),
    ).toBeTruthy();
  });

  it("writes the prompt through the same writer the form used", async () => {
    const onStepsChange = vi.fn();
    const user = userEvent.setup();
    render(<StatefulSpine steps={[]} onStepsChange={onStepsChange} />);
    await user.type(screen.getByLabelText("What does the user ask?"), "hi");
    expect(onStepsChange).toHaveBeenCalled();
    const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(written[0]).toMatchObject({ kind: "prompt" });
  });

  it("reveals the rest behind More options without losing the prompt", async () => {
    const user = await openSpine();
    expect(screen.getByTestId("case-spine")).toHaveAttribute(
      "data-state",
      "spine",
    );
    expect(screen.getByTestId("spine-after-the-run")).toBeTruthy();
    expect(
      (screen.getByLabelText("What does the user ask?") as HTMLTextAreaElement)
        .value,
    ).toContain("Which account");
    expect(user).toBeTruthy();
  });

  it("shows the spine directly once the case carries a check", () => {
    render(<StatefulSpine steps={golden} />);
    expect(screen.getByTestId("case-spine")).toHaveAttribute(
      "data-state",
      "spine",
    );
  });
});

describe("the spine", () => {
  it("puts every step on one list, at a position", async () => {
    await openSpine({ steps: twoTurn });
    const actions = screen.getAllByTestId("spine-action-row");
    expect(actions.map((el) => el.getAttribute("data-step-id"))).toEqual([
      "turn-1",
      "turn-2",
    ]);
    // The old form could not author a second prompt and listed it under
    // "Also in this case" with a link to a different editor.
    expect(screen.queryByTestId("simple-case-leftover-row")).toBeNull();
    expect(screen.queryByText("Steps")).toBeNull();
  });

  it("nests each check under the action it follows", async () => {
    await openSpine({ steps: withClick });
    const [prompt, click] = screen.getAllByTestId("spine-action-row");
    expect(within(prompt!).queryAllByTestId("case-scorecard-row")).toHaveLength(
      0,
    );
    const clickChecks = within(click!).getAllByTestId("case-scorecard-row");
    expect(clickChecks.map((el) => el.getAttribute("data-step-id"))).toEqual([
      "w1",
    ]);
  });

  it("numbers the actions 1..N", async () => {
    await openSpine({ steps: twoTurn });
    expect(
      screen
        .getAllByTestId("spine-action-row")
        .map((el) => el.getAttribute("data-ordinal")),
    ).toEqual(["1", "2"]);
  });

  it("makes a second prompt editable in place", async () => {
    const user = await openSpine({ steps: twoTurn });
    const second = screen.getByLabelText("Prompt for step 2");
    await user.type(second, "!");
    expect((second as HTMLTextAreaElement).value).toContain("!");
  });

  it("offers a check after each action, and lands it at that position", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: golden, onStepsChange });
    const [prompt] = screen.getAllByTestId("spine-action-row");
    await user.click(
      within(prompt!).getByRole("button", { name: "Add a check after this" }),
    );
    await user.click(screen.getByTestId("add-scorer-noToolErrors"));
    const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    // After the prompt's whole block — behind a1 and a2, never in front of
    // a gate that already exists.
    expect(written.map((s) => s.id.replace(/-\d+-\d+$/, "-NEW"))).toEqual([
      "turn-1",
      "a1",
      "a2",
      "assert-NEW",
    ]);
  });

  it("offers view checks only where a position exists", async () => {
    const user = await openSpine({ steps: withClick });
    const [, click] = screen.getAllByTestId("spine-action-row");
    await user.click(
      within(click!).getByRole("button", { name: "Add a check after this" }),
    );
    expect(
      screen.getByTestId("add-widget-check-widgetToolCalled"),
    ).toBeTruthy();
  });

  it("adds a whole-run check to the envelope, not to the steps", async () => {
    const onStepsChange = vi.fn();
    const onPredicatesChange = vi.fn();
    const user = await openSpine({
      steps: golden,
      onStepsChange,
      onPredicatesChange,
    });
    const after = screen.getByTestId("spine-after-the-run");
    await user.click(
      within(after).getByRole("button", {
        name: "Add a check on the whole run",
      }),
    );
    await user.click(screen.getByTestId("add-scorer-tokenBudgetUnder"));
    expect(onPredicatesChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "extend" }),
    );
    expect(onStepsChange).not.toHaveBeenCalled();
  });

  it("lets a recorded view check be edited, which the form could not", async () => {
    const user = await openSpine({ steps: withClick });
    const row = screen.getAllByTestId("case-scorecard-row")[0]!;
    expect(row.getAttribute("data-widget")).toBe("yes");
    await user.click(within(row).getByRole("button", { name: /^Edit / }));
    expect(row.getAttribute("aria-expanded") ?? "").not.toBe("false");
  });

  it("keeps a leading check visible instead of hiding it", async () => {
    await openSpine({
      steps: [
        { id: "a0", kind: "assert", assertion: { type: "noToolErrors" } },
        ...promptOnly,
      ],
    });
    expect(screen.getByTestId("spine-leading-checks")).toBeTruthy();
    expect(screen.getByText("Before the first step")).toBeTruthy();
  });

  it("asks before a delete would re-parent checks to another step", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: twoTurn, onStepsChange });
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.getByTestId("spine-delete-action")).toBeTruthy();
    expect(
      screen.getByText(/will move under step 1 and run after it instead/),
    ).toBeTruthy();
    expect(onStepsChange).not.toHaveBeenCalled();
  });

  it("warns that the first step's checks would run before any prompt", async () => {
    const user = await openSpine({ steps: golden });
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(screen.getByText(/would run before any prompt/)).toBeTruthy();
  });

  it("deletes without asking when the action stands alone", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({
      steps: [...promptOnly, { id: "turn-2", kind: "prompt", prompt: "b" }],
      onStepsChange,
    });
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.queryByTestId("spine-delete-action")).toBeNull();
    expect(onStepsChange).toHaveBeenCalled();
  });

  it("moves an action with the checks under it", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: twoTurn, onStepsChange });
    await user.click(screen.getByRole("button", { name: "Move step 1 down" }));
    const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(written.map((s) => s.id)).toEqual(["turn-2", "a2", "turn-1", "a1"]);
  });

  it("offers nothing to change when read-only", async () => {
    render(<StatefulSpine steps={golden} readOnly />);
    expect(screen.queryByRole("button", { name: /^Remove step/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move step/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add a check after this" }),
    ).toBeNull();
  });

  it("keeps the recording control, disabled until there is a prompt", async () => {
    render(<StatefulSpine steps={[{ id: "p", kind: "prompt", prompt: "" }]} />);
    // A blank prompt is still the quiet state; reveal the spine.
    await userEvent.setup().click(screen.getByTestId("spine-more-options"));
    expect(screen.getByTestId("simple-case-start-recording")).toBeDisabled();
  });

  it("shows the route question under the first action", async () => {
    await openSpine({ steps: golden });
    const [prompt] = screen.getAllByTestId("spine-action-row");
    expect(within(prompt!).getByTestId("case-route-row")).toBeTruthy();
  });

  it("locks the route on a model-free case but keeps the call editable", async () => {
    await openSpine({ steps: pinnedFirst });
    expect(screen.getByTestId("simple-case-route-locked")).toBeTruthy();
    expect(screen.getByLabelText("Edit step 1")).toBeTruthy();
  });

  it("offers a way back out of a replaced suite envelope", async () => {
    const onPredicatesChange = vi.fn();
    const user = await openSpine({
      steps: golden,
      predicates: { mode: "replace", list: [{ type: "noToolErrors" }] },
      suiteDefaultPredicates: [{ type: "finalAssistantMessageNonEmpty" }],
      onPredicatesChange,
    });
    await user.click(screen.getByText("Apply suite scorers too"));
    expect(onPredicatesChange).toHaveBeenCalledWith({
      mode: "extend",
      list: [{ type: "noToolErrors" }],
    });
  });

  it("never prints a wire enum for a kind this build knows", async () => {
    await openSpine({
      steps: [...golden, ...withClick.slice(1)],
      predicates: {
        mode: "extend",
        list: [{ type: "tokenBudgetUnder", tokens: 100 }],
      },
      suiteDefaultPredicates: [{ type: "finalAssistantMessageNonEmpty" }],
    });
    const text = screen.getByTestId("case-spine").textContent ?? "";
    for (const kind of Object.keys(PREDICATE_KIND_LABELS)) {
      expect(text).not.toContain(kind);
    }
    for (const kind of Object.keys(WIDGET_ASSERTION_LABELS)) {
      expect(text).not.toContain(kind);
    }
    expect(text).not.toContain("toolCall");
    expect(text).not.toContain("interact");
  });
});

/**
 * The spine writes the SAME case the form wrote.
 *
 * It replaces three editing surfaces at once, so the risk is not a missing
 * control — it is that one of them writes a subtly different document. Each
 * shape below is authored through BOTH components, given the same edit, and
 * the emitted steps are compared. A difference here is a silent grading change.
 */
describe("save parity with the form", () => {
  const SHAPES: Array<{ name: string; steps: TestStep[] }> = [
    { name: "prompt only", steps: promptOnly },
    { name: "golden checks", steps: golden },
    { name: "two turn", steps: twoTurn },
    { name: "prompt + click + view check", steps: withClick },
    { name: "pinned first", steps: pinnedFirst },
    {
      name: "route tool",
      steps: [
        ...promptOnly,
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
    },
    {
      name: "advisory toolCalledWith (SDK-authored)",
      steps: [
        ...promptOnly,
        {
          id: "t1",
          kind: "assert",
          assertion: {
            type: "toolCalledWith",
            toolName: "get_me",
            args: { args: {} },
            role: "advisory",
          },
        },
      ],
    },
    {
      name: "leading check",
      steps: [
        { id: "a0", kind: "assert", assertion: { type: "noToolErrors" } },
        ...promptOnly,
      ],
    },
  ];

  /** Type one character into the prompt through whichever pane is mounted. */
  async function typeIntoPrompt(
    node: React.ReactElement,
    onStepsChange: ReturnType<typeof vi.fn>,
  ) {
    const user = userEvent.setup();
    const { unmount } = render(node);
    const more = screen.queryByTestId("spine-more-options");
    if (more) await user.click(more);
    // A model-free case has no prompt at all on the spine (it shows the pinned
    // call instead of the form's empty, read-only prompt box), so there is
    // nothing to type; the shape is still compared for what each pane emits.
    const prompt = screen.queryByLabelText("What does the user ask?");
    if (prompt && !(prompt as HTMLTextAreaElement).readOnly) {
      await user.type(prompt, "X");
    }
    const written = onStepsChange.mock.calls.at(-1)?.[0] as
      TestStep[] | undefined;
    unmount();
    return written;
  }

  it.each(SHAPES)(
    "emits the same steps as the form for $name",
    async ({ steps }) => {
      const spineSpy = vi.fn();
      const fromSpine = await typeIntoPrompt(
        <StatefulSpine steps={steps} onStepsChange={spineSpy} />,
        spineSpy,
      );
      const formSpy = vi.fn();
      const fromForm = await typeIntoPrompt(
        <StatefulForm steps={steps} onStepsChange={formSpy} />,
        formSpy,
      );
      if (fromForm || !fromSpine) {
        // Both edited, or neither could (a model-free case has no prompt on
        // either pane). Either way the two agree.
        expect(fromSpine).toEqual(fromForm);
        return;
      }
      // The form REFUSED the edit on this shape — it locks the prompt box
      // whenever the case does not literally start with a prompt, which is how it
      // avoided `writeSimpleCase` prepending a second prompt. The spine edits the
      // step in place instead, so the edit is allowed; what parity means here is
      // that it stays an edit: same steps, same ids, same order.
      expect(fromSpine?.map((step) => step.id)).toEqual(steps.map((s) => s.id));
      expect(fromSpine?.map((step) => step.kind)).toEqual(
        steps.map((s) => s.kind),
      );
    },
  );

  it.each(SHAPES)("writes nothing on mount for $name", ({ steps }) => {
    const onStepsChange = vi.fn();
    const onPredicatesChange = vi.fn();
    const { unmount } = render(
      <StatefulSpine
        steps={steps}
        onStepsChange={onStepsChange}
        onPredicatesChange={onPredicatesChange}
      />,
    );
    // Opening a case must never mark it dirty.
    expect(onStepsChange).not.toHaveBeenCalled();
    expect(onPredicatesChange).not.toHaveBeenCalled();
    unmount();
  });
});

/** The form, mounted the same way, so parity is measured and not assumed. */
function StatefulForm(props: {
  steps: TestStep[];
  onStepsChange: (next: TestStep[]) => void;
}) {
  const [steps, setSteps] = useState(props.steps);
  const [matchOptions, setMatchOptions] =
    useState<ComponentProps<typeof SimpleCaseForm>["matchOptions"]>(undefined);
  const [expectedOutput, setExpectedOutput] = useState("");
  const [predicates, setPredicates] =
    useState<ComponentProps<typeof SimpleCaseForm>["predicates"]>(undefined);
  return (
    <SimpleCaseForm
      steps={steps}
      onStepsChange={(next) => {
        setSteps(next);
        props.onStepsChange(next);
      }}
      matchOptions={matchOptions}
      onMatchOptionsChange={setMatchOptions}
      expectedOutput={expectedOutput}
      onExpectedOutputChange={setExpectedOutput}
      predicates={predicates}
      onPredicatesChange={setPredicates}
      availableTools={["get_me"]}
      onOpenDeepEditor={vi.fn()}
    />
  );
}
