import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SwarmRunningHero } from "../swarm-running-hero";

describe("SwarmRunningHero", () => {
  it("shows three jumping runners, each offset so the row reads as a wave", () => {
    render(<SwarmRunningHero />);

    const row = screen.getByTestId("swarm-running-hero");
    const jumpers = Array.from(
      row.querySelectorAll(".animate-swarm-hero-jump"),
    ) as HTMLElement[];

    expect(jumpers).toHaveLength(3);
    expect(
      jumpers.map((node) => parseFloat(node.style.animationDelay)),
    ).toEqual([-0, -0.367, -0.733]);
    for (const node of jumpers) {
      expect(parseFloat(node.style.animationDelay)).toBeLessThanOrEqual(0);
    }
    expect(row.querySelectorAll("img")).toHaveLength(3);
    expect(screen.queryByTestId("persona-pixel-avatar")).toBeNull();
  });

  it("lets the running frame push the row to either edge", () => {
    const { rerender } = render(
      <SwarmRunningHero className="justify-start" />,
    );
    expect(screen.getByTestId("swarm-running-hero")).toHaveClass(
      "justify-start",
    );

    rerender(<SwarmRunningHero className="justify-end" />);
    expect(screen.getByTestId("swarm-running-hero")).toHaveClass("justify-end");
  });
});
