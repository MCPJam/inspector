import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { CombineFlow } from "../combine-flow";
import { EvaluatorTypePicker } from "../evaluator-type-picker";
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
  it("offers four methods and no server checks", () => {
    renderWithProviders(
      <EvaluatorTypePicker value={null} onChange={() => {}} />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Assertions"),
      expect.stringContaining("Judge prompt"),
      expect.stringContaining("Decision questions"),
      expect.stringContaining("Code"),
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
    fireEvent.click(screen.getByRole("radio", { name: /^code/i }));
    expect(onChange).toHaveBeenLastCalledWith("code");
    fireEvent.keyDown(judge, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("decision");
    fireEvent.keyDown(judge, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("assertions");
  });
});
