import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import {
  OutputFormatControl,
  type JudgeOutput,
} from "../output-format-control";
import { ReviewerExampleRow } from "../reviewer-example-row";
import { VariableMappingTable } from "../variable-mapping-table";

const output: JudgeOutput = {
  format: "categories",
  threshold: 0.7,
  categories: [
    { label: "PASS", countsAs: "passed" },
    { label: "FAIL", countsAs: "failed" },
    { label: "NOT_APPLICABLE", countsAs: "not_applicable" },
  ],
  explanationFirst: true,
};

describe("VariableMappingTable", () => {
  it("shows each variable, its source and its preview value", () => {
    renderWithProviders(
      <VariableMappingTable
        previewLabel="Iteration #3"
        paths={["transcript.toolResults", "transcript.finalAssistantMessage"]}
        variables={[
          {
            name: "tool_results",
            path: "transcript.toolResults",
            preview: '[{ "title": "AirPods Pro 2", "in_stock": false }]',
          },
          { name: "final_answer", path: "transcript.finalAssistantMessage" },
        ]}
        onPathChange={() => {}}
      />,
    );
    expect(screen.getByText("Value in Iteration #3")).toBeInTheDocument();
    expect(screen.getByText("{{tool_results}}")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Source for tool_results" }),
    ).toHaveTextContent("transcript.toolResults");
    expect(screen.getByText(/AirPods Pro 2/)).toBeInTheDocument();
    expect(screen.getByText("No preview iteration")).toBeInTheDocument();
  });
});

describe("OutputFormatControl", () => {
  it("maps each category to what it counts as", () => {
    renderWithProviders(
      <OutputFormatControl value={output} onChange={() => {}} />,
    );
    expect(screen.getByText("NOT_APPLICABLE")).toBeInTheDocument();
    expect(screen.getByText("1.0")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(screen.queryByText("Pass at")).not.toBeInTheDocument();
  });

  it("switches format and shows the threshold for scores", () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <OutputFormatControl value={output} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Score 0 to 1" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...output, format: "score" });
    rerender(
      <OutputFormatControl
        value={{ ...output, format: "score" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Pass at")).toBeInTheDocument();
    expect(screen.getByText("0.70")).toBeInTheDocument();
  });

  it("toggles explanation before the answer", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <OutputFormatControl value={output} onChange={onChange} />,
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Explanation before the answer" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...output,
      explanationFirst: false,
    });
  });
});

describe("ReviewerExampleRow", () => {
  it("shows the correction and toggles whether it is used", () => {
    const onIncludedChange = vi.fn();
    renderWithProviders(
      <ReviewerExampleRow
        iterationLabel="Run #3 · Iteration #4"
        judgeSaid="passed"
        reviewerSaid="failed"
        reviewer="Matt"
        note="Recommended Echo Buds, which search returned with in_stock false."
        included
        onIncludedChange={onIncludedChange}
      />,
    );
    expect(screen.getByText("by Matt")).toBeInTheDocument();
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("Fail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    expect(onIncludedChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Use Run #3 · Iteration #4 as an example",
      }),
    );
    expect(onIncludedChange).toHaveBeenLastCalledWith(false);
  });
});
