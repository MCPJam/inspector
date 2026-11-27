import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, userEvent } from "@/test";
import { CombineFlow } from "../combine-flow";
import {
  EvaluatorTypePicker,
  type EvaluatorTypePickerProps,
} from "../evaluator-type-picker";
import { OutcomeTag } from "../outcome-tag";
import { RUN_WHEN_OPTIONS, RunWhenSelect } from "../run-when-select";

describe("OutcomeTag", () => {
  it.each([
    ["passed", "Pass"],
    ["failed", "Fail"],
    ["not_applicable", "N/A"],
  ] as const)("labels %s with a word, not only a color", (outcome, word) => {
    renderWithProviders(<OutcomeTag outcome={outcome} />);
    expect(screen.getByText(word)).toHaveAttribute("data-outcome", outcome);
  });
});

describe("RunWhenSelect", () => {
  it("shows the chosen gate in the trigger", () => {
    renderWithProviders(
      <RunWhenSelect value="required-fail" onChange={() => {}} />,
    );
    expect(screen.getByRole("combobox", { name: "Runs" })).toHaveTextContent(
      RUN_WHEN_OPTIONS["required-fail"].label,
    );
  });
});

describe("CombineFlow", () => {
  it("shows the pass and fail paths and the explain step", () => {
    renderWithProviders(
      <CombineFlow requiredCount={3} explainStep="Ask why" />,
    );
    expect(
      screen.getByRole("group", { name: "How results combine" }),
    ).toHaveTextContent("3 required checks");
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Ask why")).toBeInTheDocument();
  });

  it("adds the Not applicable path when the evaluator needs a case field", () => {
    renderWithProviders(
      <CombineFlow requiredCount={1} dependency="expectedToolCalls" />,
    );
    expect(screen.getByText("1 required check")).toBeInTheDocument();
    expect(
      screen.getByText("No expected tool calls in the case"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not applicable")).toBeInTheDocument();
  });
});

describe("EvaluatorTypePicker", () => {
  it("offers assertions, judge prompts, and decision questions", () => {
    renderWithProviders(
      <EvaluatorTypePicker value={null} onChange={() => {}} />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Assertions"),
      expect.stringContaining("Judge prompt"),
      expect.stringContaining("Decision questions"),
    ]);
    expect(screen.queryByText(/server/i)).not.toBeInTheDocument();
  });

  it("selects on click and moves with the arrow keys", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <EvaluatorTypePicker value="judge" onChange={onChange} />,
    );
    const judge = screen.getByRole("radio", { name: /judge prompt/i });
    expect(judge).toHaveAttribute("aria-checked", "true");
    expect(judge).toHaveAttribute("tabindex", "0");
    const assertions = screen.getByRole("radio", { name: /^assertions/i });
    fireEvent.click(assertions);
    expect(onChange).toHaveBeenLastCalledWith("assertions");
    fireEvent.keyDown(assertions, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("decision");
    fireEvent.keyDown(judge, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("decision");
    fireEvent.keyDown(judge, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("assertions");
  });

  it("moves focus and selection together, wrapping at the ends", async () => {
    function Harness() {
      const [value, setValue] =
        useState<EvaluatorTypePickerProps["value"]>("assertions");
      return <EvaluatorTypePicker value={value} onChange={setValue} />;
    }
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const expectSelected = (name: RegExp) => {
      const radio = screen.getByRole("radio", { name });
      expect(radio).toHaveFocus();
      expect(radio).toHaveAttribute("aria-checked", "true");
      expect(radio).toHaveAttribute("tabindex", "0");
      for (const other of screen.getAllByRole("radio")) {
        if (other === radio) continue;
        expect(other).toHaveAttribute("aria-checked", "false");
        expect(other).toHaveAttribute("tabindex", "-1");
      }
    };
    await user.tab();
    expect(screen.getByRole("radio", { name: /^assertions/i })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expectSelected(/judge prompt/i);
    await user.keyboard("{ArrowRight}");
    expectSelected(/decision questions/i);
    await user.keyboard("{ArrowRight}");
    expectSelected(/^assertions/i);
    await user.keyboard("{ArrowLeft}");
    expectSelected(/decision questions/i);
  });
});
