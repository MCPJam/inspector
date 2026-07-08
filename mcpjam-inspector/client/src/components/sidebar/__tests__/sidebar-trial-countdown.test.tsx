import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarTrialCountdown } from "@/components/sidebar/sidebar-trial-countdown";

describe("SidebarTrialCountdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tightens to one-second ticks after crossing into the final hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    const start = Date.now();
    render(
      <SidebarTrialCountdown
        trialStartedAt={start - 6 * 24 * 60 * 60 * 1000}
        trialEndsAt={start + 60 * 60 * 1000 + 1_000}
      />
    );

    expect(screen.getByText("1h 0m 1s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText("59m 1s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText("59m 0s")).toBeInTheDocument();
  });
});
