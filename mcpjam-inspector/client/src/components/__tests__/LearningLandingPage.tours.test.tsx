import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { LearningLandingPage } from "@/components/LearningLandingPage";

function renderPage(overrides?: {
  isCompleted?: (id: string) => boolean;
  completionCount?: number;
}) {
  const onSelect = vi.fn();
  const onToggleComplete = vi.fn();
  render(
    <LearningLandingPage
      onSelect={onSelect}
      isCompleted={overrides?.isCompleted ?? (() => false)}
      onToggleComplete={onToggleComplete}
      completionCount={overrides?.completionCount ?? 0}
    />,
  );
  return { onSelect, onToggleComplete };
}

/** The guided group is collapsed by default (only the first group auto-opens). */
function expandGuidedTours() {
  fireEvent.click(screen.getByText("Guided tours"));
}

describe("LearningLandingPage — guided tours", () => {
  it("counts guided tours in the header totals", () => {
    renderPage();
    // 4 reading tracks + the guided-tours track = 5; 11 reading modules + 5
    // tours = 16.
    const totals = screen.getByText(/tracks ·/);
    expect(totals.textContent).toContain("5 tracks");
    expect(totals.textContent).toContain("16 lessons");
  });

  it("renders a guided row with a Guided badge, play affordance, and duration", () => {
    renderPage();
    expandGuidedTours();

    const row = screen
      .getByText("Create and run an eval suite")
      .closest("button") as HTMLElement;
    expect(within(row).getByText("Guided")).toBeInTheDocument();
    expect(within(row).getByText(/~5 min/)).toBeInTheDocument();
    // Play icon (lucide) instead of the reading rows' chevron.
    expect(row.querySelector(".lucide-play")).toBeTruthy();
    expect(row.querySelector(".lucide-chevron-right")).toBeNull();
  });

  it("selecting a guided row calls onSelect with the tour id", () => {
    const { onSelect } = renderPage();
    expandGuidedTours();

    fireEvent.click(screen.getByText("Create and run an eval suite"));
    expect(onSelect).toHaveBeenCalledWith("tour-eval-suite");
  });

  it("toggling a guided row's checkbox marks completion without selecting it", () => {
    const { onSelect, onToggleComplete } = renderPage();
    expandGuidedTours();

    const row = screen
      .getByText("Create and run an eval suite")
      .closest("button") as HTMLElement;
    fireEvent.click(within(row).getByRole("checkbox"));

    expect(onToggleComplete).toHaveBeenCalledWith("tour-eval-suite");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not show the Guided badge on a reading module", () => {
    renderPage();
    // "Getting Started" auto-opens at completionCount 0.
    const row = screen.getByText("Why MCP?").closest("button") as HTMLElement;
    expect(within(row).queryByText("Guided")).not.toBeInTheDocument();
  });
});
