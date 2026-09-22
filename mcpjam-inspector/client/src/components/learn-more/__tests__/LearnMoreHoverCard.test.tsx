import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnMoreHoverCard } from "../LearnMoreHoverCard";

// From learnMoreContent["projects"] — the card body, so its presence proves the
// hover card actually opened rather than just the tooltip.
const CARD_BODY = "Organize your MCP servers into projects.";
const HANDOFF_MS = 1000;

function card(suppressed: boolean) {
  return (
    <LearnMoreHoverCard
      tabId="projects"
      onExpand={vi.fn()}
      // Both required for the tooltip-then-card handoff, which is the path
      // that arms the timer. nav-main uses it for the collapsed sidebar.
      triggerTooltip="Projects"
      triggerTooltipDelayMs={HANDOFF_MS}
      suppressed={suppressed}
    >
      <button type="button">Projects</button>
    </LearnMoreHoverCard>
  );
}

function hoverTrigger() {
  fireEvent.pointerEnter(screen.getByRole("button", { name: "Projects" }), {
    pointerType: "mouse",
  });
  // Radix's own openDelay is 0 on this path; let it fire so onOpenChange runs.
  act(() => {
    vi.advanceTimersByTime(0);
  });
}

describe("LearnMoreHoverCard handoff timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the card once the handoff delay elapses", () => {
    // Control for the suppression test below: without it, a card that never
    // opens in jsdom would make that assertion vacuously true.
    vi.useFakeTimers();
    render(card(false));
    hoverTrigger();
    expect(screen.queryByText(CARD_BODY)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(HANDOFF_MS);
    });

    expect(screen.getByText(CARD_BODY)).toBeInTheDocument();
  });

  it("cancels a pending handoff when suppression lands before it fires", () => {
    vi.useFakeTimers();
    const { rerender } = render(card(false));
    hoverTrigger();

    // The trigger hands off to another popover mid-delay.
    rerender(card(true));
    act(() => {
      vi.advanceTimersByTime(HANDOFF_MS * 2);
    });
    expect(screen.queryByText(CARD_BODY)).not.toBeInTheDocument();

    // The `open && !suppressed` gate alone would satisfy the assertion above,
    // so release suppression: only a genuinely cancelled timer leaves the card
    // shut here. A surviving one banked `open` and pops it without a hover.
    rerender(card(false));
    act(() => {
      vi.advanceTimersByTime(HANDOFF_MS * 2);
    });
    expect(screen.queryByText(CARD_BODY)).not.toBeInTheDocument();
  });
});
