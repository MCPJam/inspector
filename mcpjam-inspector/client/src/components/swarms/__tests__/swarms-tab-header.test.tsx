import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwarmsTabHeader, type SwarmViewOption } from "../swarms-tab-header";

const VIEW_OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "journeys", label: "Personas" },
  { value: "sessions", label: "Sessions" },
] as const satisfies readonly SwarmViewOption[];

describe("SwarmsTabHeader", () => {
  it("keeps view tabs on the same row as the title and CTA", () => {
    const onViewModeChange = vi.fn();
    render(
      <SwarmsTabHeader
        projectId="proj-1"
        viewMode="overview"
        viewOptions={VIEW_OPTIONS}
        onViewModeChange={onViewModeChange}
        onNewSwarm={vi.fn()}
      />,
    );

    const title = screen.getByRole("heading", { name: "Swarm" });
    const overview = screen.getByRole("button", { name: "Overview" });
    const create = screen.getByRole("button", { name: /create new swarm/i });
    const row = title.closest("div.flex.items-center.justify-between");

    expect(row).toBeTruthy();
    expect(row?.contains(overview)).toBe(true);
    expect(row?.contains(create)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Personas" }));
    expect(onViewModeChange).toHaveBeenCalledWith("journeys");
  });

  it("does not render a header subtitle", () => {
    render(
      <SwarmsTabHeader
        projectId="proj-1"
        viewMode="overview"
        viewOptions={VIEW_OPTIONS}
        onViewModeChange={vi.fn()}
        onNewSwarm={vi.fn()}
      />,
    );

    const header = screen.getByTestId("swarms-tab-header-chrome");
    expect(header.querySelector("p")).toBeNull();
    expect(
      within(header).queryByText(/no recruiting, no scheduling/i),
    ).toBeNull();
  });
});
