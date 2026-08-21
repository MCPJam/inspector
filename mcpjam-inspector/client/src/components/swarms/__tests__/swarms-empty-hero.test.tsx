import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwarmsEmptyHero } from "../swarms-empty-hero";

describe("SwarmsEmptyHero", () => {
  it("renders the redesigned empty state and wires the CTA", () => {
    const onNewSwarm = vi.fn();
    render(<SwarmsEmptyHero onNewSwarm={onNewSwarm} />);

    expect(screen.getByTestId("swarms-empty-hero")).toBeTruthy();
    expect(screen.getByText("Create your first swarm")).toBeTruthy();
    expect(
      screen.getByText(
        "We invent realistic users, drop them into the clients your users actually use, and report what breaks."
      )
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /^create new swarm$/i })
    );
    expect(onNewSwarm).toHaveBeenCalledTimes(1);
  });

  it("drops the faked preview cards that used to sit under the hero", () => {
    // "Goal trend" / "Client matrix" / "Session trace" rendered invented
    // numbers on a page with no data. The redesigned frame has none of them,
    // and a reader can't tell a mock chart from a real one.
    render(<SwarmsEmptyHero onNewSwarm={vi.fn()} />);

    expect(screen.queryByText("What swarms looks like")).toBeNull();
    expect(screen.queryByText("Goal trend")).toBeNull();
    expect(screen.queryByText("Client matrix")).toBeNull();
    expect(screen.queryByText("Session trace")).toBeNull();
  });

  it("shows four jumping characters, each offset so the row reads as a wave", () => {
    // The bounce is the design note the task exists for, and it is CSS-only —
    // asserting the class + stagger is the only way a unit test can see it.
    // `animate-swarm-hero-jump` carries a prefers-reduced-motion opt-out.
    render(<SwarmsEmptyHero onNewSwarm={vi.fn()} />);

    const row = screen.getByTestId("swarm-hero-characters");
    const jumpers = Array.from(
      row.querySelectorAll(".animate-swarm-hero-jump")
    ) as HTMLElement[];

    expect(jumpers).toHaveLength(4);
    // Parsed, not string-compared: browsers normalize "-0.000s" to "0s" and
    // trim trailing zeros, so the raw attribute is not stable across engines.
    expect(
      jumpers.map((node) => parseFloat(node.style.animationDelay))
    ).toEqual([-0, -0.275, -0.55, -0.825]);
    // Negative delays only — a positive one would leave the row standing still
    // for up to a second on first paint.
    for (const node of jumpers) {
      expect(parseFloat(node.style.animationDelay)).toBeLessThanOrEqual(0);
    }
    expect(screen.getAllByTestId("persona-pixel-avatar")).toHaveLength(4);
  });

  it("gives the four characters distinct silhouettes and palettes", () => {
    // A hashed seed would collide or drift as the family/mineral lists grow;
    // these are pinned to the frame's Basalt / Amethyst / Jade / Oxide row.
    render(<SwarmsEmptyHero onNewSwarm={vi.fn()} />);

    const avatars = screen.getAllByTestId("persona-pixel-avatar");
    const looks = avatars.map(
      (node) => `${node.dataset.shape}:${node.dataset.palette}`
    );

    expect(looks).toEqual(["0:0", "1:5", "4:1", "5:2"]);
    expect(new Set(looks).size).toBe(4);
  });
});
