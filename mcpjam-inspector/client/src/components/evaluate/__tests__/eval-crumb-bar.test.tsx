import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { EvalCrumbBar, type EvalCrumbBarProps } from "../evals-header";
import type { EvalCrumb } from "../nav/eval-nav-crumbs";

const PROJECT = "proj000000000001";
let location: ReturnType<typeof useLocation> | null = null;
function LocationProbe() {
  location = useLocation();
  return null;
}

function renderBar(props: EvalCrumbBarProps) {
  render(
    <MemoryRouter initialEntries={[`/p/${PROJECT}/evaluate/suite/s/runs/r`]}>
      <EvalCrumbBar {...props} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const iterationCrumbs: EvalCrumb[] = [
  { label: "Evaluate", to: { type: "list" } },
  { label: "Excalidraw", to: { type: "suite-overview", suiteId: "s" } },
  { label: "Run #4", to: { type: "run-detail", suiteId: "s", runId: "r" } },
  {
    label: "Draw a box",
    to: { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
  },
  { label: "Iteration #2" },
];

describe("EvalCrumbBar", () => {
  it("renders crumbs with the last as the current page", () => {
    renderBar({ crumbs: iterationCrumbs });
    for (const label of ["Evaluate", "Excalidraw", "Run #4", "Draw a box"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    const current = screen.getByText("Iteration #2");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.closest("button")).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "breadcrumb" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("pushes a crumb with via crumb and no from", () => {
    renderBar({ crumbs: iterationCrumbs });
    fireEvent.click(screen.getByRole("button", { name: "Excalidraw" }));
    expect(location?.pathname).toBe(`/p/${PROJECT}/evaluate/suite/s`);
    expect(location?.state).toEqual({ evalNav: { via: "crumb" } });
  });

  it("pushes Back's path with via back, and labels it fully and on phones", () => {
    renderBar({
      crumbs: iterationCrumbs.slice(0, 3),
      back: { label: "Back to Suites", path: "/evaluate" },
    });
    const back = screen.getByTitle("Back to Suites");
    expect(back).toHaveTextContent("Back to SuitesBack");
    fireEvent.click(back);
    expect(location?.pathname).toBe(`/p/${PROJECT}/evaluate`);
    expect(location?.state).toEqual({ evalNav: { via: "back" } });
  });

  it("puts actions between the crumbs and Back", () => {
    renderBar({
      crumbs: [
        { label: "Evaluate", to: { type: "list" } },
        { label: "Suite settings" },
      ],
      back: { label: "Back to suite", path: "/evaluate/suite/s" },
      actions: <button type="button">Save settings</button>,
    });
    const strip = screen.getByTestId("evals-header");
    const order = [...strip.children].map((child) => child.textContent);
    expect(order).toEqual([
      "Evaluate/Suite settings",
      "Save settings",
      "Back to suiteBack",
    ]);
  });

  it("marks a pending crumb busy without changing the count", () => {
    renderBar({
      crumbs: [
        { label: "Evaluate", to: { type: "list" } },
        {
          label: "Suite",
          to: { type: "suite-overview", suiteId: "s" },
          pending: true,
        },
        { label: "Run", pending: true },
      ],
    });
    expect(screen.getByRole("button", { name: "Suite" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByText("Run")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("folds the middle crumbs on phones", () => {
    renderBar({ crumbs: iterationCrumbs });
    const item = (label: string) => screen.getByText(label).closest("li");
    expect(item("Excalidraw")).toHaveClass("hidden", "sm:inline-flex");
    expect(item("Evaluate")).not.toHaveClass("hidden");
    expect(item("Run #4")).toHaveClass("hidden", "sm:inline-flex");
    expect(item("Iteration #2")).not.toHaveClass("hidden");
    expect(item("Draw a box")).not.toHaveClass("hidden");
    const ellipsis = screen.getByText("…");
    expect(ellipsis).toHaveAttribute("aria-hidden", "true");
    expect(ellipsis).toHaveClass("sm:hidden");
  });

  it("does not fold three crumbs", () => {
    renderBar({ crumbs: iterationCrumbs.slice(0, 3) });
    expect(screen.queryByText("…")).toBeNull();
  });
});
