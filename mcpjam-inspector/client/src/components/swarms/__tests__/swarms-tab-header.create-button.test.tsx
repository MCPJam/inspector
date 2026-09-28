import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SwarmsTabHeader } from "../swarms-tab-header";

/**
 * REEV-6, from Vig's review: two create buttons on one screen is duplication,
 * so the header drops its own while the empty state is showing.
 *
 * The half worth pinning is the RETURN. Removing the button is easy to get
 * right and easy to over-apply: a member looking at a list of real swarms has
 * no empty state to borrow a button from, so if the header stays bare there is
 * no way to make the next one.
 */
const BASE = {
  projectId: "project-1",
  viewMode: "overview" as const,
  viewOptions: [{ value: "overview" as const, label: "Overview" }],
  onViewModeChange: vi.fn(),
  onNewSwarm: vi.fn(),
};

const createButton = () =>
  screen.queryByRole("button", { name: /create new swarm/i });

describe("SwarmsTabHeader create button", () => {
  it("is shown by default, so no caller loses it by omission", () => {
    render(<SwarmsTabHeader {...BASE} />);
    expect(createButton()).toBeInTheDocument();
  });

  it("is hidden while the list is empty", () => {
    render(<SwarmsTabHeader {...BASE} showCreate={false} />);
    expect(createButton()).not.toBeInTheDocument();
  });

  it("comes back once the list has something in it", () => {
    const { rerender } = render(
      <SwarmsTabHeader {...BASE} showCreate={false} />,
    );
    expect(createButton()).not.toBeInTheDocument();

    rerender(<SwarmsTabHeader {...BASE} showCreate />);
    expect(createButton()).toBeInTheDocument();
  });

  // Hiding it is about duplication, not about permission. A project that has
  // not resolved yet still gets the disabled treatment it always had.
  it("keeps its disabled state when there is no project", () => {
    render(<SwarmsTabHeader {...BASE} projectId={null} showCreate />);
    expect(createButton()).toBeDisabled();
  });

  it("keeps the heading and the view selector either way", () => {
    render(<SwarmsTabHeader {...BASE} showCreate={false} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Swarm" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
  });
});
