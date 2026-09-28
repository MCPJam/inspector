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

  // BB-236: the headline is one line for the whole surface, so it holds on
  // Personas and Sessions too, not just the Overview it pitches.
  it.each(VIEW_OPTIONS)("renders the headline on $label", ({ value }) => {
    render(
      <SwarmsTabHeader
        projectId="proj-1"
        viewMode={value}
        viewOptions={VIEW_OPTIONS}
        onViewModeChange={vi.fn()}
        onNewSwarm={vi.fn()}
      />,
    );

    const header = screen.getByTestId("swarms-tab-header-chrome");
    expect(
      within(header).getByText(
        "No recruiting, no scheduling, no setup. Agents find what breaks in every client.",
      ),
    ).toBeTruthy();
  });
});
