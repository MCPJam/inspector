import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FindingsEvidenceSessions } from "../findings-evidence-sessions";
import type { JourneySessionRow } from "@/lib/swarm-api";

/**
 * The contract this component exists to hold: a stage's session list is
 * scoped by the EVIDENCE, not by the goal. A run-scoped list renders the same
 * rows on all six stages of the chain and disagrees with the count printed
 * beside it.
 */

const { mockUsePaginatedQuery } = vi.hoisted(() => ({
  mockUsePaginatedQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: (...args: unknown[]) => mockUsePaginatedQuery(...args),
}));

function row(overrides: Partial<JourneySessionRow> = {}): JourneySessionRow {
  return {
    id: "sess-a",
    chatSessionId: "chat-a",
    projectId: "proj-1",
    hostId: "host-1",
    startedAt: 0,
    ...overrides,
  };
}

function graded(
  id: string,
  results: Array<{ criterionId: string; passed: boolean }>
): JourneySessionRow {
  return row({
    id,
    firstMessagePreview: `Prompt for ${id}`,
    criteria: { status: "completed", generation: 1, results },
  });
}

function loaded(rows: JourneySessionRow[], status = "Exhausted") {
  mockUsePaginatedQuery.mockReturnValue({
    results: rows,
    status,
    loadMore: vi.fn(),
    isLoading: false,
  });
}

beforeEach(() => {
  mockUsePaginatedQuery.mockReset();
});

const previews = () =>
  screen
    .getAllByTestId("findings-evidence-session")
    .map((node) => node.dataset.sessionId);

describe("FindingsEvidenceSessions", () => {
  it("pages the run by journeyRunId, the arg name the backend query takes", () => {
    loaded([]);
    render(
      <FindingsEvidenceSessions
        runId="run-1"
        sessions={{ kind: "goalScoreFail" }}
        onOpenSession={vi.fn()}
      />
    );

    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      "journeyRuns:listSessionsByJourneyRun",
      { journeyRunId: "run-1" },
      expect.objectContaining({ initialNumItems: expect.any(Number) })
    );
  });

  it("lists only the sessions that failed THIS criterion", async () => {
    const onOpenSession = vi.fn();
    loaded([
      graded("sess-a", [{ criterionId: "crit-block", passed: false }]),
      graded("sess-b", [{ criterionId: "crit-soft", passed: false }]),
      graded("sess-c", [{ criterionId: "crit-block", passed: true }]),
      // A pending grade asserts nothing about the criterion, so it is out.
      row({ id: "sess-d", criteria: { status: "pending", generation: 1 } }),
    ]);
    render(
      <FindingsEvidenceSessions
        runId="run-1"
        sessions={{ kind: "criterion", criterionId: "crit-block" }}
        onOpenSession={onOpenSession}
      />
    );

    expect(previews()).toEqual(["sess-a"]);
    await userEvent.click(screen.getByTestId("findings-evidence-session"));
    expect(onOpenSession).toHaveBeenCalledWith("sess-a");
  });

  it("lists only the sessions whose completion grade failed", () => {
    loaded([
      row({
        id: "sess-a",
        goalScore: { status: "completed", score: 0.1, passed: false },
      }),
      row({
        id: "sess-b",
        goalScore: { status: "completed", score: 0.9, passed: true },
      }),
      // Still running: not a failed grade, and not evidence either way.
      row({ id: "sess-c", goalScore: { status: "running" } }),
    ]);
    render(
      <FindingsEvidenceSessions
        runId="run-1"
        sessions={{ kind: "goalScoreFail" }}
        onOpenSession={vi.fn()}
      />
    );

    expect(previews()).toEqual(["sess-a"]);
  });

  it("keeps the miner's worst-first order and never drops a named id", () => {
    // `sess-x` belongs to a sibling run — a persona-scoped candidate fans
    // across a persona's goals. It must still be openable rather than
    // vanishing from a count we already printed.
    loaded([row({ id: "sess-b", firstMessagePreview: "Second prompt" })]);
    render(
      <FindingsEvidenceSessions
        runId="run-1"
        sessions={{ kind: "ids", ids: ["sess-x", "sess-b"], affected: 2 }}
        onOpenSession={vi.fn()}
      />
    );

    expect(previews()).toEqual(["sess-x", "sess-b"]);
    expect(screen.getByText("(no preview)")).toBeInTheDocument();
    expect(screen.getByText('"Second prompt"')).toBeInTheDocument();
  });

  it("holds the spinner until the run is exhausted, never a partial list", () => {
    loaded(
      [graded("sess-a", [{ criterionId: "crit-block", passed: false }])],
      "CanLoadMore"
    );
    render(
      <FindingsEvidenceSessions
        runId="run-1"
        sessions={{ kind: "criterion", criterionId: "crit-block" }}
        onOpenSession={vi.fn()}
      />
    );

    expect(screen.getByText("Loading sessions…")).toBeInTheDocument();
    expect(
      screen.queryByTestId("findings-evidence-session")
    ).not.toBeInTheDocument();
  });

  it("names the scope that came up empty rather than saying 'no sessions'", () => {
    loaded([graded("sess-a", [{ criterionId: "crit-soft", passed: false }])]);
    render(
      <FindingsEvidenceSessions
        runId="run-1"
        sessions={{ kind: "criterion", criterionId: "crit-block" }}
        onOpenSession={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        "No session in this run carries a failing verdict for this check."
      )
    ).toBeInTheDocument();
  });
});
