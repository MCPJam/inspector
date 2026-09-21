/**
 * The sessions-list row's feedback line.
 *
 * The row has ONE number's worth of space, and which number it spends it on
 * depends on how the session was rated. The amber treatment is style-agnostic
 * on purpose — it keys on the worst turn, which thumbs are projected onto
 * server-side.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThreadList: () => ({ threads: [] }),
}));

import { ThreadCard } from "../ShareUsageThreadList";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

function thread(
  feedback: Partial<NonNullable<SharedChatThread["feedback"]>> | null,
  extra: Partial<SharedChatThread> = {},
): SharedChatThread {
  return {
    _id: "t1",
    sourceType: "scenario",
    chatSessionId: "cs1",
    messageCount: 4,
    startedAt: 0,
    lastActivityAt: Date.now(),
    visitorDisplayName: "Dana",
    firstMessagePreview: "Asked what server can do",
    ...(feedback
      ? {
          feedback: {
            count: 1,
            avg: 3,
            min: 3,
            hasComment: false,
            latestRating: 3,
            latestAt: 0,
            ...feedback,
          },
        }
      : {}),
    ...extra,
  } as SharedChatThread;
}

function renderCard(t: SharedChatThread, isSelected = false) {
  render(<ThreadCard thread={t} isSelected={isSelected} onSelect={() => {}} />);
}

describe("ThreadCard feedback line", () => {
  it("shows the average for a star-rated session", () => {
    renderCard(thread({ count: 2, avg: 4.5, min: 4, latestRating: 5 }));
    expect(screen.getByText("4.5")).toBeInTheDocument();
    expect(screen.queryByText(/\/5/)).toBeNull();
  });

  it("shows thumb tallies instead of an average for a thumbs session", () => {
    renderCard(
      thread({
        count: 3,
        avg: 3.67,
        min: 1,
        thumbUpCount: 2,
        thumbDownCount: 1,
      }),
    );
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("👍")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("👎")).toBeInTheDocument();
    expect(screen.queryByText(/\/5/)).toBeNull();
  });

  it("shows both for a session rated under both styles", () => {
    renderCard(thread({ count: 3, avg: 3, min: 1, thumbDownCount: 1 }));
    expect(screen.getByText("3.0")).toBeInTheDocument();
    expect(screen.getByText("👎")).toBeInTheDocument();
  });

  it("tints a thumbs-down session amber, same predicate as a 1★", () => {
    renderCard(thread({ count: 1, avg: 1, min: 1, thumbDownCount: 1 }));
    expect(screen.getByText("👎").closest("[data-rating-tone]")).toHaveAttribute(
      "data-rating-tone",
      "low",
    );
  });

  it("leaves the no-feedback branch alone", () => {
    renderCard(thread(null));
    expect(screen.getByLabelText("No feedback")).toBeInTheDocument();
  });

  it("uses a compact row with a selected left rail", () => {
    renderCard(thread(null), true);
    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("data-selected", "true");
    expect(row).toHaveClass("border-l-primary");
    expect(screen.getByText("Asked what server can do")).toBeInTheDocument();
  });
});
