import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScorePreviewCard } from "../ScorePreviewCard";

describe("ScorePreviewCard", () => {
  it("renders the Paper report card", () => {
    render(<ScorePreviewCard />);

    expect(screen.getByText("Overall score")).toBeInTheDocument();
    expect(screen.queryByText(/Scanned /)).not.toBeInTheDocument();
    expect(screen.getByText("mcp.monday.com")).toBeInTheDocument();
    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.getByText("Reliability")).toBeInTheDocument();
    expect(
      screen.getByText("113 checks. 63 passed, 8 failed, 27 not applicable."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("score-preview-plane")).not.toBeInTheDocument();
  });

  it("hides the dimension ledger when compact", () => {
    render(<ScorePreviewCard compact />);

    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.queryByText("Reliability")).not.toBeInTheDocument();
  });

  it("leaves the slot empty when mounted after the send-off", () => {
    render(<ScorePreviewCard stage="gone" />);

    expect(screen.queryByTestId("score-preview-plane")).not.toBeInTheDocument();
    expect(screen.queryByText("84")).not.toBeInTheDocument();
    expect(screen.queryByText("Reliability")).not.toBeInTheDocument();
  });
});
