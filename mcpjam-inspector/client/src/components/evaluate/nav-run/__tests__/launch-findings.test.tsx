/**
 * All models on a three-run launch, as on real data: every run has rule-based
 * findings built and AI analysis was never run. Runs through the real
 * useUnifiedFindings hook, so "built" is decided the way the page decides it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test";
import type {
  ActionableFinding,
  InsightsEnvelope,
} from "@/lib/insights-envelope-api";
import type { EvalIteration } from "../../../evals/types";
import { LaunchFindings } from "../launch-findings";

vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  useMutation: () => vi.fn(async () => ({ jobId: "job" })),
}));

const envelopes = vi.hoisted(() => {
  const state: { byRun: Map<string, unknown> } = { byRun: new Map() };
  return state;
});
vi.mock(
  "@/components/shared/actionable-insights/use-insights-envelope",
  () => ({
    useInsightsEnvelope: ({ suiteRunId }: { suiteRunId: string }) =>
      envelopes.byRun.get(suiteRunId),
  }),
);

function selectionFinding(runId: string, failed: number): ActionableFinding {
  return {
    id: `rf_${runId}`,
    signalFingerprint: `sha256:${runId}`,
    title: "Selection",
    category: "agent_behavior",
    attribution: "unknown",
    actionTarget: "investigate",
    actionability: "investigate",
    severity: "medium",
    confidence: "low",
    observed: `${failed} of 4 iterations broke at Selection: an expected tool call was never made.`,
    recommendation:
      "Open the exemplar sessions and identify the mechanism before changing anything.",
    acceptanceCriteria: [],
    affected: { count: failed, total: 4, unit: "iterations" },
    evidence: [
      { iterationId: `${runId}-fail`, kind: "transcript", excerpt: "…" },
    ],
  };
}

/** Rule-based findings built; the automatic AI analysis was skipped. */
function envelope(runId: string, failed: number): InsightsEnvelope {
  const finding = selectionFinding(runId, failed);
  return {
    schemaVersion: 1,
    scope: { kind: "eval_run", id: runId },
    status: "not_requested",
    reasonCode: null,
    retryable: false,
    error: null,
    generatedAt: null,
    updatedAt: null,
    summary: null,
    coverage: {
      unit: "iterations",
      analyzed: 4,
      total: 4,
      truncated: false,
      lowConfidence: false,
    },
    findings: [],
    observationState: "ready",
    unifiedFindings: {
      capability: "unified_findings_v1",
      snapshot: {
        builtAt: 1,
        sourceRevision: "rev",
        minerVersion: 1,
        omittedGroups: 0,
        deterministicFindings: [finding],
        provenance: [
          {
            candidateId: finding.id,
            groupKind: "stage_break",
            basis: "measured",
            mechanismBasis: "complete",
            affectedIterationIds: [`${runId}-fail`],
            stage: "selection",
            reason: "missingToolCall",
          },
        ],
        enrichment: null,
      },
      job: { kind: "enrich", status: "skipped", startedAt: 1, updatedAt: 1 },
      canBuild: true,
      canEnrich: true,
    },
    truncation: {
      truncated: false,
      omittedFindings: 0,
      omittedEvidence: 0,
      contractTruncated: false,
    },
  };
}

function iterations(runId: string): EvalIteration[] {
  return Array.from({ length: 4 }, (_, index) => ({
    _id: index === 0 ? `${runId}-fail` : `${runId}-${index}`,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    iterationNumber: index + 1,
    status: "completed",
    result: index === 0 ? "failed" : "passed",
    actualToolCalls: [],
    tokensUsed: 1,
    suiteRunId: runId,
    testCaseId: "case-1",
  }));
}

describe("LaunchFindings on a three-run launch", () => {
  it("merges every run's rule-based findings into the compact list", async () => {
    envelopes.byRun = new Map([
      ["sonnet", envelope("sonnet", 2)],
      ["gpt", envelope("gpt", 2)],
      ["opus", envelope("opus", 1)],
    ]);
    const onOpenIteration = vi.fn();
    renderWithProviders(
      <LaunchFindings
        runs={["sonnet", "gpt", "opus"].map((runId) => ({
          runId,
          iterations: iterations(runId),
        }))}
        scope="across 3 models"
        onOpenIteration={onOpenIteration}
        fallback={(runId) => <div data-testid="fallback-panel">{runId}</div>}
      />,
    );
    const findings = await screen.findByTestId("nav-findings");
    expect(screen.queryByTestId("fallback-panel")).toBeNull();
    expect(findings).toHaveTextContent("1 across 3 models");
    const [row] = within(findings).getAllByTestId("nav-finding");
    expect(row).toHaveTextContent(
      "5 of 12 iterations broke at Selection: an expected tool call was never made.",
    );
    await userEvent
      .setup()
      .click(within(row).getByRole("button", { name: "Open iteration" }));
    expect(onOpenIteration).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "sonnet-fail", suiteRunId: "sonnet" }),
    );
  });

  it("shows today's panel for the first run whose findings are not built", () => {
    envelopes.byRun = new Map<string, unknown>([
      ["sonnet", envelope("sonnet", 2)],
      ["opus", envelope("opus", 1)],
    ]);
    renderWithProviders(
      <LaunchFindings
        runs={["sonnet", "gpt", "opus"].map((runId) => ({
          runId,
          iterations: iterations(runId),
        }))}
        scope="across 3 models"
        fallback={(runId) => <div data-testid="fallback-panel">{runId}</div>}
      />,
    );
    expect(screen.getByTestId("fallback-panel")).toHaveTextContent("gpt");
    expect(screen.queryByTestId("nav-findings")).toBeNull();
  });
});
