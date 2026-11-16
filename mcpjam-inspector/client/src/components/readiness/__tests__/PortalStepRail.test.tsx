/**
 * The portal's rule for marking a step, and MCPJam's counts beside it: a
 * step shows what is missing only once the person has left it, opened the
 * review page, or run the checks.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { portalMarks, PortalStepRail, type RailStep } from "../PortalStepRail";

const STEPS: RailStep[] = [
  {
    id: "connection",
    title: "Connection",
    toFix: 0,
    likelyFlags: 0,
    notChecked: 0,
  },
  { id: "listing", title: "Listing", toFix: 2, likelyFlags: 1, notChecked: 3 },
  { id: "company", title: "Company", toFix: 1, likelyFlags: 0, notChecked: 0 },
  {
    id: "review",
    title: "Review and submit",
    toFix: 0,
    likelyFlags: 0,
    notChecked: 0,
  },
];
const LAST = STEPS.length - 1;

function rail(marked: (index: number) => boolean, active = 1) {
  render(
    <PortalStepRail
      label="Claude submission steps"
      steps={STEPS}
      active={active}
      marked={marked}
      onSelect={vi.fn()}
    />,
  );
  return (title: string) =>
    within(screen.getByRole("button", { name: new RegExp(title) }));
}

describe("portalMarks", () => {
  it("marks nothing on a fresh draft", () => {
    const marked = portalMarks(new Set(), 1, LAST, false);
    expect(STEPS.map((_, index) => marked(index))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("marks a step once the person leaves it, not the one they are on", () => {
    const marked = portalMarks(new Set([0]), 1, LAST, false);
    expect(marked(0)).toBe(true);
    expect(marked(1)).toBe(false);
    expect(marked(2)).toBe(false);
  });

  it("marks every step on the review page, after leaving it, and after a run", () => {
    for (const marked of [
      portalMarks(new Set(), LAST, LAST, false),
      portalMarks(new Set([LAST]), 0, LAST, false),
      portalMarks(new Set(), 0, LAST, true),
    ]) {
      expect(STEPS.every((_, index) => marked(index))).toBe(true);
    }
  });
});

describe("PortalStepRail", () => {
  it("shows no count to fix and no tick before a step is marked", () => {
    const step = rail(() => false);
    expect(step("Listing").queryByText("to fix")).toBeNull();
    expect(step("Connection").queryByText(", complete")).toBeNull();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent(
      "Listing",
    );
  });

  it("counts missing answers and blockers on a marked step, and ticks a clean one", () => {
    const step = rail(() => true);
    expect(step("Listing").getByText("to fix").parentElement).toHaveTextContent(
      "2",
    );
    expect(step("Company").getByText("to fix").parentElement).toHaveTextContent(
      "1",
    );
    expect(step("Connection").getByText(", complete")).toBeInTheDocument();
  });

  it("never ticks the review page: MCPJam does not submit", () => {
    const step = rail(() => true);
    expect(step("Review and submit").queryByText(", complete")).toBeNull();
  });

  it("shows MCPJam's likely flags and unchecked counts beside the portal's", () => {
    const step = rail(() => false);
    expect(
      step("Listing").getByText("likely flags").parentElement,
    ).toHaveTextContent("1");
    expect(
      step("Listing").getByText("not checked").parentElement,
    ).toHaveTextContent("3");
  });
});
