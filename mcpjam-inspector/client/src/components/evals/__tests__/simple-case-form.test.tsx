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
  const [matchOptions, setMatchOptions] = useState(props.matchOptions);
  const [expectedOutput, setExpectedOutput] = useState(
    props.expectedOutput ?? "",
  );
  return (
    <SimpleCaseForm
      steps={props.steps ?? promptOnly}
      onStepsChange={props.onStepsChange ?? vi.fn()}
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

  it("reports the unset-tools block reason", async () => {
    const { onToolsChoiceBlockReasonChange } = renderForm({
      isNegativeTest: false,
    });
    await waitFor(() => {
      expect(onToolsChoiceBlockReasonChange).toHaveBeenCalledWith(
        UNSET_TOOLS_BLOCK_REASON,
      );
    });
    expect(screen.getByTestId("simple-case-tools-unset")).toHaveTextContent(
      UNSET_TOOLS_BLOCK_REASON,
    );
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
});
