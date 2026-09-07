import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function StatefulForm(
  props: Partial<ComponentProps<typeof SimpleCaseForm>> = {},
) {
  const [steps, setSteps] = useState(props.steps ?? promptOnly);
  const [matchOptions, setMatchOptions] = useState(props.matchOptions);
  const [expectedOutput, setExpectedOutput] = useState(
    props.expectedOutput ?? "",
  );
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
      onPredicatesChange={props.onPredicatesChange ?? vi.fn()}
      onOpenDeepEditor={props.onOpenDeepEditor ?? vi.fn()}
      onToolsChoiceBlockReasonChange={props.onToolsChoiceBlockReasonChange}
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
  const onToolsChoiceBlockReasonChange = vi.fn();
  render(
    <StatefulForm
      {...overrides}
      onStepsChange={overrides.onStepsChange ?? onStepsChange}
      onMatchOptionsChange={onMatchOptionsChange}
      onExpectedOutputChange={onExpectedOutputChange}
      onPredicatesChange={onPredicatesChange}
      onOpenDeepEditor={onOpenDeepEditor}
      onToolsChoiceBlockReasonChange={onToolsChoiceBlockReasonChange}
    />,
  );
  return {
    onStepsChange,
    onMatchOptionsChange,
    onExpectedOutputChange,
    onOpenDeepEditor,
    onToolsChoiceBlockReasonChange,
  };
}

describe("SimpleCaseForm", () => {
  it("writes the capability and regression matchOptions trios", async () => {
    const user = userEvent.setup();
    const { onMatchOptionsChange } = renderForm({
      steps: withTool,
      isNegativeTest: false,
    });

    await user.click(screen.getByRole("radio", { name: "Regression" }));
    expect(onMatchOptionsChange).toHaveBeenCalledWith(
      matchOptionsForKind("regression"),
    );

    await user.click(screen.getByRole("radio", { name: "Capability" }));
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

  it("reports the unset-tools block reason without painting the error", async () => {
    const { onToolsChoiceBlockReasonChange } = renderForm({
      isNegativeTest: false,
    });
    await waitFor(() => {
      expect(onToolsChoiceBlockReasonChange).toHaveBeenCalledWith(
        UNSET_TOOLS_BLOCK_REASON,
      );
    });
    expect(
      screen.queryByTestId("simple-case-tools-unset"),
    ).not.toBeInTheDocument();
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
