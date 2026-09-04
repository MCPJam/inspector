import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScorePreviewCard } from "../ScorePreviewCard";

describe("ScorePreviewCard", () => {
  it("renders the Paper report card", () => {
    render(<ScorePreviewCard />);

    expect(screen.getByText("Overall · run 2026-08-26")).toBeInTheDocument();
    expect(screen.getByText("mcp.monday.com")).toBeInTheDocument();
    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.getByText("Reliability")).toBeInTheDocument();
    expect(screen.getByText("113 checks. 63 passed, 8 failed.")).toBeInTheDocument();
    expect(screen.queryByTestId("score-preview-plane")).not.toBeInTheDocument();
  });

  it("hides the dimension ledger when compact", () => {
    render(<ScorePreviewCard compact />);

    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.queryByText("Reliability")).not.toBeInTheDocument();
  });

  it("parks the send-off plane when mounted in the plane stage", () => {
    render(<ScorePreviewCard stage="plane" />);

    expect(screen.getByTestId("score-preview-plane")).toBeInTheDocument();
    expect(screen.queryByText("84")).not.toBeInTheDocument();
    expect(screen.queryByText("Reliability")).not.toBeInTheDocument();
  });
});
