/**
 * CONTRACT TESTS for the cross-surface Sessions panel.
 *
 * The inspector has no Convex codegen, so the (name, args) each subscription
 * dispatches IS the wire contract — a test that mocked the query away wouldn't
 * catch a wrong arg name (Convex would throw at runtime). We intercept
 * `usePaginatedQuery`, record every dispatch, and assert:
 *
 *   - the default feed is `sessionsFeed:listProjectSessions` with ONLY
 *     `{ projectId }` (no sourceTypes/status/q keys — absent, not undefined),
 *   - a source pill narrows SERVER-side via `sourceTypes`,
 *   - a typed search switches to `sessionsFeed:searchProjectSessions` with the
 *     debounced `q`,
 *   - the row's `id` (not `chatSessionId`) is what the detail pane opens.
 *
 * Fixtures are typed against `SessionFeedItem`, so a backend DTO rename forces
 * a fixture edit here rather than silently rendering blanks.
 */
import { fireEvent, render, screen, within, act } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { SessionFeedItem } from "@/lib/sessions-feed-api";

type PaginatedResult = {
  results: SessionFeedItem[];
  status: "LoadingFirstPage" | "CanLoadMore" | "Exhausted";
  isLoading: boolean;
  loadMore: (n: number) => void;
};

const mocks = vi.hoisted(() => ({
  paginated: {
    current: {
      results: [] as unknown[],
      status: "Exhausted",
      isLoading: false,
      loadMore: vi.fn(),
    },
  },
  paginatedCalls: [] as Array<{ name: string; args: unknown }>,
  detailThreadIds: [] as string[],
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: (name: string, args: unknown) => {
    mocks.paginatedCalls.push({ name, args });
    return mocks.paginated.current;
  },
  useQuery: () => undefined,
}));

// The shared detail pane pulls half a dozen session queries of its own; the
// panel's contract with it is just "opens the row's `id`", so stub it and
// record the id.
vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: ({ threadId }: { threadId: string }) => {
    mocks.detailThreadIds.push(threadId);
    return <div data-testid="thread-detail-stub">{threadId}</div>;
  },
}));

import { SessionsPanel } from "@/components/sessions/SessionsPanel";

function setRows(
  results: SessionFeedItem[],
  status: PaginatedResult["status"] = "Exhausted"
) {
  mocks.paginated.current = {
    results,
    status,
    isLoading: false,
    loadMore: vi.fn(),
  };
}

let fixtureSeq = 0;

function makeRow(overrides: Partial<SessionFeedItem>): SessionFeedItem {
  fixtureSeq += 1;
  return {
    id: `doc_${fixtureSeq}`,
    chatSessionId: `cs_${fixtureSeq}`,
    projectId: "p1",
    sourceType: "direct",
    status: "active",
    title: null,
    firstMessagePreview: "hello there",
    visibility: null,
    ownedByViewer: false,
    startedAt: 1_000,
    lastActivityAt: Date.now(),
    messageCount: 3,
    parentRef: null,
    ...overrides,
  };
}

function lastCall() {
  return mocks.paginatedCalls[mocks.paginatedCalls.length - 1];
}

beforeEach(() => {
  mocks.paginatedCalls.length = 0;
  mocks.detailThreadIds.length = 0;
  setRows([]);
});

describe("SessionsPanel — query contract", () => {
  test("dispatches the unified feed with ONLY { projectId } by default", () => {
    render(<SessionsPanel projectId="p1" />);

    const call = lastCall();
    expect(call.name).toBe("sessionsFeed:listProjectSessions");
    // Absent keys, not `undefined` values: the args object must not carry
    // sourceTypes/status/q at all when no filter is active.
    expect(call.args).toEqual({ projectId: "p1" });
  });

  test("a source pill narrows the query server-side via sourceTypes", () => {
    render(<SessionsPanel projectId="p1" />);

    fireEvent.click(screen.getByTestId("sessions-source-pill-swarm"));
    expect(lastCall()).toEqual({
      name: "sessionsFeed:listProjectSessions",
      args: { projectId: "p1", sourceTypes: ["swarm"] },
    });

    // Selecting every pill means "no filter" — the arg must drop back out so
    // the backend serves the plain project index.
    for (const pill of ["direct", "chatbox", "eval"]) {
      fireEvent.click(screen.getByTestId(`sessions-source-pill-${pill}`));
    }
    expect(lastCall().args).toEqual({ projectId: "p1" });
  });

  test("typing a search switches to the relevance-ranked search query after the debounce", () => {
    vi.useFakeTimers();
    render(<SessionsPanel projectId="p1" />);

    fireEvent.change(screen.getByTestId("sessions-search"), {
      target: { value: "checkout bug" },
    });
    // Before the debounce settles the subscription must NOT have switched —
    // every keystroke re-subscribing would thrash the reactive query.
    expect(lastCall().name).toBe("sessionsFeed:listProjectSessions");

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(lastCall()).toEqual({
      name: "sessionsFeed:searchProjectSessions",
      args: { projectId: "p1", q: "checkout bug" },
    });

    // Clearing the box returns to the recency feed.
    fireEvent.change(screen.getByTestId("sessions-search"), {
      target: { value: "" },
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(lastCall().name).toBe("sessionsFeed:listProjectSessions");
  });
});

describe("SessionsPanel — rows and detail", () => {
  test("renders source badges, ownership, parent chips, and Quick Run", () => {
    setRows([
      makeRow({
        chatSessionId: "cs_direct",
        sourceType: "direct",
        title: "My playground chat",
        ownedByViewer: true,
        visibility: "private",
      }),
      makeRow({
        chatSessionId: "cs_swarm",
        sourceType: "swarm",
        synthetic: true,
        parentRef: {
          kind: "journeyRun",
          journeyRunId: "jr1",
          journeyRefId: "j1",
          label: "Checkout journey",
        },
      }),
      makeRow({
        chatSessionId: "cs_quick",
        sourceType: "eval",
        // Quick Run: an iteration with no suite run, by construction — must
        // render as "Quick Run", not as an unresolved parent.
        parentRef: {
          kind: "evalRun",
          iterationId: "it1",
          suiteRunId: null,
          suiteId: null,
          label: null,
        },
      }),
    ]);
    render(<SessionsPanel projectId="p1" />);

    const direct = within(screen.getByTestId("session-row-cs_direct"));
    expect(direct.getByText("My playground chat")).toBeInTheDocument();
    expect(direct.getByText("Playground")).toBeInTheDocument();
    expect(direct.getByText("Yours")).toBeInTheDocument();

    const swarm = within(screen.getByTestId("session-row-cs_swarm"));
    expect(swarm.getByText("Swarm")).toBeInTheDocument();
    expect(swarm.getByText("Checkout journey")).toBeInTheDocument();

    const quick = within(screen.getByTestId("session-row-cs_quick"));
    expect(quick.getByText("Quick Run")).toBeInTheDocument();
  });

  test("clicking a row opens the detail pane with the row's `id`, not its chatSessionId", () => {
    setRows([
      makeRow({ id: "doc_abc", chatSessionId: "cs_abc", title: "Pick me" }),
    ]);
    render(<SessionsPanel projectId="p1" />);

    fireEvent.click(screen.getByTestId("session-row-cs_abc"));
    expect(screen.getByTestId("thread-detail-stub")).toHaveTextContent(
      "doc_abc"
    );
    expect(mocks.detailThreadIds).toContain("doc_abc");
    expect(mocks.detailThreadIds).not.toContain("cs_abc");
  });

  test("an empty unfiltered feed shows the getting-started empty state", () => {
    setRows([]);
    render(<SessionsPanel projectId="p1" />);

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Chat in the Playground, share a scenario/)
    ).toBeInTheDocument();
  });
});
