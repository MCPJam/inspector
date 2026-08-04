import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatboxGoalOutcomeDrilldown,
  resolveNextBefore,
} from "../ChatboxGoalOutcomeDrilldown";
import {
  EMPTY_USAGE_FILTER,
  toggleChip,
  type InsightsSelection,
} from "@/hooks/chatbox-usage-filters";

const { mockUseGoalOutcomeDrilldown } = vi.hoisted(() => ({
  mockUseGoalOutcomeDrilldown: vi.fn(),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useGoalOutcomeDrilldown: (...args: unknown[]) =>
    mockUseGoalOutcomeDrilldown(...args),
}));

function session(id: string, preview: string) {
  return {
    _id: id,
    firstMessagePreview: preview,
    lastActivityAt: Date.UTC(2026, 4, 1),
  };
}

const CELL_A: InsightsSelection = {
  themes: [
    { dimension: "goal", clusterId: "cluster-a", label: "Invoice lookup" },
  ],
};

beforeEach(() => {
  mockUseGoalOutcomeDrilldown.mockReset();
});

function renderDrilldown(
  selection: InsightsSelection | null,
  onOpenSession = vi.fn()
) {
  return render(
    <ChatboxGoalOutcomeDrilldown
      scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
      selection={selection}
      filter={EMPTY_USAGE_FILTER}
      onClose={vi.fn()}
      onOpenSession={onOpenSession}
    />
  );
}

describe("ChatboxGoalOutcomeDrilldown", () => {
  it("renders nothing when nothing is selected", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: undefined,
      isLoading: false,
    });
    const { container } = renderDrilldown(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("reports the server-counted total, not the page length", () => {
    // The grid cell said 62; the page has 2 rows. The header must agree with the
    // grid, which is the entire reason the total is counted server-side.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first"), session("s2", "second")],
        nextBefore: 123,
        total: 62,
        totalTruncated: false,
      },
      isLoading: false,
    });
    renderDrilldown(CELL_A);
    expect(
      screen.getByText("62 sessions in this selection")
    ).toBeInTheDocument();
  });

  it("names the selected theme in the heading", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [],
        nextBefore: null,
        total: 0,
        totalTruncated: false,
      },
      isLoading: false,
    });
    renderDrilldown({
      themes: [
        { dimension: "goal", clusterId: "cluster-a", label: "Invoice lookup" },
      ],
    });
    expect(screen.getByRole("heading")).toHaveTextContent("Invoice lookup");
  });

  it("passes the goal theme through as the indexed narrowing", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [],
        nextBefore: null,
        total: 0,
        totalTruncated: false,
      },
      isLoading: false,
    });
    renderDrilldown({
      themes: [{ dimension: "goal", clusterId: "cluster-a" }],
    });
    // The goal theme is the one the index can serve directly; every other axis
    // narrows through the selection's chips, which are already in `filter`.
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: "cluster-a" })
    );
  });

  it("runs without a goal, for a node in a later stage", () => {
    // A click on a behavior / outcome / sentiment node has no cluster. The
    // query must still run — narrowing by the selection's chips alone — rather
    // than being skipped, which is what the old cell-shaped API did.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first")],
        nextBefore: null,
        total: 7,
        totalTruncated: false,
      },
      isLoading: false,
    });
    renderDrilldown({
      themes: [
        { dimension: "sentiment", clusterId: "s-1", label: "Frustrated" },
      ],
    });
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: null, enabled: true })
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Frustrated");
    expect(
      screen.getByText("7 sessions in this selection")
    ).toBeInTheDocument();
  });

  it("names both endpoints of a selected link", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [],
        nextBefore: null,
        total: 0,
        totalTruncated: false,
      },
      isLoading: false,
    });
    renderDrilldown({
      themes: [
        { dimension: "outcome", clusterId: "o-1", label: "Goal reached" },
        { dimension: "sentiment", clusterId: "s-1", label: "Frustrated" },
      ],
    });
    expect(screen.getByRole("heading")).toHaveTextContent(
      "Goal reached · Frustrated"
    );
  });

  it("warns when the selection total hit the scan limit", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first")],
        nextBefore: null,
        total: 2000,
        totalTruncated: true,
      },
      isLoading: false,
    });
    renderDrilldown(CELL_A);
    expect(
      screen.getByText("2,000+ sessions in this selection")
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/scan limit/i);
  });

  it("starts with no cursor and advances it on Load more", async () => {
    const user = userEvent.setup();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first")],
        nextBefore: 555,
        total: 40,
        totalTruncated: false,
      },
      isLoading: false,
    });
    renderDrilldown(CELL_A);

    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: undefined })
    );

    await user.click(screen.getByRole("button", { name: /Load 25 more/ }));
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: 555 })
    );
  });

  it("resets the cursor when the selection changes", async () => {
    const user = userEvent.setup();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "cell A row")],
        nextBefore: 555,
        total: 40,
        totalTruncated: false,
      },
      isLoading: false,
    });
    const { rerender } = renderDrilldown(CELL_A);

    await user.click(screen.getByRole("button", { name: /Load 25 more/ }));
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: 555 })
    );

    // Switching cells must not carry the previous cell's cursor over — the
    // second page of cell A is not the second page of cell B.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s9", "cell B row")],
        nextBefore: null,
        total: 3,
        totalTruncated: false,
      },
      isLoading: false,
    });
    rerender(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={{
          themes: [
            { dimension: "goal", clusterId: "cluster-b", label: "Refunds" },
          ],
        }}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );

    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ clusterId: "cluster-b", before: undefined })
    );
    // And the previous cell's rows must be gone, not merged in.
    expect(screen.queryByText("cell A row")).not.toBeInTheDocument();
    expect(screen.getByText("cell B row")).toBeInTheDocument();
  });

  it("accumulates pages without duplicating rows", async () => {
    const user = userEvent.setup();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first")],
        nextBefore: 555,
        total: 40,
        totalTruncated: false,
      },
      isLoading: false,
    });
    const { rerender } = renderDrilldown(CELL_A);

    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        // The server re-sends s1 (overlapping cursor); it must not double up.
        sessions: [session("s1", "first"), session("s2", "second")],
        nextBefore: null,
        total: 40,
        totalTruncated: false,
      },
      isLoading: false,
    });
    await user.click(screen.getByRole("button", { name: /Load 25 more/ }));
    rerender(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );

    expect(screen.getAllByText("first")).toHaveLength(1);
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("opens a session when its row is clicked", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first")],
        nextBefore: null,
        total: 1,
        totalTruncated: false,
      },
      isLoading: false,
    });
    renderDrilldown(CELL_A, onOpenSession);

    await user.click(screen.getByText("first"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("resets the cursor and rows when another facet chip changes", async () => {
    // The filter is part of the query. Keeping the cursor and rows across a
    // filter change would show sessions the new filter excludes and would start
    // from page two of a set that no longer exists.
    const user = userEvent.setup();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "unfiltered row")],
        nextBefore: 555,
        total: 40,
        totalTruncated: false,
      },
      isLoading: false,
    });
    const { rerender } = render(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: /Load 25 more/ }));
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: 555 })
    );

    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s9", "filtered row")],
        nextBefore: null,
        total: 2,
        totalTruncated: false,
      },
      isLoading: false,
    });
    rerender(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={CELL_A}
        filter={toggleChip(EMPTY_USAGE_FILTER, {
          kind: "dimension",
          key: "deviceKind",
          value: "mobile",
        })}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );

    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: undefined })
    );
    expect(screen.queryByText("unfiltered row")).not.toBeInTheDocument();
    expect(screen.getByText("filtered row")).toBeInTheDocument();
  });

  it("keeps the count and the pager steady while the next page is in flight", async () => {
    // Advancing the cursor makes the subscription return undefined again.
    // Without carrying the last settled values, the header flips to "Loading…"
    // and the button the user just clicked disappears from under the cursor.
    const user = userEvent.setup();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first")],
        nextBefore: 555,
        total: 40,
        totalTruncated: false,
      },
      isLoading: false,
    });
    const { rerender } = render(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: /Load 25 more/ }));

    // In-flight: the query has no answer for the new cursor yet.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: undefined,
      isLoading: true,
    });
    rerender(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );

    expect(
      screen.getByText("40 sessions in this selection")
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading sessions…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Load 25 more/ })
    ).toBeInTheDocument();
    // Already-loaded rows stay put too.
    expect(screen.getByText("first")).toBeInTheDocument();
  });

  it("says the selection is empty only once the query has answered", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: undefined,
      isLoading: true,
    });
    const { rerender } = renderDrilldown(CELL_A);
    expect(screen.queryByText(/No sessions match/i)).not.toBeInTheDocument();
    expect(screen.getByText("Loading sessions…")).toBeInTheDocument();

    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [],
        nextBefore: null,
        total: 0,
        totalTruncated: false,
      },
      isLoading: false,
    });
    rerender(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );
    expect(screen.getByText(/No sessions match/i)).toBeInTheDocument();
  });

  it("removes the pager as soon as the final page settles with no cursor", async () => {
    // The settled `nextBefore: null` is an answer ("no more rows"), not a gap
    // to coalesce over. Falling back to the previous page's cursor here keeps
    // a dead "Load more" button on screen after the set is exhausted.
    const user = userEvent.setup();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s1", "first")],
        nextBefore: 555,
        total: 2,
        totalTruncated: false,
      },
      isLoading: false,
    });
    const { rerender } = renderDrilldown(CELL_A);
    await user.click(screen.getByRole("button", { name: /Load 25 more/ }));

    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("s2", "second")],
        nextBefore: null,
        total: 2,
        totalTruncated: false,
      },
      isLoading: false,
    });
    rerender(
      <ChatboxGoalOutcomeDrilldown
        scope={{ kind: "chatbox", chatboxId: "chatbox-1" }}
        selection={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /Load 25 more/ })
    ).not.toBeInTheDocument();
  });
});

describe("resolveNextBefore", () => {
  // The DOM assertions above cannot pin the regression exactly: the buggy
  // frame lives between render and the accumulate effect, and testing-library
  // flushes effects before any assertion runs. The derivation is therefore a
  // pure exported function, pinned here where the distinction IS observable.
  it("honors a settled null instead of falling back to the stale cursor", () => {
    expect(resolveNextBefore({ nextBefore: null }, 555)).toBeNull();
  });

  it("keeps the last settled cursor while the next page is in flight", () => {
    expect(resolveNextBefore(undefined, 555)).toBe(555);
  });

  it("reports a live cursor as-is", () => {
    expect(resolveNextBefore({ nextBefore: 123 }, 555)).toBe(123);
  });

  it("is null before anything has settled", () => {
    expect(resolveNextBefore(undefined, undefined)).toBeNull();
  });
});
