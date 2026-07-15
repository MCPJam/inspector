import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EvalIteration } from "../../types";
import { PassDotRow } from "../pass-dot-row";

function makeIter(
  id: string,
  iterationNumber: number,
  result: "passed" | "failed" | "pending" | "cancelled" | "timed_out",
  createdAt = iterationNumber * 1000,
): EvalIteration {
  return {
    _id: id,
    createdBy: "u1",
    createdAt,
    updatedAt: createdAt,
    iterationNumber,
    status:
      result === "pending"
        ? "pending"
        : result === "timed_out"
          ? "timed_out"
          : "completed",
    result,
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 0,
  } as EvalIteration;
}

describe("PassDotRow", () => {
  it("renders one dot per iteration with the role=img summary", () => {
    render(
      <PassDotRow
        iterations={[
          makeIter("i1", 1, "passed"),
          makeIter("i2", 2, "failed"),
          makeIter("i3", 3, "passed"),
        ]}
      />,
    );
    const row = screen.getByRole("img");
    expect(row).toHaveAttribute("aria-label", "2 passed, 1 failed out of 3");
  });

  it("sorts iterations by iterationNumber ascending regardless of input order", () => {
    // Input order is shuffled; rendered order should be by iterationNumber.
    const { container } = render(
      <PassDotRow
        iterations={[
          makeIter("i3", 3, "passed"),
          makeIter("i1", 1, "passed"),
          makeIter("i2", 2, "failed"),
        ]}
      />,
    );
    const dots = container.querySelectorAll("span[aria-hidden]");
    // First three should map to iterationNumber 1, 2, 3 — passed, failed, passed
    expect(dots[0]).toHaveClass("bg-success/50"); // i1 passed
    expect(dots[1]).toHaveClass("bg-destructive/50"); // i2 failed
    expect(dots[2]).toHaveClass("bg-success/50"); // i3 passed
  });

  it("falls back to createdAt when iterationNumber ties", () => {
    const { container } = render(
      <PassDotRow
        iterations={[
          makeIter("i_b", 1, "failed", 2000),
          makeIter("i_a", 1, "passed", 1000),
        ]}
      />,
    );
    const dots = container.querySelectorAll("span[aria-hidden]");
    expect(dots[0]).toHaveClass("bg-success/50"); // i_a first (earlier createdAt)
    expect(dots[1]).toHaveClass("bg-destructive/50"); // i_b second
  });

  it("includes pending/cancelled counts in the aria summary", () => {
    render(
      <PassDotRow
        iterations={[
          makeIter("i1", 1, "passed"),
          makeIter("i2", 2, "pending"),
          makeIter("i3", 3, "cancelled"),
        ]}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "1 passed, 0 failed, 2 pending or cancelled out of 3",
    );
  });

  it("counts timed-out iterations as failed with warning dots", () => {
    const { container } = render(
      <PassDotRow
        iterations={[
          makeIter("i1", 1, "passed"),
          makeIter("i2", 2, "timed_out"),
        ]}
      />,
    );

    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "1 passed, 1 failed out of 2",
    );
    const dots = Array.from(container.querySelectorAll("span[aria-hidden]"));
    const warningDot = dots.find((dot) =>
      dot.classList.contains("bg-warning/50"),
    );
    expect(warningDot).toHaveClass("bg-warning/50");
  });

  it("renders an empty-state aria-label when no iterations", () => {
    render(<PassDotRow iterations={[]} />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "No iterations",
    );
  });

  it("caps visible dots at MAX_DOTS (12) and shows overflow count", () => {
    const many: EvalIteration[] = Array.from({ length: 15 }, (_, i) =>
      makeIter(`i${i}`, i + 1, "passed"),
    );
    const { container } = render(<PassDotRow iterations={many} />);
    const dots = container.querySelectorAll("span[aria-hidden].rounded-full");
    expect(dots).toHaveLength(12);
    // Overflow counter
    expect(container.textContent).toContain("+3");
  });
});
