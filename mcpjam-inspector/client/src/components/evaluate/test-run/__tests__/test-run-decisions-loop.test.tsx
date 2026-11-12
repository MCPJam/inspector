import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EvalRunDecisionDiagnostic } from "@mcpjam/sdk/contract";
import type { TestRunData } from "../use-test-run-data";
import { TestRunPage } from "../test-run-page";
import {
  CASE_ID,
  ITERATIONS,
  MATRIX,
  RUN_A,
  RUN_B,
  SUITE,
  TEST_CASE,
  fixtureRun,
} from "./test-run-fixtures";

const RUN_C = fixtureRun("run-c", {
  runNumber: 6,
  effectiveModelId: "google/gemini-2.5-flash",
});

// Stable store objects, handed out in a NEW array on every render, as the
// real decision read does.
const mocks = vi.hoisted(() => ({
  items: [
    { iterationId: "a1", chain: { status: "absent" } },
    { iterationId: "a2", chain: { status: "absent" } },
  ],
  chains: new Map(),
  reads: 0,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  useEvalRunDecisionDetail: () => {
    // A loop would otherwise hang the run rather than fail it.
    mocks.reads += 1;
    if (mocks.reads > 300)
      throw new Error("render loop: decision read 300 times");
    return {
      status: "ready",
      summary: null,
      diagnostics: [...mocks.items] as EvalRunDecisionDiagnostic[],
    };
  },
}));
vi.mock("@/hooks/use-eval-run-iteration-chains", () => ({
  useEvalRunIterationChains: () => ({ status: "ready", chains: mocks.chains }),
}));
const data: TestRunData = {
  status: "ready",
  suite: SUITE,
  run: RUN_A,
  launchRuns: [RUN_A, RUN_B, RUN_C],
  iterations: ITERATIONS,
  source: "case",
  truncated: false,
  testCase: TEST_CASE,
  title: TEST_CASE.title,
  matrix: MATRIX,
};
vi.mock("../use-test-run-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../use-test-run-data")>()),
  useTestRunData: () => data,
}));
vi.mock("@/components/evaluate/evals-header", () => ({
  EvalCrumbBar: () => null,
}));

describe("TestRunPage with three launch runs", () => {
  it("settles after the decision reads report, instead of re-rendering forever", async () => {
    let commits = 0;
    render(
      <Profiler id="test-run" onRender={() => (commits += 1)}>
        <TestRunPage
          route={{
            type: "test-run",
            suiteId: "suite-excalidraw",
            runId: "run-a",
            testCaseId: CASE_ID,
          }}
          projectId="proj00000000000001"
        />
      </Profiler>,
    );
    expect(screen.getByTestId("nav-test-run")).toBeInTheDocument();
    const settled = commits;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commits).toBe(settled);
    expect(commits).toBeLessThanOrEqual(6);
    expect(mocks.reads).toBeLessThanOrEqual(30);
  });
});
