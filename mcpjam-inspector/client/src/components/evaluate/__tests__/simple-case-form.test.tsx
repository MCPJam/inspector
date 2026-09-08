import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import { SimpleCaseForm } from "../simple-case/simple-case-form";
import {
  matchOptionsForKind,
  UNSET_TOOLS_BLOCK_REASON,
} from "../simple-case/simple-case-model";
import { adoptRouteFromIteration } from "../simple-case/route-rollup";
import type { EvalIteration } from "../../evals/types";

const promptOnly: TestStep[] = [
  { id: "turn-1", kind: "prompt", prompt: "Find the latest incidents" },
];

const withTool: TestStep[] = [
  { id: "turn-1", kind: "prompt", prompt: "Find the latest incidents" },
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "list_incidents",
      args: { args: {} },
    },
  },
];

/** The shape every CLI- and SDK-authored case has: checks stored as steps. */
const goldenSteps: TestStep[] = [
  { id: "s1", kind: "prompt", prompt: "Who am I signed in as?" },
  {
    id: "a1",
    kind: "assert",
    assertion: { type: "firstToolWas", toolName: "get_me" },
  },
  {
    id: "a2",
    kind: "assert",
    assertion: { type: "responseContains", needle: "marcelo@mcpjam.com" },
  },
  { id: "a3", kind: "assert", assertion: { type: "noToolErrors" } },
];

const twoTurn: TestStep[] = [
  { id: "s1", kind: "prompt", prompt: "List the incidents" },
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "list_incidents",
      args: { args: {} },
    },
  },
  { id: "s2", kind: "prompt", prompt: "And the second one?" },
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

function StatefulForm(
  props: Partial<ComponentProps<typeof SimpleCaseForm>> = {},
) {
  const [steps, setSteps] = useState(props.steps ?? promptOnly);
  const [matchOptions, setMatchOptions] = useState(props.matchOptions);
  const [expectedOutput, setExpectedOutput] = useState(
    props.expectedOutput ?? "",
  );
  const [predicates, setPredicates] = useState(props.predicates);
  return (
    <SimpleCaseForm
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
      suiteDefaultPredicates={props.suiteDefaultPredicates}
      onOpenDeepEditor={props.onOpenDeepEditor ?? vi.fn()}
      toolsChoice={props.toolsChoice}
      onToolsChoiceChange={props.onToolsChoiceChange}
      stashedTools={props.stashedTools}
      availableTools={["list_incidents", "get_incident"]}
      isNegativeTest={props.isNegativeTest}
      validationAttempted={props.validationAttempted}
      onStartRecording={props.onStartRecording}
    />
  );
}

function renderForm(
  overrides: Partial<ComponentProps<typeof SimpleCaseForm>> = {},
) {
  const onStepsChange = vi.fn();
  const onMatchOptionsChange = vi.fn();
  const onExpectedOutputChange = vi.fn();
  const onPredicatesChange = vi.fn();
  const onOpenDeepEditor = vi.fn();
  const onToolsChoiceChange = vi.fn();
  render(
    <StatefulForm
      {...overrides}
      onStepsChange={overrides.onStepsChange ?? onStepsChange}
      onMatchOptionsChange={onMatchOptionsChange}
      onExpectedOutputChange={onExpectedOutputChange}
      onPredicatesChange={overrides.onPredicatesChange ?? onPredicatesChange}
      onOpenDeepEditor={overrides.onOpenDeepEditor ?? onOpenDeepEditor}
      onToolsChoiceChange={overrides.onToolsChoiceChange ?? onToolsChoiceChange}
    />,
  );
  return {
    onStepsChange,
    onMatchOptionsChange,
    onExpectedOutputChange,
    onPredicatesChange,
    onOpenDeepEditor,
    onToolsChoiceChange,
  };
}

describe("SimpleCaseForm", () => {
  it("writes the capability and regression matchOptions trios", async () => {
    const user = userEvent.setup();
    const { onMatchOptionsChange } = renderForm({
      steps: withTool,
      isNegativeTest: false,
    });

    // The mode is the ROUTE's strictness, not a page-wide setting, so it lives
    // on the route row. Same two writes, same wire values.
    await user.click(screen.getByRole("radio", { name: "Exact route" }));
    expect(onMatchOptionsChange).toHaveBeenCalledWith(
      matchOptionsForKind("regression"),
    );

    await user.click(screen.getByRole("radio", { name: "Reach the tool" }));
    expect(onMatchOptionsChange).toHaveBeenCalledWith(MATCH_OPTIONS_DEFAULTS);
  });

  it("drops toolCalledWith asserts when no tool is chosen", async () => {
    const user = userEvent.setup();
    const { onStepsChange } = renderForm({
      steps: withTool,
      isNegativeTest: false,
    });

    await user.click(
      screen.getByRole("button", { name: "No tool should be called" }),
    );
    const next = onStepsChange.mock.calls.at(-1)?.[0] as TestStep[];
    expect(next).toEqual([
      { id: "turn-1", kind: "prompt", prompt: "Find the latest incidents" },
    ]);
  });

  it("leaves a prompt-only draft unset without painting the error", async () => {
    renderForm({ isNegativeTest: false });
    // Nothing is asserted yet, so the tool question stays unanswered — but the
    // error only appears once the user actually tries to save or run.
    expect(
      screen.queryByTestId("simple-case-tools-checks-hint"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("simple-case-tools-unset"),
    ).not.toBeInTheDocument();
  });

  it("reports the chosen answer to the tool question", async () => {
    const user = userEvent.setup();
    const { onToolsChoiceChange } = renderForm({ isNegativeTest: false });
    await user.click(
      screen.getByRole("button", { name: "No tool should be called" }),
    );
    expect(onToolsChoiceChange).toHaveBeenCalledWith("noTool");
  });

  it("shows the unset-tools error only after a Save or Run attempt", () => {
    renderForm({ isNegativeTest: false, validationAttempted: true });
    expect(screen.getByTestId("simple-case-tools-unset")).toHaveTextContent(
      UNSET_TOOLS_BLOCK_REASON,
    );
  });

  it("disables Start recording until the prompt is non-empty", async () => {
    const user = userEvent.setup();
    const onStartRecording = vi.fn();
    renderForm({
      steps: [{ id: "turn-1", kind: "prompt", prompt: "" }],
      isNegativeTest: false,
      onStartRecording,
    });
    const start = screen.getByTestId("simple-case-start-recording");
    expect(start).toBeDisabled();
    await user.type(
      screen.getByLabelText("What does the user ask?"),
      "Open the canvas",
    );
    expect(screen.getByTestId("simple-case-start-recording")).toBeEnabled();
    await user.click(screen.getByTestId("simple-case-start-recording"));
    expect(onStartRecording).toHaveBeenCalled();
  });

  it("renders an in-app row and deletes exactly that step", async () => {
    const user = userEvent.setup();
    const interact: TestStep = {
      id: "i1",
      kind: "interact",
      toolName: "create_view",
      action: { kind: "click", target: { testId: "canvas" } },
    };
    const { onStepsChange } = renderForm({
      steps: [
        { id: "turn-1", kind: "prompt", prompt: "Draw" },
        interact,
        {
          id: "a1",
          kind: "assert",
          assertion: {
            type: "toolCalledWith",
            toolName: "create_view",
            args: { args: {} },
          },
        },
      ],
      isNegativeTest: false,
    });
    expect(screen.getByTestId("simple-case-in-app-row")).toHaveTextContent(
      "Click canvas",
    );
    await user.click(
      screen.getByRole("button", { name: "Remove Click canvas" }),
    );
    const next = onStepsChange.mock.calls.at(-1)?.[0] as TestStep[];
    expect(next.map((step) => step.id)).toEqual(["turn-1", "a1"]);
  });

  it("round-trips the rubric", async () => {
    const user = userEvent.setup();
    const { onExpectedOutputChange } = renderForm({
      steps: withTool,
      isNegativeTest: false,
      expectedOutput: "",
    });
    await user.type(
      screen.getByLabelText("What does a good answer accomplish?"),
      "Names the latest incident",
    );
    expect(onExpectedOutputChange).toHaveBeenCalled();
    expect(onExpectedOutputChange.mock.calls.at(-1)?.[0]).toBe(
      "Names the latest incident",
    );
  });

  it("opens the deep editor from the Steps link", async () => {
    const user = userEvent.setup();
    const { onOpenDeepEditor } = renderForm({
      steps: withTool,
      isNegativeTest: false,
    });
    await user.click(screen.getByRole("button", { name: "Steps" }));
    expect(onOpenDeepEditor).toHaveBeenCalled();
  });

  it("adopts a capability route as deduped names without arguments", () => {
    const adopted = adoptRouteFromIteration(
      promptOnly,
      {
        actualToolCalls: [
          { toolName: "search", arguments: { q: "incidents" } },
          { toolName: "search", arguments: { q: "again" } },
          { toolName: "get", arguments: { id: "1" } },
        ],
      } as EvalIteration,
      "capability",
    );
    expect(
      adopted.flatMap((step) => {
        if (
          step.kind !== "assert" ||
          step.assertion.type !== "toolCalledWith"
        ) {
          return [];
        }
        return [
          {
            toolName: step.assertion.toolName,
            arguments: step.assertion.args.args,
          },
        ];
      }),
    ).toEqual([
      { toolName: "search", arguments: {} },
      { toolName: "get", arguments: {} },
    ]);
  });

  it("adopts a regression route with arguments and clears the unset gate", async () => {
    const user = userEvent.setup();
    render(
      <AdoptHarness
        kind="regression"
        iteration={{
          actualToolCalls: [
            { toolName: "search", arguments: { q: "incidents" } },
            { toolName: "get", arguments: { id: "42" } },
          ],
        }}
      />,
    );
    expect(
      screen.queryByTestId("simple-case-tools-unset"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Adopt route" }));
    expect(
      screen.queryByTestId("simple-case-tools-unset"),
    ).not.toBeInTheDocument();
    const rows = screen.getAllByTestId("simple-case-tool-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("search");
    expect(rows[1]).toHaveTextContent("get");
  });
});

describe("SimpleCaseForm step-authored checks", () => {
  it("shows CLI-authored assert steps as check rows, labelled by where they run", () => {
    renderForm({ steps: goldenSteps, isNegativeTest: false });

    const rows = screen
      .getAllByTestId("case-scorecard-row")
      .filter((row) => row.getAttribute("data-provenance") === "step");
    expect(rows).toHaveLength(3);
    // "so far": a step assert reads the transcript AT THAT POINT, unlike the
    // whole-run case predicate of the same kind.
    expect(screen.getByText("No tool errors so far")).toBeInTheDocument();
    expect(screen.getByText("First tool called was… get_me")).toBeInTheDocument();
    expect(
      screen.getByText('Response contains "marcelo@mcpjam.com"'),
    ).toBeInTheDocument();
    // Each row says who wrote it, and carries its own step number — the same
    // number the Steps pane shows for that step.
    expect(rows.every((row) => row.textContent?.includes("Step"))).toBe(true);
    expect(
      rows.map((row) =>
        row
          .querySelector("[data-step-number]")
          ?.getAttribute("data-step-number"),
      ),
    ).toEqual(["2", "3", "4"]);
  });

  it("treats a case graded only by its checks as positive, not unset", () => {
    renderForm({
      steps: goldenSteps,
      isNegativeTest: false,
      validationAttempted: true,
    });
    expect(screen.getByTestId("case-route-row")).toHaveAttribute(
      "data-route",
      "checks",
    );
    expect(
      screen.queryByTestId("simple-case-tools-unset"),
    ).not.toBeInTheDocument();
  });

  it("edits a step check in place instead of writing a predicate", async () => {
    const user = userEvent.setup();
    const { onStepsChange, onPredicatesChange } = renderForm({
      steps: goldenSteps,
      isNegativeTest: false,
    });

    // A row is one line; its fields open on demand.
    await user.click(
      screen.getByRole("button", {
        name: 'Edit Response contains "marcelo@mcpjam.com"',
      }),
    );
    await user.type(screen.getByLabelText("Needle"), "!");

    const next = onStepsChange.mock.calls.at(-1)?.[0] as TestStep[];
    expect(next.map((step) => step.id)).toEqual(["s1", "a1", "a2", "a3"]);
    const edited = next[2] as Extract<TestStep, { kind: "assert" }>;
    expect(edited.assertion).toMatchObject({
      type: "responseContains",
      needle: "marcelo@mcpjam.com!",
    });
    expect(onPredicatesChange).not.toHaveBeenCalled();
  });

  it("removes only the step behind the row it was clicked on", async () => {
    const user = userEvent.setup();
    const { onStepsChange } = renderForm({
      steps: goldenSteps,
      isNegativeTest: false,
    });

    const row = screen
      .getAllByTestId("case-scorecard-row")
      .find((node) => node.getAttribute("data-step-id") === "a3")!;
    await user.click(
      within(row).getByRole("button", { name: "Remove No tool errors so far" }),
    );

    const next = onStepsChange.mock.calls.at(-1)?.[0] as TestStep[];
    expect(next.map((step) => step.id)).toEqual(["s1", "a1", "a2"]);
  });

  it("warns instead of deleting when no-tool contradicts a tool check", async () => {
    const user = userEvent.setup();
    const { onStepsChange } = renderForm({
      steps: goldenSteps,
      isNegativeTest: false,
    });

    await user.click(
      screen.getByRole("button", { name: "No tool should be called" }),
    );

    expect(
      screen.getByTestId("simple-case-negative-contradiction"),
    ).toBeInTheDocument();
    const next = onStepsChange.mock.calls.at(-1)?.[0] as TestStep[];
    expect(next.map((step) => step.id)).toEqual(["s1", "a1", "a2", "a3"]);
  });
});

describe("SimpleCaseForm leftover steps", () => {
  it("lists a second prompt instead of hiding it", async () => {
    const user = userEvent.setup();
    const { onOpenDeepEditor } = renderForm({
      steps: twoTurn,
      isNegativeTest: false,
    });

    const rows = screen.getAllByTestId("simple-case-leftover-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Prompt: "And the second one?"');
    expect(rows[0]).toHaveTextContent("turn 2");

    await user.click(screen.getByRole("button", { name: "Edit in Steps" }));
    expect(onOpenDeepEditor).toHaveBeenCalled();
  });

  it("locks the prompt box and the route on a pinned-first case", () => {
    renderForm({ steps: pinnedFirst, isNegativeTest: false });

    expect(screen.getByTestId("simple-case-prompt-locked")).toBeInTheDocument();
    expect(screen.getByLabelText("What does the user ask?")).toHaveAttribute(
      "readonly",
    );
    // No model turn means no route to claim. Every control that would rewrite
    // the head of the list is gone: "No tool" used to splice an empty model
    // turn in front of the pinned call, and Add would append a tool assert to
    // a turn where it can never match.
    expect(screen.getByTestId("simple-case-route-locked")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "No tool should be called" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("case-route-row")).toHaveAttribute(
      "data-route",
      "locked",
    );
  });

  it("keeps a pinned-first case's existing tool rows read-only", () => {
    renderForm({
      steps: [
        ...pinnedFirst,
        {
          id: "t1",
          kind: "assert",
          assertion: {
            type: "toolCalledWith",
            toolName: "list_incidents",
            args: { args: {} },
          },
        },
      ],
      isNegativeTest: false,
    });

    expect(screen.getAllByTestId("simple-case-tool-row")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Remove list_incidents" }),
    ).not.toBeInTheDocument();
  });

  it("restores stashed tools handed back by the editor after a remount", async () => {
    const user = userEvent.setup();
    // The Steps pane unmounts the form, so the stash lives in the editor. A
    // form-local stash would leave "Use tools instead" restoring nothing.
    const { onStepsChange } = renderForm({
      steps: promptOnly,
      isNegativeTest: true,
      toolsChoice: "noTool",
      stashedTools: [
        { id: "t-stashed", toolName: "list_incidents", arguments: {} },
      ],
    });

    await user.click(screen.getByRole("button", { name: "Use tools instead" }));

    const next = onStepsChange.mock.calls.at(-1)?.[0] as TestStep[];
    expect(next.map((step) => step.id)).toEqual(["turn-1", "t-stashed"]);
  });
});

function AdoptHarness({
  kind,
  iteration,
}: {
  kind: "capability" | "regression";
  iteration: Pick<EvalIteration, "actualToolCalls">;
}) {
  const [steps, setSteps] = useState(promptOnly);
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          setSteps(
            adoptRouteFromIteration(steps, iteration as EvalIteration, kind),
          )
        }
      >
        Adopt route
      </button>
      <SimpleCaseForm
        steps={steps}
        onStepsChange={setSteps}
        onMatchOptionsChange={vi.fn()}
        onExpectedOutputChange={vi.fn()}
        onPredicatesChange={vi.fn()}
        onOpenDeepEditor={vi.fn()}
        availableTools={["search", "get"]}
        matchOptions={matchOptionsForKind(kind)}
      />
    </div>
  );
}
