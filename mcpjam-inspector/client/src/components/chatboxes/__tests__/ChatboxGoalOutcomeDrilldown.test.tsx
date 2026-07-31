import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatboxGoalOutcomeDrilldown } from "../ChatboxGoalOutcomeDrilldown";
import { EMPTY_USAGE_FILTER } from "@/hooks/chatbox-usage-filters";

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

const CELL_A = {
  clusterId: "cluster-a",
  clusterLabel: "Invoice lookup",
  outcome: "unresolved" as const,
};

beforeEach(() => {
  mockUseGoalOutcomeDrilldown.mockReset();
});

function renderDrilldown(
  cell: typeof CELL_A | { clusterId: string; outcome: null } | null,
  onOpenSession = vi.fn(),
) {
  return render(
    <ChatboxGoalOutcomeDrilldown
      chatboxId="chatbox-1"
      cell={cell as never}
      filter={EMPTY_USAGE_FILTER}
      onClose={vi.fn()}
      onOpenSession={onOpenSession}
    />,
  );
}

describe("ChatboxGoalOutcomeDrilldown", () => {
  it("renders nothing when no cell is selected", () => {
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
    expect(screen.getByText("62 sessions in this cell")).toBeInTheDocument();
  });

  it("labels the not-analyzed cell distinctly", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: { sessions: [], nextBefore: null, total: 0, totalTruncated: false },
      isLoading: false,
    });
    renderDrilldown({ clusterId: "cluster-a", outcome: null });
    expect(screen.getByRole("heading")).toHaveTextContent("not analyzed");
  });

  it("passes outcome: null through for the not-analyzed cell", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: { sessions: [], nextBefore: null, total: 0, totalTruncated: false },
      isLoading: false,
    });
    renderDrilldown({ clusterId: "cluster-a", outcome: null });
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: "cluster-a", outcome: null }),
    );
  });

  it("warns when the cell total hit the scan limit", () => {
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
    expect(screen.getByText("2,000+ sessions in this cell")).toBeInTheDocument();
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
      expect.objectContaining({ before: undefined }),
    );

    await user.click(screen.getByRole("button", { name: /Load 25 more/ }));
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: 555 }),
    );
  });

  it("resets the cursor when the selected cell changes", async () => {
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
      expect.objectContaining({ before: 555 }),
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
        chatboxId="chatbox-1"
        cell={{
          clusterId: "cluster-b",
          clusterLabel: "Refunds",
          outcome: "errored",
        }}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    expect(mockUseGoalOutcomeDrilldown).toHaveBeenLastCalledWith(
      expect.objectContaining({ clusterId: "cluster-b", before: undefined }),
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
        chatboxId="chatbox-1"
        cell={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />,
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

  it("says the cell is empty only once the query has answered", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: undefined,
      isLoading: true,
    });
    const { rerender } = renderDrilldown(CELL_A);
    expect(screen.queryByText(/No sessions match/i)).not.toBeInTheDocument();
    expect(screen.getByText("Loading sessions…")).toBeInTheDocument();

    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: { sessions: [], nextBefore: null, total: 0, totalTruncated: false },
      isLoading: false,
    });
    rerender(
      <ChatboxGoalOutcomeDrilldown
        chatboxId="chatbox-1"
        cell={CELL_A}
        filter={EMPTY_USAGE_FILTER}
        onClose={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText(/No sessions match/i)).toBeInTheDocument();
  });
});
