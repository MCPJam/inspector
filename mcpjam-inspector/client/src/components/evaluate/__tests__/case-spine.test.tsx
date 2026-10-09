/** One editor preserves prompt, outcome, and ordered assertions. */

import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestStep } from "@/shared/steps";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { WIDGET_ASSERTION_LABELS } from "@/shared/steps";
import { CaseSpine } from "../case-spine/case-spine";
import { evaluateToolCalls } from "@mcpjam/sdk/matchers";
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
  it("keeps recording controls connected to the recorder", async () => {
    const user = userEvent.setup();
    const onStartRecording = vi.fn();
    const onStopRecording = vi.fn();
    const onAddCheck = vi.fn();
    const props = { onStartRecording, onStopRecording, onAddCheck };
    const { rerender } = render(<StatefulSpine {...props} />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    expect(onStartRecording).toHaveBeenCalledOnce();
    rerender(<StatefulSpine {...props} recording />);
    await user.click(screen.getByRole("button", { name: "Add check" }));
    await user.click(screen.getByRole("button", { name: "Stop", exact: true }));
    expect(onAddCheck).toHaveBeenCalledOnce();
    expect(onStopRecording).toHaveBeenCalledOnce();
  });

  it("labels the prompt and outcome and offers Add", () => {
    render(<StatefulSpine runControl={<button>Run test</button>} />);
    expect(screen.getByTestId("case-spine")).toHaveAttribute(
      "data-state",
      "spine",
    );
    expect(screen.getByLabelText("What does the user ask?")).toBeTruthy();
    expect(
      screen.getByLabelText("What does the user ask?"),
    ).toHaveAccessibleDescription("The message the user could send the agent.");
    expect(
      screen.getByLabelText("Expected outcome"),
    ).toHaveAccessibleDescription("The result the reply is judged against.");
    expect(screen.getByText("Assertions or actions")).toBeInTheDocument();
    expect(screen.getByText("Expected outcome")).toHaveClass(
      "text-card-foreground",
    );
    expect(screen.queryByText("Run test")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add assertion or action" }),
    ).toBeInTheDocument();
    // The vocabulary a newcomer has not earned yet.
    const text = screen.getByTestId("case-spine").textContent ?? "";
    expect(text).not.toMatch(/Evaluators|Scorers|Gate|Warn|Report|Judge · /);
    expect(screen.getByTestId("spine-actions")).toBeInTheDocument();
    expect(screen.queryByTestId("spine-after-the-run")).toBeNull();
  });

  it("retains prompt and outcome fields when adding an assertion", async () => {
    const user = userEvent.setup();
    render(
      <StatefulSpine
        expectedOutput="Shows my email"
        defaultChecks={<button>Show default evaluators</button>}
      />,
    );
    const prompt = screen.getByLabelText("What does the user ask?");
    const outcome = screen.getByLabelText("Expected outcome");
    await user.type(outcome, " correctly");
    const add = screen.getByRole("button", { name: "Add assertion or action" });
    expect(add).toHaveClass("w-full");
    expect(
      screen.getByRole("button", { name: "Show default evaluators" })
        .parentElement,
    ).toHaveClass("justify-end");
    await user.click(add);
    await user.type(
      screen.getByLabelText("Filter steps and assertions"),
      "element",
    );
    await user.click(screen.getByTestId("add-step-item-widget:elementVisible"));
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("What does the user ask?")).toBe(prompt);
    expect(screen.getByLabelText("Expected outcome")).toBe(outcome);
    expect(outcome).toHaveValue("Shows my email correctly");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("adds a blank prompt ready to type with its own Add button and one outcome", async () => {
    const user = userEvent.setup();
    render(<StatefulSpine expectedOutput="Shows my email" />);
    const first = screen.getByLabelText("What does the user ask?");
    const outcome = screen.getByLabelText("Expected outcome");
    await user.click(
      screen.getByRole("button", { name: "Add assertion or action" }),
    );
    await user.click(screen.getByTestId("add-step-item-prompt"));
    const second = screen.getByLabelText("Prompt for step 2");
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveValue("");
    expect(second).toHaveAccessibleDescription(
      "The message the user could send the agent.",
    );
    expect(second).toHaveClass("min-h-[72px]", "bg-card", "text-[15px]");
    expect(screen.getByLabelText("What does the user ask?")).toBe(first);
    expect(first).toHaveValue("Which account am I signed in as?");
    const rows = screen.getAllByTestId("spine-action-row");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(
        within(row).getByRole("button", { name: "Add assertion or action" }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByLabelText("Expected outcome")).toEqual([outcome]);
    expect(outcome).toHaveValue("Shows my email");
    await user.keyboard("And my org?");
    expect(second).toHaveValue("And my org?");
  });

  it("lets the assertion drawer close with Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<StatefulSpine />);
    const trigger = screen.getByRole("button", {
      name: "Add assertion or action",
    });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Filter steps and assertions"),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("adds a check to an empty draft while creating its required prompt", async () => {
    const onStepsChange = vi.fn();
    const user = userEvent.setup();
    render(<StatefulSpine steps={[]} onStepsChange={onStepsChange} />);
    await user.click(
      screen.getByRole("button", { name: "Add assertion or action" }),
    );
    await user.type(
      screen.getByLabelText("Filter steps and assertions"),
      "element",
    );
    await user.click(screen.getByTestId("add-step-item-widget:elementVisible"));
    const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(written[0]).toMatchObject({ kind: "prompt", prompt: "" });
    expect(written[1]).toMatchObject({
      kind: "assert",
      assertion: { kind: "elementVisible" },
    });
    expect(screen.getByTestId("case-spine")).toHaveAttribute(
      "data-state",
      "spine",
    );
  });

  it("keeps the first-run form free of redundant helper copy", () => {
    render(<StatefulSpine />);
    expect(
      screen.queryByText("A model grades each run against this."),
    ).not.toBeInTheDocument();
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

  it("has no More options switch or auxiliary panels", () => {
    render(<StatefulSpine />);
    expect(screen.queryByTestId("spine-more-options")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Run checks & judge criteria"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Recording & run options"),
    ).not.toBeInTheDocument();
  });

  it("shows the spine directly once the case carries a check", () => {
    render(<StatefulSpine steps={golden} />);
    expect(screen.getByTestId("case-spine")).toHaveAttribute(
      "data-state",
      "spine",
    );
  });
});

describe("Paper authoring rows", () => {
  async function add(user: ReturnType<typeof userEvent.setup>, key: string) {
    await user.click(
      screen
        .getAllByRole("button", { name: "Add assertion or action" })
        .at(-1)!,
    );
    await user.click(screen.getByTestId(`add-step-item-${key}`));
  }
  const marked = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-newest="true"]'));

  it("marks only the latest check or action, including after-run checks", async () => {
    const user = userEvent.setup();
    render(<StatefulSpine />);
    expect(marked()).toHaveLength(0);
    await add(user, "check:noToolErrors");
    expect(marked()).toHaveLength(1);
    expect(marked()[0]).toHaveTextContent("No tool errors");
    expect(marked()[0]).toHaveClass("before:bg-primary");
    await add(user, "widget:elementVisible");
    expect(marked()).toHaveLength(1);
    expect(marked()[0]).toHaveAttribute("data-widget", "yes");
    await add(user, "interact");
    expect(marked()).toHaveLength(1);
    expect(marked()[0]).toHaveAttribute("data-step-kind", "interact");
    await add(user, "check:turnCountUnder");
    expect(marked()).toHaveLength(1);
    expect(marked()[0]).toHaveTextContent("Fewer than N user turns");
    const afterRun = screen.getByRole("region", { name: "After run checks" });
    expect(afterRun).toContainElement(marked()[0]!);
    expect(
      screen
        .getByTestId("spine-expected-outcome-section")
        .compareDocumentPosition(afterRun) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Whole task")).toBeNull();
  });

  it("marks tool matching assertions that are edited through the route controls", async () => {
    const user = userEvent.setup();
    render(<StatefulSpine />);
    await add(user, "check:toolCalledWith");
    expect(marked()).toHaveLength(1);
    expect(marked()[0]).toHaveAttribute("data-testid", "simple-case-tool-row");
  });

  it("keeps the newest after-run marker on the same check when an earlier check is removed", async () => {
    const user = userEvent.setup();
    render(<StatefulSpine />);
    await add(user, "check:turnCountUnder");
    await add(user, "check:tokenBudgetUnder");
    await user.click(
      screen.getByRole("button", {
        name: "Options for Fewer than N user turns",
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove Fewer than N user turns" }),
    );
    expect(marked()).toHaveLength(1);
    expect(marked()[0]).toHaveTextContent("Token budget under N");
    await user.click(
      screen.getByRole("button", { name: "Options for Token budget under N" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove Token budget under N" }),
    );
    expect(marked()).toHaveLength(0);
  });

  it("does not remember the marker when the editor is reopened", async () => {
    const user = userEvent.setup();
    const onStepsChange = vi.fn();
    const { unmount } = render(<StatefulSpine onStepsChange={onStepsChange} />);
    await add(user, "check:noToolErrors");
    expect(marked()).toHaveLength(1);
    const savedSteps = onStepsChange.mock.lastCall![0];
    expect(savedSteps[1]).toEqual(
      expect.objectContaining({
        kind: "assert",
        assertion: { type: "noToolErrors" },
      }),
    );
    unmount();
    render(<StatefulSpine steps={savedSteps} />);
    expect(marked()).toHaveLength(0);
    expect(screen.getByText("No tool errors")).toBeInTheDocument();
  });

  it("keeps an interaction and its checks in the prompt's card and adds the next check after it", async () => {
    const user = userEvent.setup();
    const onStepsChange = vi.fn();
    render(<StatefulSpine steps={withClick} onStepsChange={onStepsChange} />);
    expect(screen.getAllByTestId("paper-action-group")).toHaveLength(1);
    const group = screen.getByTestId("paper-action-group");
    expect(group).toContainElement(
      screen.getAllByTestId("spine-action-row")[1]!,
    );
    await add(user, "check:noToolErrors");
    const written = onStepsChange.mock.lastCall![0] as TestStep[];
    expect(written.slice(0, withClick.length)).toEqual(withClick);
    expect(written.at(-1)).toMatchObject({
      kind: "assert",
      assertion: { type: "noToolErrors" },
    });
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

  it("keeps one Expected outcome for the whole case, after the last action, marked as the judge's", async () => {
    await openSpine({ steps: twoTurn });
    const outcome = screen.getByLabelText("Expected outcome");
    const section = screen.getByTestId("spine-expected-outcome-section");
    expect(section).toContainElement(outcome);
    // Not inside any prompt row: under prompt 1 it read as that prompt's
    // outcome, and prompt 2 then looked broken for having none.
    for (const row of screen.getAllByTestId("spine-action-row")) {
      expect(row).not.toContainElement(outcome);
    }
    const actions = screen.getByTestId("spine-actions");
    expect(
      actions.compareDocumentPosition(section) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(section).getByText("Judge").getAttribute("data-provenance"),
    ).toBe("judge");
    // The chip is beside the label, not inside it, so the field's name stays
    // "Expected outcome".
    expect(screen.getByLabelText("Expected outcome")).toBe(outcome);
  });

  it("keeps only the case judge opt-out below Expected outcome", async () => {
    const user = userEvent.setup();
    const onJudgeConfigOverrideChange = vi.fn();
    const props = {
      onJudgeConfigOverrideChange,
      suiteJudgeConfig: { goalCompletion: { enabled: true } },
    };
    const { rerender } = render(<StatefulSpine {...props} />);
    const section = screen.getByTestId("spine-expected-outcome-section");
    const toggle = within(section).getByRole("switch", {
      name: "Skip the judge for this case",
    });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByLabelText("Expected outcome").compareDocumentPosition(toggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Judge settings")).toBeNull();
    expect(screen.queryByTestId("case-judge-block")).toBeNull();
    expect(screen.queryByTestId("case-judge-facts")).toBeNull();

    await user.click(toggle);
    expect(onJudgeConfigOverrideChange).toHaveBeenLastCalledWith({
      goalCompletion: { enabled: false },
    });
    rerender(
      <StatefulSpine
        {...props}
        judgeConfigOverride={{ goalCompletion: { enabled: false } }}
      />,
    );
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(onJudgeConfigOverrideChange).toHaveBeenLastCalledWith(undefined);
  });

  it.each([
    { readOnly: true, onJudgeConfigOverrideChange: vi.fn() },
    {
      suiteJudgeConfig: { goalCompletion: { enabled: false } },
      onJudgeConfigOverrideChange: vi.fn(),
    },
    {},
  ])("hides the judge opt-out when it cannot be used (%j)", (props) => {
    render(<StatefulSpine {...props} />);
    expect(
      screen.queryByRole("switch", { name: "Skip the judge for this case" }),
    ).toBeNull();
  });

  it("nests each check under the action it follows", async () => {
    await openSpine({ steps: withClick });
    const [prompt, click] = screen.getAllByTestId("spine-action-row");
    expect(prompt).toContainElement(click!);
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
      within(prompt!).getByRole("button", { name: "Add assertion or action" }),
    );
    await user.type(
      screen.getByLabelText("Filter steps and assertions"),
      "errors",
    );
    await user.click(screen.getByTestId("add-step-item-check:noToolErrors"));
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
      within(click!).getByRole("button", { name: "Options for step 2" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add assertion or action",
      }),
    );
    await user.type(
      screen.getByLabelText("Filter steps and assertions"),
      "element",
    );
    expect(
      screen.getByTestId("add-step-item-widget:elementVisible"),
    ).toBeTruthy();
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
    const user = await openSpine({ steps: withClick, onStepsChange });
    await user.click(
      screen.getByRole("button", { name: "Options for step 2" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.getByTestId("spine-delete-action")).toBeTruthy();
    expect(
      screen.getByText(/will move under step 1 and run after it instead/),
    ).toBeTruthy();
    expect(onStepsChange).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alertdialog", {
      name: "Remove step",
    });
    expect(confirmation).toBeVisible();
    expect(screen.getByTestId("case-spine")).not.toContainElement(confirmation);
    expect(screen.queryByRole("button", { name: "Remove step 2" })).toBeNull();
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Remove step",
        exact: true,
      }),
    );
    expect(onStepsChange).toHaveBeenLastCalledWith([
      withClick[0],
      withClick[2],
    ]);
    expect(screen.queryByTestId("spine-delete-action")).toBeNull();
    expect(screen.queryByRole("button", { name: "Drag Interact" })).toBeNull();
  });

  it("can remove an action and its checks from the visible confirmation", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: withClick, onStepsChange });
    await user.click(
      screen.getByRole("button", { name: "Options for step 2" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Remove step and its check",
        exact: true,
      }),
    );
    expect(onStepsChange).toHaveBeenLastCalledWith([withClick[0]]);
    expect(screen.queryByTestId("spine-delete-action")).toBeNull();
  });

  it("cancels removal without changing the action or its checks", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: withClick, onStepsChange });
    await user.click(
      screen.getByRole("button", { name: "Options for step 2" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(onStepsChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("spine-delete-action")).toBeNull();
    expect(screen.getByRole("button", { name: "Drag Interact" })).toBeVisible();
  });

  it("lets an extra prompt be removed and keeps the last one", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({
      steps: [
        { id: "turn-1", kind: "prompt", prompt: "First" },
        { id: "turn-2", kind: "prompt", prompt: "Second" },
      ],
      onStepsChange,
    });
    expect(screen.getByRole("button", { name: "Remove step 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove step 2" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(written.map((step) => step.id)).toEqual(["turn-1"]);
    expect(screen.queryByRole("button", { name: "Remove step 1" })).toBeNull();
    expect(screen.getByLabelText("What does the user ask?")).toBeEnabled();
  });

  it("keeps the only prompt while other actions stay removable", async () => {
    const user = await openSpine({ steps: withClick });
    expect(screen.queryByRole("button", { name: "Remove step 1" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Options for step 2" }),
    );
    expect(screen.getByRole("button", { name: "Remove step 2" })).toBeTruthy();
  });

  it("asks before deleting a prompt that has checks under it", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: twoTurn, onStepsChange });
    await user.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.getByTestId("spine-delete-action")).toBeTruthy();
    expect(onStepsChange).not.toHaveBeenCalled();
  });

  it("deletes without asking when the action stands alone", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({
      steps: [...promptOnly, withClick[1]],
      onStepsChange,
    });
    await user.click(
      screen.getByRole("button", { name: "Options for step 2" }),
    );
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
      screen.queryByRole("button", { name: "Add assertion or action" }),
    ).toBeNull();
  });

  it("offers no tools as an assertion instead of matching settings", async () => {
    const onToolsChoiceChange = vi.fn();
    const user = await openSpine({ steps: golden, onToolsChoiceChange });
    expect(screen.queryByText("Tool matching settings")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Add assertion or action" }),
    );
    await user.click(screen.getByTestId("add-step-item-route:noTools"));
    expect(
      within(screen.getByTestId("spine-after-run-checks")).getByText(
        "No tools should be called",
      ),
    ).toBeVisible();
    expect(onToolsChoiceChange).toHaveBeenCalledWith("noTool");
  });

  it("restores tool checks and their argument settings when no-tools is removed", async () => {
    const tool: TestStep = {
      id: "call-check",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "get_me",
        args: { args: { id: 42 }, argumentMatching: "exact" },
        minCount: 2,
      },
    };
    const original = [promptOnly[0]!, golden[1]!, tool, ...withClick.slice(1)];
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: original, onStepsChange });
    await user.click(
      screen.getByRole("button", {
        name: "Add assertion or action",
        exact: true,
      }),
    );
    await user.click(screen.getByTestId("add-step-item-route:noTools"));
    expect(onStepsChange).toHaveBeenLastCalledWith(
      original.filter((step) => step.id !== tool.id),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Options for No tools should be called",
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove", exact: true }),
    );
    expect(onStepsChange).toHaveBeenLastCalledWith(original);
    expect(screen.queryByTestId("route-check-noTools")).toBeNull();
  });

  it("opens a saved no-tools assertion without marking the case dirty", async () => {
    const onStepsChange = vi.fn();
    const onToolsChoiceChange = vi.fn();
    await openSpine({
      isNegativeTest: true,
      onStepsChange,
      onToolsChoiceChange,
    });
    expect(screen.getByTestId("route-check-noTools")).toBeVisible();
    expect(onStepsChange).not.toHaveBeenCalled();
    expect(onToolsChoiceChange).not.toHaveBeenCalled();
  });

  it("creates an editable expected tool when adding exact order to a blank case", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ onStepsChange });
    await user.click(
      screen.getByRole("button", {
        name: "Add assertion or action",
        exact: true,
      }),
    );
    await user.click(screen.getByTestId("add-step-item-route:exactOrder"));
    const field = screen.getByLabelText("Expected tool 1");
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.type(field, "get_me");
    const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(written[1]).toMatchObject({
      kind: "assert",
      assertion: { type: "toolCalledWith", toolName: "get_me" },
    });
    expect(screen.getByLabelText("Expected tool 1")).toHaveValue("get_me");
  });

  it("locks the route on a model-free case but keeps the call editable", async () => {
    await openSpine({ steps: pinnedFirst });
    expect(screen.getByTestId("simple-case-route-locked")).toBeTruthy();
    expect(screen.getByLabelText("Edit step 1")).toBeTruthy();
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

it("allows typing an allow-list tool without a connected tool catalog", async () => {
  const user = userEvent.setup();
  const onStepsChange = vi.fn();
  render(
    <StatefulSpine
      steps={[
        ...promptOnly,
        {
          id: "only",
          kind: "assert",
          assertion: { type: "onlyToolsCalled", toolNames: [] },
        },
      ]}
      availableTools={[]}
      onStepsChange={onStepsChange}
    />,
  );
  const row = screen.getByTestId("case-scorecard-row");
  await userEvent
    .setup()
    .click(within(row).getByRole("button", { name: /^Edit / }));
  await user.click(screen.getByRole("button", { name: "Add a tool" }));
  const input = screen.getByLabelText("Find or enter a tool");
  await userEvent.setup().type(input, "search");
  await userEvent
    .setup()
    .click(screen.getAllByRole("button", { name: "Add a tool" }).at(-1)!);
  expect(onStepsChange.mock.lastCall?.[0][1].assertion.toolNames).toEqual([
    "search",
  ]);
});

describe("historical case layout", () => {
  it("retains prompt and outcome fields, preserves action order, and removes mutation controls", () => {
    render(
      <StatefulSpine
        steps={twoTurn}
        expectedOutput="Captured outcome"
        readOnly
      />,
    );
    expect(screen.getAllByText("User prompt").length).toBeGreaterThan(0);
    expect(screen.getByText("Expected outcome")).toBeInTheDocument();
    expect(screen.getByLabelText("What does the user ask?")).toHaveAttribute(
      "readonly",
    );
    expect(screen.getByDisplayValue("Captured outcome")).toHaveAttribute(
      "readonly",
    );
    expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add assertion or action" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });
  it("does not fabricate a prompt for an empty historical snapshot", () => {
    render(<StatefulSpine steps={[]} readOnly />);
    expect(screen.queryByLabelText("What does the user ask?")).toBeNull();
  });
  it("shows unmeasured evidence for checks without recorded results", () => {
    render(
      <StatefulSpine
        steps={golden}
        readOnly
        trialIteration={
          {
            _id: "run",
            status: "completed",
            result: "passed",
            metadata: {},
          } as any
        }
      />,
    );
    expect(screen.getAllByLabelText("Not measured").length).toBeGreaterThan(0);
    expect(screen.queryByText("Passed")).toBeNull();
  });
});

it.each(["click", "type", "key", "scroll", "wait"] as const)(
  "adds and opens the %s action without changing existing steps",
  async (actionKind) => {
    const onStepsChange = vi.fn();
    const user = userEvent.setup();
    render(<StatefulSpine steps={golden} onStepsChange={onStepsChange} />);
    await user.click(
      screen.getByRole("button", { name: "Add assertion or action" }),
    );
    await user.click(screen.getByTestId("add-step-item-interact"));
    await user.click(screen.getByText("Detailed settings"));
    await user.click(
      screen.getByRole("combobox", { name: "Interaction type" }),
    );
    await user.click(
      screen.getByRole("option", { name: actionKind, exact: true }),
    );
    const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(written.filter((step) => step.kind !== "interact")).toEqual(golden);
    expect(written.find((step) => step.kind === "interact")).toMatchObject({
      kind: "interact",
      action: { kind: actionKind },
    });
    expect(screen.getByLabelText("View tool for step 2")).toBeVisible();
    expect(screen.getByLabelText("Edit step 2")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  },
);

it("edits the view tool and text for a newly added typing action", async () => {
  const onStepsChange = vi.fn();
  const user = userEvent.setup();
  render(<StatefulSpine availableTools={[]} onStepsChange={onStepsChange} />);
  await user.click(
    screen.getByRole("button", { name: "Add assertion or action" }),
  );
  await user.click(screen.getByTestId("add-step-item-interact"));
  await user.click(screen.getByText("Detailed settings"));
  await user.click(screen.getByRole("combobox", { name: "Interaction type" }));
  await user.click(screen.getByRole("option", { name: "type", exact: true }));
  await user.type(screen.getByLabelText("View tool for step 2"), "cart_view");
  await user.type(screen.getByPlaceholderText("text to type…"), "hello");
  const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
  expect(written[1]).toMatchObject({
    kind: "interact",
    toolName: "cart_view",
    action: { kind: "type", text: "hello" },
  });
});

it("adds an action from Add after the selected prompt", async () => {
  const onStepsChange = vi.fn();
  const user = userEvent.setup();
  render(<StatefulSpine steps={[]} onStepsChange={onStepsChange} />);
  await user.click(
    screen.getByRole("button", { name: "Add assertion or action" }),
  );
  expect(screen.getByText("Actions")).toBeVisible();
  expect(screen.getByText("Assertions · Selection")).toBeVisible();
  const choice = screen.getByTestId("add-step-item-toolCall");
  expect(choice.querySelector("svg")).not.toBeNull();
  await user.click(choice);
  const written = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
  expect(written.map((step) => step.kind)).toEqual(["prompt", "toolCall"]);
});

it("encloses route configuration and keeps one Add entry point per action", async () => {
  await openSpine({
    steps: [
      { id: "prompt", kind: "prompt", prompt: "Get issue" },
      {
        id: "check",
        kind: "assert",
        assertion: { type: "toolCalledWith", toolName: "get_issue", args: {} },
      },
    ],
  });
  const route = screen.getByTestId("case-route-row");
  expect(route.closest(".rounded-xl.border")).not.toBeNull();
  expect(screen.queryByText("Tool matching settings")).toBeNull();
  expect(screen.queryByText("Matching options")).toBeNull();
  expect(within(route).getByTestId("simple-case-tool-row")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Add step", exact: true }),
  ).toBeNull();
  expect(
    screen.getAllByRole("button", {
      name: "Add assertion or action",
      exact: true,
    }),
  ).toHaveLength(1);
});

it("routes a whole-run limit to case policy and preserves existing inline steps", async () => {
  const onPredicatesChange = vi.fn();
  const onStepsChange = vi.fn();
  const user = userEvent.setup();
  render(
    <StatefulSpine
      onPredicatesChange={onPredicatesChange}
      onStepsChange={onStepsChange}
      predicates={{ mode: "replace", list: [] }}
    />,
  );
  await user.click(
    screen.getByRole("button", {
      name: "Add assertion or action",
      exact: true,
    }),
  );
  await user.click(screen.getByTestId("add-step-item-check:tokenBudgetUnder"));
  expect(onPredicatesChange).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "replace",
      list: [expect.objectContaining({ type: "tokenBudgetUnder" })],
    }),
  );
  expect(onStepsChange).not.toHaveBeenCalled();
});
it("opens the existing expected outcome from the drawer", async () => {
  const user = userEvent.setup();
  render(<StatefulSpine />);
  await user.click(
    screen.getByRole("button", {
      name: "Add assertion or action",
      exact: true,
    }),
  );
  await user.click(screen.getByTestId("add-step-item-outcome"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByLabelText("Expected outcome")).toHaveFocus();
});

describe("a multi-prompt case", () => {
  const expectTool = (id: string, toolName: string): TestStep => ({
    id,
    kind: "assert",
    assertion: { type: "toolCalledWith", toolName, args: { args: {} } },
  });
  const threeTurns: TestStep[] = [
    { id: "p1", kind: "prompt", prompt: "Diagnose my server" },
    expectTool("t1", "diagnose"),
    { id: "p2", kind: "prompt", prompt: "Generate cases" },
    expectTool("t2", "generate"),
    { id: "p3", kind: "prompt", prompt: "Run the eval" },
    expectTool("t3", "run"),
  ];
  const tools = [{ name: "diagnose" }, { name: "generate" }, { name: "run" }];
  const toolNamesIn = (row: HTMLElement) =>
    within(row)
      .queryAllByTestId("simple-case-tool-row")
      .map((el) => el.textContent ?? "");

  it("shows each prompt's expected tools under that prompt", async () => {
    await openSpine({ steps: threeTurns, availableTools: tools });
    const [first, second, third] = screen.getAllByTestId("spine-action-row");
    expect(toolNamesIn(first!).join()).toMatch(/diagnose/);
    expect(toolNamesIn(first!).join()).not.toMatch(/generate|run/);
    expect(toolNamesIn(second!).join()).toMatch(/generate/);
    expect(toolNamesIn(third!).join()).toMatch(/run/);
  });

  it("keeps old matching controls out of every prompt", async () => {
    await openSpine({ steps: threeTurns, availableTools: tools });
    expect(screen.queryByText("Tool matching settings")).toBeNull();
    expect(screen.queryByText("Matching options")).toBeNull();
    expect(screen.queryByText("No tool should be called")).toBeNull();
  });

  it("removes a later prompt's tool from that prompt's steps", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({
      steps: threeTurns,
      availableTools: tools,
      onStepsChange,
    });
    const second = screen.getAllByTestId("spine-action-row")[1]!;
    await user.click(
      within(second).getByRole("button", { name: "Options for generate" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove generate" }));
    const next = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(next.map((step) => step.id)).toEqual(["p1", "t1", "p2", "p3", "t3"]);
  });

  it("keeps later prompts' tools when the first prompt's are edited", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({
      steps: threeTurns,
      availableTools: tools,
      onStepsChange,
    });
    const first = screen.getAllByTestId("spine-action-row")[0]!;
    await user.click(
      within(first).getByRole("button", { name: "Options for diagnose" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove diagnose" }));
    const next = onStepsChange.mock.calls.at(-1)![0] as TestStep[];
    expect(next.map((step) => step.id)).toEqual(["p1", "p2", "t2", "p3", "t3"]);
  });
});

describe("the suite's evaluators on the spine", () => {
  it("fold into one line that opens to the rows", async () => {
    const user = await openSpine({
      steps: golden,
      suiteDefaultPredicates: [
        { type: "tokenBudgetUnder", tokens: 4000 },
        { type: "turnCountUnder", turns: 5, role: "advisory" },
      ] as never,
    });
    const fold = screen.getByTestId("suite-rows-disclosure");
    const toggle = within(fold).getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(
      "2 suite evaluators · 1 required · 1 advisory",
    );
    expect(within(fold).queryAllByTestId("case-scorecard-row")).toHaveLength(0);
    await user.click(toggle);
    expect(within(fold).getAllByTestId("case-scorecard-row")).toHaveLength(2);
  });
});

describe("the Expected outcome box", () => {
  it("carries no example taken from another case", async () => {
    await openSpine({ steps: golden });
    const outcome = screen.getByLabelText("Expected outcome");
    expect(outcome.getAttribute("placeholder")).toBe(
      "One sentence the judge scores against",
    );
  });
});

describe("six-dot drag handles", () => {
  beforeEach(() => {
    // jsdom has no layout: give each sortable row a distinct vertical position.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        const handles = screen.queryAllByRole("button", { name: /^Drag / });
        const handle = this.matches("[aria-label^='Drag ']")
          ? this
          : this.querySelector("[aria-label^='Drag ']");
        const index = handles.indexOf(handle as HTMLElement);
        return new DOMRect(10, 100 + Math.max(0, index) * 150, 400, 100);
      },
    );
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId = 1;
        isPrimary = true;
        pointerType = "mouse";
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adds the exact-order assertion, reorders real calls, and rejects extras", async () => {
    const a: TestStep = {
      id: "a",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "a",
        args: { args: { id: 1 } },
      },
    };
    const b: TestStep = {
      id: "b",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "b",
        args: { args: { id: 2 } },
      },
    };
    const onStepsChange = vi.fn();
    const onMatchOptionsChange = vi.fn();
    const user = await openSpine({
      steps: [...promptOnly, a, b],
      onStepsChange,
      onMatchOptionsChange,
    });
    await user.click(
      screen.getByRole("button", {
        name: "Add assertion or action",
        exact: true,
      }),
    );
    await user.click(screen.getByTestId("add-step-item-route:exactOrder"));
    const row = screen.getByTestId("route-check-exactOrder");
    expect(screen.getByTestId("spine-after-run-checks")).toContainElement(row);
    expect(
      within(row).getByText("Tools must be called in this exact order"),
    ).toBeVisible();
    expect(screen.queryByText("Tool matching settings")).toBeNull();
    const options = onMatchOptionsChange.mock.calls.at(-1)![0];
    expect(options).toMatchObject({
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
    });
    await user.click(
      within(row).getByRole("button", { name: "Drag expected tool 2" }),
    );
    await user.keyboard("[Space][ArrowUp][Space]");
    await waitFor(() =>
      expect(onStepsChange).toHaveBeenLastCalledWith([...promptOnly, b, a]),
    );
    expect(within(row).getByLabelText("Expected tool 1")).toHaveValue("b");
    const calls = [
      { toolName: "b", arguments: { id: 2 } },
      { toolName: "a", arguments: { id: 1 } },
    ];
    expect(evaluateToolCalls(calls, calls, options).passed).toBe(true);
    expect(evaluateToolCalls(calls, [...calls].reverse(), options).passed).toBe(
      false,
    );
    expect(
      evaluateToolCalls(calls, [...calls, calls[0]!], options).passed,
    ).toBe(false);
    await user.click(
      within(row).getByRole("button", {
        name: "Options for Tools must be called in this exact order",
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove", exact: true }),
    );
    expect(screen.queryByTestId("route-check-exactOrder")).toBeNull();
    expect(onMatchOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolCallOrder: "ignore",
        maxExtraToolCalls: null,
      }),
    );
    expect(
      screen.getAllByRole("button", { name: "Drag Tool was called with…" }),
    ).toHaveLength(2);
  });

  it("reorders checks using the focused handle and keyboard", async () => {
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps: golden, onStepsChange });
    const handle = screen.getByRole("button", { name: "Drag No tool errors" });
    await user.click(handle);
    await user.keyboard("[Space]");
    await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
    await user.keyboard("[ArrowDown]");
    await user.keyboard("[Space]");
    await waitFor(() =>
      expect(onStepsChange).toHaveBeenLastCalledWith([
        golden[0],
        golden[2],
        golden[1],
      ]),
    );
  });

  it("reorders checks by pulling their handle with the pointer", async () => {
    const onStepsChange = vi.fn();
    await openSpine({ steps: golden, onStepsChange });
    const handle = screen.getByRole("button", { name: "Drag No tool errors" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 15, clientY: 115 });
    fireEvent.pointerMove(document, { clientX: 15, clientY: 125 });
    await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
    fireEvent.pointerMove(document, { clientX: 15, clientY: 265 });
    fireEvent.pointerUp(document, { clientX: 15, clientY: 265 });
    await waitFor(() =>
      expect(onStepsChange).toHaveBeenLastCalledWith([
        golden[0],
        golden[2],
        golden[1],
      ]),
    );
  });

  it("moves tool-and-arguments checks among other checks in their displayed order", async () => {
    const toolCheck: TestStep = {
      id: "with-args",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "get_me",
        args: { args: { id: 42 } },
      },
    };
    const steps = [golden[0]!, golden[1]!, toolCheck];
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps, onStepsChange });
    expect(
      screen
        .getAllByRole("button", { name: /^Drag / })
        .map((handle) => handle.getAttribute("aria-label")),
    ).toEqual(["Drag No tool errors", "Drag Tool was called with…"]);
    await user.click(
      screen.getByRole("button", { name: "Drag Tool was called with…" }),
    );
    await user.keyboard("[Space][ArrowUp][Space]");
    await waitFor(() =>
      expect(onStepsChange).toHaveBeenLastCalledWith([
        steps[0],
        steps[2],
        steps[1],
      ]),
    );
    expect(
      screen
        .getAllByRole("button", { name: /^Drag / })
        .map((handle) => handle.getAttribute("aria-label")),
    ).toEqual(["Drag Tool was called with…", "Drag No tool errors"]);
  });

  it("moves an action with its checks using the handle", async () => {
    const action: TestStep = {
      id: "call",
      kind: "toolCall",
      serverName: "srv",
      toolName: "get_me",
      arguments: { id: 42 },
    };
    const steps = [...withClick, action, golden[1]!];
    const onStepsChange = vi.fn();
    const user = await openSpine({ steps, onStepsChange });
    await user.click(screen.getByRole("button", { name: "Drag Interact" }));
    await user.keyboard("[Space][ArrowDown][Space]");
    await waitFor(() =>
      expect(onStepsChange).toHaveBeenLastCalledWith([
        steps[0],
        steps[3],
        steps[4],
        steps[1],
        steps[2],
      ]),
    );
  });

  it("reorders after-run checks without changing their settings or moving inline checks", async () => {
    const onPredicatesChange = vi.fn();
    const onStepsChange = vi.fn();
    const list = [
      { type: "turnCountUnder" as const, turns: 4 },
      {
        type: "tokenBudgetUnder" as const,
        tokens: 500,
        role: "advisory" as const,
      },
    ];
    const user = await openSpine({
      steps: golden,
      predicates: { mode: "replace", list },
      onPredicatesChange,
      onStepsChange,
    });
    const inlineHandle = screen.getByRole("button", {
      name: "Drag Tool was called at least once",
    });
    await user.click(inlineHandle);
    await user.keyboard("[Space][ArrowDown][Space]");
    expect(onStepsChange).not.toHaveBeenCalled();
    expect(onPredicatesChange).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Drag Fewer than N user turns" }),
    );
    await user.keyboard("[Space][ArrowDown][Space]");
    await waitFor(() =>
      expect(onPredicatesChange).toHaveBeenLastCalledWith({
        mode: "replace",
        list: [list[1], list[0]],
      }),
    );
    expect(onStepsChange).not.toHaveBeenCalled();
  });

  it("hides handles in read-only cases and inherited suite checks", async () => {
    const { unmount } = render(<StatefulSpine steps={golden} readOnly />);
    expect(screen.queryAllByRole("button", { name: /^Drag / })).toHaveLength(0);
    unmount();
    const user = await openSpine({
      suiteDefaultPredicates: [{ type: "noToolErrors" }],
    });
    const fold = screen.getByTestId("suite-rows-disclosure");
    await user.click(within(fold).getByRole("button"));
    expect(screen.queryAllByRole("button", { name: /^Drag / })).toHaveLength(0);
  });
});
