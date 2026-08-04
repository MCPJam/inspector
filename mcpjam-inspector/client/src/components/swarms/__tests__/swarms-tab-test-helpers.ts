import { fireEvent, screen, within } from "@testing-library/react";

export function openPersonasTab() {
  fireEvent.click(
    within(screen.getByLabelText("Swarm view")).getByRole("button", {
      name: /^personas$/i,
    }),
  );
}

export function openOverviewTab() {
  fireEvent.click(
    within(screen.getByLabelText("Swarm view")).getByRole("button", {
      name: /^overview$/i,
    }),
  );
}

export function openSessionsTab() {
  fireEvent.click(
    within(screen.getByLabelText("Swarm view")).getByRole("button", {
      name: /^sessions$/i,
    }),
  );
}
