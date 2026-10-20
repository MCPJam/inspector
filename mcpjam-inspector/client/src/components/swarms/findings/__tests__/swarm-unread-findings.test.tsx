import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwarmFindingsTab } from "../swarm-findings-tab";
import { groupRunsIntoSwarmWaves } from "../../swarm-overview-panel";
import {
  brokenWire,
  WIRE_PERSONA,
  WIRE_SECOND_GOAL,
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

function unreadWire(verdict: "passed" | "failed" | "notEstablished") {
  const disposition =
    verdict === "passed"
      ? "goalMet"
      : verdict === "failed"
        ? "goalMissed"
        : "notMeasured";
  const wire = brokenWire();
  wire.findings = wire.findings
    .filter((row) => row.basis === "sessionReport")
    .map((row) => ({
      ...row,
      basis: "populationFact",
      disposition,
      verdictSeen: verdict,
      tone:
        verdict === "passed" ? "ok" : verdict === "failed" ? "fail" : "muted",
      reportExcerpt: null,
      citations: [],
      chainStage: null,
      chainStageState: null,
      chainStageBasis: "unmeasured",
    }));
  wire.personas = wire.personas.map((persona) => ({ ...persona, disposition }));
  wire.summaryKind = verdict === "failed" ? "broken" : "unread";
  wire.population.read = 0;
  wire.population.unread = wire.population.started;
  wire.coverageNotes = ["partialRead"];
  return wire;
}

describe("unread swarm findings", () => {
  it("retains a scored persona when the published reader result is unavailable", () => {
    const view = render(<SwarmFindingsTab {...props} />);
    expect(
      screen.getByRole("tab", { name: /Ana.*Stalled/i }),
    ).toBeInTheDocument();
    const wire = unreadWire("failed");
    view.rerender(<SwarmFindingsTab {...props} journeyFindings={wire} />);
    expect(
      screen.getByRole("tab", { name: /Ana.*Stalled/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No session evidence available."),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("complementary")).getByText(
        "The grader recorded this goal as missed. No session report is available.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reconcile payouts/ }));
    expect(
      screen.getByRole("button", {
        name: /Reconcile payouts.*Stalled/i,
        expanded: true,
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("findings-goal-inspect")).toBeInTheDocument();
  });

  it.each([
    [
      "passed",
      "The grader recorded this goal as met. No session report is available.",
    ],
    ["notEstablished", "No session evidence available."],
  ] as const)(
    "shows the %s goal detail without inventing a report",
    (verdict, detail) => {
      render(
        <SwarmFindingsTab {...props} journeyFindings={unreadWire(verdict)} />,
      );
      expect(
        within(screen.getByRole("complementary")).getByText(detail),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: /Reconcile payouts/ }),
      );
      expect(
        screen.getByRole("button", {
          name:
            verdict === "passed"
              ? /Reconcile payouts.*Relieved/i
              : /Reconcile payouts.*Unscored/i,
          expanded: true,
        }),
      ).toBeInTheDocument();
    },
  );

  it("uses the session report when the mechanism has no prose", () => {
    const wire = brokenWire();
    wire.findings = wire.findings.map((row) =>
      row.basis === "verifiedMechanism"
        ? { ...row, mechanismPhrase: null, outcomePhrase: null }
        : row,
    );
    render(<SwarmFindingsTab {...props} journeyFindings={wire} />);
    expect(
      within(screen.getByRole("complementary")).getByText(
        "The change was rejected.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No session report is available/),
    ).not.toBeInTheDocument();
  });

  it("shows coverage notes when the wire result has no personas", () => {
    const wire = unreadWire("notEstablished");
    wire.personas = [];
    wire.findings = [];
    render(<SwarmFindingsTab {...props} journeyFindings={wire} />);
    expect(
      within(screen.getByTestId("findings-summary-card")).getByText(
        "Only part of this wave was read",
      ),
    ).toBeInTheDocument();
  });

  it.each([false, true])(
    "keeps mixed-goal persona detail consistent when reversed=%s",
    (reversed) => {
      const wire = unreadWire("failed");
      const passed = unreadWire("passed").findings.map((row) => ({
        ...row,
        id: "passed-" + row.id,
        goal: WIRE_SECOND_GOAL,
      }));
      const ids = [WIRE_SECOND_GOAL.runId, wire.findings[0]!.goal.runId];
      wire.personas = wire.personas.map((persona) => ({
        ...persona,
        goalRunIds: reversed ? [...ids].reverse() : ids,
      }));
      wire.findings = [...passed, ...wire.findings];
      if (reversed) wire.findings.reverse();
      render(<SwarmFindingsTab {...props} journeyFindings={wire} />);
      const aside = within(screen.getByRole("complementary"));
      expect(
        aside.getByText(
          "The grader recorded this goal as missed. No session report is available.",
        ),
      ).toBeInTheDocument();
      expect(
        aside.queryByText(/recorded this goal as met/),
      ).not.toBeInTheDocument();
    },
  );

  it("picks the same report observation in either wire order", () => {
    const wire = brokenWire();
    wire.findings = wire.findings.map((row) => ({
      ...row,
      mechanismPhrase: null,
      outcomePhrase: null,
    }));
    const report = wire.findings.find((row) => row.basis === "sessionReport")!;
    wire.findings.push({
      ...report,
      id: "a-empty-report",
      reportExcerpt: null,
    });
    wire.findings.push({
      ...report,
      id: "z-report",
      reportExcerpt: { actual: "Another session observation.", citations: [] },
    });
    const view = render(<SwarmFindingsTab {...props} journeyFindings={wire} />);
    expect(
      within(screen.getByRole("complementary")).getByText(
        "The change was rejected.",
      ),
    ).toBeInTheDocument();
    view.rerender(
      <SwarmFindingsTab
        {...props}
        journeyFindings={{ ...wire, findings: [...wire.findings].reverse() }}
      />,
    );
    expect(
      within(screen.getByRole("complementary")).getByText(
        "The change was rejected.",
      ),
    ).toBeInTheDocument();
  });

  it.each(["", "  "])(
    "keeps blank report text from emptying the persona detail: %j",
    (actual) => {
      const wire = brokenWire();
      wire.findings = wire.findings.map((row) => ({
        ...row,
        mechanismPhrase: "  ",
        outcomePhrase: "  ",
        reportExcerpt:
          row.basis === "sessionReport" ? { actual, citations: [] } : null,
      }));
      render(<SwarmFindingsTab {...props} journeyFindings={wire} />);
      expect(
        within(screen.getByRole("complementary")).getByText(
          "No session evidence available.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/No session report is available/),
      ).not.toBeInTheDocument();
    },
  );

  it("shows repeated coverage caveats only once", () => {
    const wire = brokenWire();
    wire.coverageNotes = ["budgetExhausted", "partialRead", "partialRead"];
    render(<SwarmFindingsTab {...props} journeyFindings={wire} />);
    const summary = within(screen.getByTestId("findings-summary-card"));
    expect(summary.getByText("Analysis budget exhausted")).toBeInTheDocument();
    expect(
      summary.getAllByText("Only part of this wave was read"),
    ).toHaveLength(1);
  });
});
