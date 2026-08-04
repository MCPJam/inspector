import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwarmsEmptyHero } from "../swarms-empty-hero";

describe("SwarmsEmptyHero", () => {
  it("renders the swarm empty hero and wires the New swarm CTA", () => {
    const onNewSwarm = vi.fn();
    render(<SwarmsEmptyHero onNewSwarm={onNewSwarm} />);

    expect(screen.getByTestId("swarms-empty-hero")).toBeTruthy();
    expect(screen.getByText("Create your first swarm")).toBeTruthy();
    expect(screen.getByText("What swarms looks like")).toBeTruthy();
    expect(screen.getByText("Goal trend")).toBeTruthy();
    expect(screen.getByText("Client matrix")).toBeTruthy();
    expect(screen.getByText("Session trace")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^new swarm$/i }));
    expect(onNewSwarm).toHaveBeenCalledTimes(1);
  });
});
