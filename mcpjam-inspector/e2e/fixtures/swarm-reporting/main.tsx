import evalFixtures from "../../../../sdk/tests/fixtures/eval-verdict-policy-parity-fixtures.json";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import {
  assembleSwarmReport,
  deriveSwarmSessionVerdict,
  evalVerdictDecisionSchema,
  deriveStageResults,
  buildChatSessionStageInput,
  STAGE_ANALYZER_VERSION,
} from "@mcpjam/sdk/contract";
import {
  SwarmGoalResult,
  SwarmReportPanel,
} from "../../../client/src/components/swarms/swarm-report-panel";
import { SessionUserValueChain } from "../../../client/src/components/shared/user-value-chain/SessionUserValueChain";
import { StageFunnel } from "../../../client/src/components/shared/user-value-chain/StageFunnel";
import "../../../client/src/index.css";
const scenarios = [
  "Goal passed after interruption",
  "Goal failed",
  "Grading",
  "Could not grade",
  "Not graded",
  "Recovered tool error",
] as const;
function App() {
  const [selected, select] = useState<string>(scenarios[0]);
  const waiting = selected === "Grading",
    unavailable = selected === "Could not grade",
    ungraded = selected === "Not graded";
  const failed = selected === "Goal failed",
    broke = selected === scenarios[0],
    friction = selected === "Recovered tool error";
  const verdict = deriveSwarmSessionVerdict({
    attempt: { status: broke ? "failed" : "succeeded" },
    hasTranscript: true,
    rubric: [],
    criteria: null,
    goalScore:
      waiting || unavailable || ungraded
        ? null
        : { status: "completed", passed: !failed },
    judge: { automatic: !ungraded, role: "advisory" },
    grading: {
      state: waiting
        ? "queued"
        : unavailable
          ? "unavailable"
          : ungraded
            ? "notRequested"
            : "settled",
    },
  });
  const summary = waiting
    ? { status: "pending" as const, pendingSessions: 1, updatedAt: 1 }
    : ungraded
      ? {
          status: "notEstablished" as const,
          reason: "gradingNotConfigured" as const,
          updatedAt: 1,
        }
      : {
          status: "decided" as const,
          updatedAt: 1,
          decision: evalVerdictDecisionSchema.parse(
            JSON.parse(
              JSON.stringify(
                evalFixtures.accept.find(
                  (row) =>
                    row.__kind === "decision" &&
                    row.__label ===
                      (broke || unavailable
                        ? "no gradeable trials at all — inconclusive, never failed"
                        : failed
                          ? "all fail at threshold 0.5 — failed, not inconclusive"
                          : "repetitions 1 — the low boundary of the portable range, single passing trial"),
                ),
                (key, value) => (key.startsWith("__") ? undefined : value),
              ),
            ),
          ),
        };
  const check = {
    evaluatorId: "standard:noToolErrors",
    predicateType: "noToolErrors" as const,
    role: "advisory" as const,
  };
  const report = assembleSwarmReport({
    runId: "fixture-run",
    configuredSessions: 1,
    executionComplete: true,
    verdictSummary: summary,
    evaluatorDefinitions: [check],
    sessions: [
      {
        id: "fixture-session",
        startEvidence: "started",
        verdict,
        observations: [
          { ...check, status: friction ? "failed" : "unavailable" },
        ],
      },
    ],
  });
  const derived = deriveStageResults(
    buildChatSessionStageInput({
      source: "swarm",
      hasUserAsk: true,
      lifecycle: "settled",
      swarmPolicy: { judgeDecisive: true, requiredCriteria: 0 },
      goalJudge: { status: "completed", passed: !failed },
    }),
  );
  const derivation =
    waiting || unavailable || ungraded
      ? null
      : {
          status: "completed" as const,
          source: "swarm" as const,
          generation: 1,
          attempts: 1,
          requestedAt: 1,
          stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
          ...derived,
        };
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-4xl space-y-4 bg-background p-6 text-foreground">
        <h1 className="text-xl font-semibold">Swarm reporting verification</h1>
        <nav className="flex flex-wrap gap-2">
          {scenarios.map((s) => (
            <button
              className="rounded border border-border px-3 py-2 text-sm"
              key={s}
              onClick={() => select(s)}
            >
              {s}
            </button>
          ))}
        </nav>
        <SwarmReportPanel report={report} />
        <section className="space-y-3 rounded border border-border p-4">
          <h2 className="font-medium">Selected session</h2>
          <p>Execution: {broke ? "Broke" : "Ran"}</p>
          <SwarmGoalResult verdict={verdict} />
          <SessionUserValueChain derivation={derivation} />
        </section>
        <StageFunnel
          title="Partial coverage"
          populationLabel="Sessions in this swarm run"
          summary={{
            source: "swarm",
            total: 10,
            counted: 1,
            exclusions: { absent: 9, stale: 0, deriving: 0, failed: 0 },
            stages: derived.stageResults.map((r) => ({
              stage: r.stage,
              passed: r.state === "passed" ? 1 : 0,
              failed: r.state === "failed" ? 1 : 0,
              eligible: ["passed", "failed"].includes(r.state) ? 1 : 0,
              notMeasured: r.state === "notMeasured" ? 1 : 0,
              notApplicable: 0,
              notReached: 0,
              observations: 0,
              passRate:
                r.state === "passed" ? 1 : r.state === "failed" ? 0 : null,
            })),
            firstFailedStage: {},
            notMeasured: false,
            truncated: false,
          }}
        />
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
