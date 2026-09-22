/**
 * The Sessions browser's rating filter.
 *
 * What matters here is WHERE the filter is applied. `chatSessions:listByScenario`
 * caps its page at 100 rows and applies filters inside the index walk that
 * fills it, so the selection has to reach the QUERY. Filtering only the
 * returned page would narrow 100 rows instead of the scenario, silently hiding
 * every older session that matches — the failure mode is invisible, which is
 * exactly why it is pinned.
 */
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioSettings } from "@/hooks/useScenarios";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

const { useUsageInsightsMock, threadListMock } = vi.hoisted(() => ({
  useUsageInsightsMock: vi.fn(),
  threadListMock: vi.fn(),
}));

vi.mock("@/hooks/useUsageInsights", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/useUsageInsights")
  >("@/hooks/useUsageInsights");
  return { ...actual, useUsageInsights: useUsageInsightsMock };
});

vi.mock("@/components/connection/share-usage/ShareUsageThreadList", () => ({
  ShareUsageThreadList: (props: Record<string, unknown>) => {
    threadListMock(props);
    return <div data-testid="thread-list" />;
  },
  SessionListChrome: ({
    countLabel,
    children,
  }: {
    countLabel: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      {countLabel}
      {children}
    </div>
  ),
}));

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => <div data-testid="thread-detail" />,
}));

vi.mock("@/components/scenarios/scenario-sessions-metric-strip", () => ({
  ScenarioSessionsMetricStrip: () => null,
}));

vi.mock("@/hooks/usePromoteCapability", () => ({
  usePromoteCapability: () => ({ canPromote: false }),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));

import { ScenarioUsagePanel } from "../ScenarioUsagePanel";

function thread(
  overrides: Partial<SharedChatThread> & Pick<SharedChatThread, "_id">
): SharedChatThread {
  return {
    sourceType: "scenario",
    messageCount: 0,
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  } as SharedChatThread;
}

const SCENARIO = {
  scenarioId: "cbx_1",
  projectId: "proj_1",
  name: "Scenario",
} as unknown as ScenarioSettings;

function lastFilters() {
  const call = useUsageInsightsMock.mock.calls.at(-1);
  return (call?.[0] as { filters?: unknown })?.filters as {
    preset: string;
    chips: Array<{ kind: string; key?: string; value?: string }>;
  };
}

describe("ScenarioUsagePanel rating filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUsageInsightsMock.mockReturnValue({ threads: [] });
  });

  it("defaults to every rating and still carries the traffic policy", () => {
    render(<ScenarioUsagePanel scenario={SCENARIO} />);
    const filters = lastFilters();
    expect(filters.preset).toBe("all");
    // The force-applied hide-synthetic chip is what every User Testing number
    // is computed over; the rating filter must compose with it, not replace it.
    expect(filters.chips).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "synthetic" })])
    );
    expect(filters.chips.some((chip) => chip.key === "feedbackBucket")).toBe(
      false
    );
  });

  it("sends the selection to the QUERY, not just the rendered page", () => {
    render(<ScenarioUsagePanel scenario={SCENARIO} />);
    fireEvent.click(screen.getByTestId("scenario-sessions-rating-filter"));
    fireEvent.click(screen.getByText("Low (≤2)"));

    const filters = lastFilters();
    expect(filters.chips).toEqual(
      expect.arrayContaining([
        { kind: "dimension", key: "feedbackBucket", value: "negative" },
        expect.objectContaining({ key: "synthetic" }),
      ])
    );
  });

  it("expresses 'no feedback' as the preset, not a bucket chip", () => {
    // "Nobody rated this" is the absence of a record — the preset is the
    // shared expression of that on both sides of the wire.
    render(<ScenarioUsagePanel scenario={SCENARIO} />);
    fireEvent.click(screen.getByTestId("scenario-sessions-rating-filter"));
    fireEvent.click(screen.getByText("No feedback"));

    const filters = lastFilters();
    expect(filters.preset).toBe("no_feedback");
    expect(filters.chips.some((chip) => chip.key === "feedbackBucket")).toBe(
      false
    );
  });

  it("hands the list the rating selection for its empty-state copy, minus the policy chip", () => {
    // The list's `filterState` only feeds the empty-state copy. It must see
    // the USER'S selection — "Low (≤2)" over a clean scenario has to read as
    // "no sessions match the current filters", not "No conversations yet" —
    // but never the force-applied hide-synthetic policy chip, which would
    // claim an active filter on an untouched panel.
    render(<ScenarioUsagePanel scenario={SCENARIO} />);

    let listProps = threadListMock.mock.calls.at(-1)?.[0] as {
      filterState?: { preset: string; chips: Array<{ key?: string }> };
    };
    expect(listProps.filterState?.preset).toBe("all");
    expect(listProps.filterState?.chips).toEqual([]);

    fireEvent.click(screen.getByTestId("scenario-sessions-rating-filter"));
    fireEvent.click(screen.getByText("Low (≤2)"));

    listProps = threadListMock.mock.calls.at(-1)?.[0] as {
      filterState?: { preset: string; chips: Array<{ key?: string }> };
    };
    expect(listProps.filterState?.chips).toEqual([
      { kind: "dimension", key: "feedbackBucket", value: "negative" },
    ]);
    expect(
      listProps.filterState?.chips.some((chip) => chip.key === "synthetic")
    ).toBe(false);
  });

  it("re-checks the returned page so a live update cannot leak through", () => {
    useUsageInsightsMock.mockReturnValue({
      threads: [
        thread({
          _id: "bad",
          feedback: {
            count: 1,
            avg: 2,
            min: 2,
            hasComment: false,
            latestRating: 2,
            latestAt: 0,
          },
        }),
        // Server-side filtering would have excluded this; a live update can
        // still push it into an open subscription.
        thread({
          _id: "good",
          feedback: {
            count: 1,
            avg: 5,
            min: 5,
            hasComment: false,
            latestRating: 5,
            latestAt: 0,
          },
        }),
      ],
    });

    render(<ScenarioUsagePanel scenario={SCENARIO} />);
    fireEvent.click(screen.getByTestId("scenario-sessions-rating-filter"));
    fireEvent.click(screen.getByText("Low (≤2)"));

    const rendered = threadListMock.mock.calls.at(-1)?.[0] as {
      threads?: SharedChatThread[];
    };
    expect(rendered.threads?.map((t) => t._id)).toEqual(["bad"]);
  });
});
