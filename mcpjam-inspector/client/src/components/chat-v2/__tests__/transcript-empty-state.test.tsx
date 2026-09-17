import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptEmptyState } from "../transcript-empty-state";
describe("TranscriptEmptyState", () => {
  it.each(["loading", "streaming"] as const)(
    "labels %s accessibly without visible copy",
    (kind) => {
      render(<TranscriptEmptyState kind={kind} />);
      expect(screen.getByRole("status")).toHaveAccessibleName(
        kind === "loading" ? "Loading transcript" : "Waiting for transcript",
      );
      expect(screen.getByRole("status").textContent).toBe("");
    },
  );
  it("does not suggest a known execution never ran", () => {
    const { rerender } = render(
      <TranscriptEmptyState kind="unrecorded" execution="observed" />,
    );
    expect(screen.getByText("No transcript recorded")).toBeInTheDocument();
    expect(screen.queryByText("May not have run.")).not.toBeInTheDocument();
    rerender(<TranscriptEmptyState kind="unrecorded" execution="unknown" />);
    expect(screen.getByText("May not have run.")).toBeInTheDocument();
  });
  it("renders nothing for none", () => {
    const { container } = render(<TranscriptEmptyState kind="none" />);
    expect(container).toBeEmptyDOMElement();
  });
});
