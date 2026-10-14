import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwarmFindingsTab } from "../swarm-findings-tab";
import { groupRunsIntoSwarmWaves } from "../../swarm-overview-panel";
import {
  brokenWire,
  WIRE_PERSONA,
} from "../../__tests__/swarm-findings-wire-fixtures";
import type { SwarmOverviewRun } from "@/lib/swarm-api";

vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: () => undefined,
}));

const run: SwarmOverviewRun = {
  runId: "run-1",
  journeyRefId: "journey-1",
  journeyName: "Save changes",
  journeyArchived: false,
  personaName: WIRE_PERSONA.name,
  createdAt: 1,
  swarmRunGroupId: "wave-1",
  status: "failed",
  summary: { total: 4, succeeded: 4, failed: 0, rateLimited: 0 },
  findings: [],
  goalScoreSummary: { gradedCount: 4, passedCount: 1, avgScore: 0.2 },
};
const props = {
  wave: groupRunsIntoSwarmWaves([run])[0]!,
  waveSignals: null,
  personas: [],
};

describe("unread swarm findings", () => {
  it("retains a scored persona when the published reader result is unavailable", () => {
    const view = render(<SwarmFindingsTab {...props} />);
    expect(
      screen.getByRole("tab", { name: /Ana.*Stalled/i }),
    ).toBeInTheDocument();
    const wire = brokenWire();
    wire.findings = wire.findings
      .filter((row) => row.basis === "sessionReport")
      .map((row) => ({
        ...row,
        basis: "populationFact",
        disposition: "goalMissed",
        reportExcerpt: null,
        citations: [],
        chainStage: null,
        chainStageState: null,
      }));
    wire.personas = wire.personas.map((persona) => ({
      ...persona,
      disposition: "goalMissed",
    }));
    view.rerender(<SwarmFindingsTab {...props} journeyFindings={wire} />);
    expect(
      screen.getByRole("tab", { name: /Ana.*Stalled/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No session evidence available."),
    ).not.toBeInTheDocument();
  });

  it("shows unread coverage caveats alongside the recorded findings", () => {
    const wire = brokenWire();
    wire.coverageNotes = ["budgetExhausted", "partialRead"];
    render(<SwarmFindingsTab {...props} journeyFindings={wire} />);
    const summary = within(screen.getByTestId("findings-summary-card"));
    expect(summary.getByText("Analysis budget exhausted")).toBeInTheDocument();
    expect(
      summary.getByText("Only part of this wave was read"),
    ).toBeInTheDocument();
  });
});
