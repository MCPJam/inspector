/**
 * The Scores list on the same trial page is a second channel for the
 * judge's number. With review on, that channel stays closed until the
 * reviewer labels (or reveals). Without review, the page is unchanged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  buildEvaluationConfigSnapshot,
  finalizeScoreResult,
  resolveScoreDefinition,
} from "@mcpjam/sdk/contract";
import type { ScoreDefinition } from "@mcpjam/sdk/contract";
import { IterationDetails } from "../iteration-details";
import type { EvalCase, EvalIteration } from "../types";

const { mockGetBlob } = vi.hoisted(() => ({
  mockGetBlob: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useAction: () => mockGetBlob,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <div data-testid="json-editor" />,
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(),
}));

vi.mock("../trial-judge-review", () => ({
  TrialJudgeReviewPanel: (props: { iterationId: string }) => (
    <div
      data-testid="mock-trial-judge-review"
      data-iteration={props.iterationId}
    />
  ),
}));

vi.mock("../trace-viewer", () => ({
  TraceViewer: () => <div data-testid="mock-trace-viewer" />,
}));

const CHECK: ScoreDefinition = {
  scorerId: "refund-mentioned",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-refund",
  label: "refund is mentioned",
  deterministic: true,
  passThreshold: 1,
  role: "gating",
};

const JUDGE: ScoreDefinition = {
  scorerId: "judge:goalCompletion",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-judge",
  label: "goal completion",
  deterministic: false,
  passThreshold: 0.8,
  role: "advisory",
};

const snapshot = buildEvaluationConfigSnapshot([CHECK, JUDGE]);
const check = resolveScoreDefinition(CHECK);
const judge = resolveScoreDefinition(JUDGE);

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "eval-read-me",
  query: "read me",
  models: [{ model: "gpt-4o-mini", provider: "openai" }],
  runs: 1,
  expectedToolCalls: [],
};

const scoredIteration: EvalIteration = {
  _id: "iter-1",
  testCaseId: "case-1",
  suiteRunId: "run-1",
  createdBy: "user-1",
  createdAt: 0,
  iterationNumber: 1,
  updatedAt: 0,
  status: "completed",
  result: "passed",
  actualToolCalls: [],
  tokensUsed: 0,
  metadata: {
    scores: [
      finalizeScoreResult(check, { kind: "scored", value: 1 }),
      finalizeScoreResult(judge, {
        kind: "scored",
        value: 0.42,
        rationale: "The answer never named the file.",
      }),
    ],
    evaluationConfig: snapshot,
  },
};

const judgeCase = {
  caseKey: "case-1",
  gradingKey: "case-1#1",
  iterationId: "iter-1",
  score: 0.42,
  passed: false,
  reason: "The answer never named the file.",
  rubricHits: [],
};

describe("IterationDetails blind scores", () => {
  beforeEach(() => {
    mockGetBlob.mockReset();
  });

  it("hides the judge value when review is on", () => {
    render(
      <IterationDetails
        iteration={scoredIteration}
        testCase={testCase}
        enableJudgeReview
        judgeCase={judgeCase}
        layoutMode="full"
      />,
    );
    const region = screen.getByTestId("iteration-scores-section");
    expect(screen.getByTestId("score-row-hidden").textContent).toBe(
      "Judge score hidden until you label this trial",
    );
    expect(region.textContent).not.toContain("0.42");
    expect(region.textContent).not.toContain("The answer never named the file.");
    expect(screen.getByText("refund is mentioned")).toBeTruthy();
  });

  it("is byte-identical without review — the judge value stays on the page", () => {
    const first = render(
      <IterationDetails iteration={scoredIteration} testCase={testCase} />,
    );
    const before = first.container.innerHTML;
    expect(screen.queryByTestId("score-row-hidden")).toBeNull();
    expect(screen.getByText("0.42 / 0.8")).toBeTruthy();
    first.unmount();

    const second = render(
      <IterationDetails iteration={scoredIteration} testCase={testCase} />,
    );
    expect(second.container.innerHTML).toBe(before);
  });
});
