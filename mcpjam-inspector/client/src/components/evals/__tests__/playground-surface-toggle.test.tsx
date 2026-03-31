import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlaygroundSurfaceToggle } from "../playground-surface-toggle";

describe("PlaygroundSurfaceToggle", () => {
  it("calls onExplore when choosing Explore from Runs", async () => {
    const onExplore = vi.fn();
    const onRuns = vi.fn();
    const user = userEvent.setup();
    render(
      <PlaygroundSurfaceToggle
        value="runs"
        onExplore={onExplore}
        onRuns={onRuns}
      />,
    );

    await user.click(
      screen.getByRole("radio", { name: /Explore — edit cases/i }),
    );
    expect(onExplore).toHaveBeenCalledTimes(1);
    expect(onRuns).not.toHaveBeenCalled();
  });

  it("calls onRuns when choosing Runs from Explore", async () => {
    const onExplore = vi.fn();
    const onRuns = vi.fn();
    const user = userEvent.setup();
    render(
      <PlaygroundSurfaceToggle
        value="explore"
        onExplore={onExplore}
        onRuns={onRuns}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Runs — pass rates/i }));
    expect(onRuns).toHaveBeenCalledTimes(1);
    expect(onExplore).not.toHaveBeenCalled();
  });
});
