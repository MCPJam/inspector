// ⚽ World Cup 2026 — remove after the tournament (see world-cup-ball.tsx)
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorldCupBall } from "@/components/world-cup-ball";

describe("WorldCupBall", () => {
  it("renders a soccer ball", () => {
    render(<WorldCupBall />);
    expect(screen.queryByRole("img", { name: /soccer ball/i })).not.toBeNull();
  });

  it("bounces on click without navigating (stops propagation)", () => {
    const onParentClick = vi.fn();
    render(
      <button type="button" onClick={onParentClick}>
        <WorldCupBall />
      </button>
    );

    const ball = screen.getByRole("img", { name: /soccer ball/i });
    fireEvent.click(ball);

    // The ball lives inside the logo's nav button; clicking it must NOT bubble
    // up and navigate — it should only trigger the kick animation.
    expect(onParentClick).not.toHaveBeenCalled();
    expect(ball.className).toContain("wc-ball--kick");
  });
});
