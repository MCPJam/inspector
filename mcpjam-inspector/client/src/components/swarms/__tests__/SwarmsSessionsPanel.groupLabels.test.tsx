/**
 * The Sessions tab must name its run / goal groups. Only the create flow knows
 * the runs the current session launched, so everything else has to come from
 * the project's overview window — otherwise a fresh page load groups sessions
 * under an id suffix that means nothing to a reader.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const session = {
  id: "thread-1",
  chatSessionId: "synth_run-1_host-1_0",
  projectId: "proj-1",
  hostId: "host-1",
  personaRefId: "persona-1",
  journeyRunId: "run-abcdef123456",
  journeyRefId: "goal-abcdef654321",
  startedAt: 1,
  lastActivityAt: 2,
  messageCount: 4,
  personaLabel: "Occasional Impulse Buyer",
  visitorDisplayName: "Occasional Impulse Buyer",
  synthetic: true,
};

const overview = {
  runs: [
    {
      runId: "run-abcdef123456",
      journeyRefId: "goal-abcdef654321",
      journeyName: "Buy a wireless patio speaker",
      journeyArchived: false,
      personaName: "Occasional Impulse Buyer",
      createdAt: 1,
      status: "completed",
      summary: { total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
      findings: [],
    },
  ],
  runsConsidered: 1,
  goalCompletion: {
    gradedCount: 0,
    passedCount: 0,
    passRate: null,
    runsWithGrades: 0,
    trend: [],
  },
};

let overviewResult: unknown = overview;

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (name === "journeyRuns:getSwarmOverview") return overviewResult;
    return undefined;
  },
  useMutation: () => vi.fn(),
  usePaginatedQuery: () => ({
    results: [session],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";

function renderPanel() {
  return render(
    <SwarmsSessionsPanel
      projectId="proj-1"
      personas={[{ _id: "persona-1", name: "Occasional Impulse Buyer" }]}
      personaRefId={null}
      onPersonaRefIdChange={() => {}}
    />,
  );
}

describe("SwarmsSessionsPanel group labels", () => {
  it("names a run group from the overview instead of its id suffix", () => {
    overviewResult = overview;
    renderPanel();

    expect(
      screen.getByText("Occasional Impulse Buyer · Buy a wireless patio speaker"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Run 123456/)).toBeNull();
  });

  it("falls back to the persona plus id when the overview has no name", () => {
    overviewResult = undefined;
    renderPanel();

    expect(
      screen.getByText("Occasional Impulse Buyer · Run 123456"),
    ).toBeInTheDocument();
  });
});
