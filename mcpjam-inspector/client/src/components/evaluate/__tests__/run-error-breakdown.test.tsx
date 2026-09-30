import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RunErrorBreakdown } from "../run-error-breakdown";
import type { RunErrorBreakdown as RunErrorBreakdownView } from "../run-error-breakdown-model";

const breakdown: RunErrorBreakdownView = {
  errored: 26,
  finished: 26,
  headline: "All 26 results in this run ended in an error.",
  groups: [
    {
      cause: "serverError",
      owner: "yourServer",
      title: "Your MCP server returned an error",
      nextStep: "Open a result to read the error your server sent back.",
      count: 26,
      exampleIterationId: "it_1",
    },
  ],
};

describe("RunErrorBreakdown", () => {
  it("renders nothing without a breakdown", () => {
    const { container } = render(<RunErrorBreakdown breakdown={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says who needs to act and opens an example result", () => {
    const onOpenIteration = vi.fn();
    render(
      <RunErrorBreakdown
        breakdown={breakdown}
        onOpenIteration={onOpenIteration}
      />,
    );
    expect(
      screen.getByText("All 26 results in this run ended in an error."),
    ).toBeInTheDocument();
    expect(screen.getByText("Your server")).toBeInTheDocument();
    expect(screen.getByText("(26 of 26)")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("run-error-group-open"));
    expect(onOpenIteration).toHaveBeenCalledWith("it_1");
  });
});
