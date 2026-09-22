import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Shared SwarmsTab navigation helpers.
 *
 * SwarmsTab now lands on the OVERVIEW tab, so a suite that exercises the
 * Personas / Sessions surfaces has to navigate there first. Doing that through
 * the real view-mode nav (rather than a prop) is deliberate: the tab wiring is
 * the thing most likely to break when a view mode is added, and a helper that
 * reached past the nav would hide exactly that.
 *
 * Insights lives on `/swarms/:swarmId`, not the list header.
 */
function viewNav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Swarm view" });
}

function openTab(label: string): void {
  fireEvent.click(within(viewNav()).getByRole("button", { name: label }));
}

/** Overview — the default landing tab. */
export function openOverviewTab(): void {
  openTab("Overview");
}

/** Personas — the journeys/runs authoring surface (was the old default). */
export function openPersonasTab(): void {
  openTab("Personas");
}

/** Sessions — the flat swarm-session browser. */
export function openSessionsTab(): void {
  openTab("Sessions");
}

/** The view mode currently marked active in the nav, by its label. */
export function activeViewLabel(): string | null {
  const current = within(viewNav()).queryByRole("button", { current: "page" });
  return current?.textContent?.trim() ?? null;
}
