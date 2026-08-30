/**
 * The run-detail decision-summary container.
 *
 * Three gates, and each one is a request that must not happen:
 *
 *   - **The flag.** Off is off: nothing subscribes and nothing is read.
 *   - **A project id in hand.** The browser threads one down from
 *     `EvaluateTab` or does not read at all. Resolving one here — or inferring
 *     it from a run id — is how a run gets read against the wrong project.
 *   - **A terminal run.** A pending or running run has decided nothing, and
 *     asking anyway spends a request per poll to be told so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/apis/eval-run-decision-summary-api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/apis/eval-run-decision-summary-api")
    >();
  return { ...actual, fetchEvalRunDecisionSummary: fetchMock };
});

import { RunDecisionSummarySection } from "../run-decision-summary-section";
import {
  evalDecisionSummaryStore,
  evalRunDecisionRevision,
} from "@/lib/evals/eval-decision-summary-store";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import type { EvalSuiteRun } from "../types";

const FAILING = readDecisionSummaryFixture("measured-failure-at-every-stage");

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "failed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  evalDecisionSummaryStore.reset();
});

afterEach(cleanup);

describe("RunDecisionSummarySection", () => {
  it("renders the run's decision once it arrives", async () => {
    fetchMock.mockResolvedValue(FAILING);

    render(
      <RunDecisionSummarySection projectId="p1" run={makeRun()} enabled />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("run-decision-verdict")).toHaveTextContent(
        "Failed",
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders nothing and reads nothing when disabled", async () => {
    fetchMock.mockResolvedValue(FAILING);

    const { container } = render(
      <RunDecisionSummarySection
        projectId="p1"
        run={makeRun()}
        enabled={false}
      />,
    );
    await Promise.resolve();

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads nothing without a project id rather than resolving one", async () => {
    fetchMock.mockResolvedValue(FAILING);

    render(<RunDecisionSummarySection projectId={null} run={makeRun()} enabled />);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["pending", "running"] as const)(
    "reads nothing for a %s run",
    async (status) => {
      fetchMock.mockResolvedValue(FAILING);

      const { container } = render(
        <RunDecisionSummarySection
          projectId="p1"
          run={makeRun({ status, result: "pending" })}
          enabled
        />,
      );
      await Promise.resolve();

      expect(container).toBeEmptyDOMElement();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "failed", "cancelled", "timed_out"] as const)(
    "reads a %s run, which has stopped and may have decided",
    async (status) => {
      fetchMock.mockResolvedValue(FAILING);

      render(
        <RunDecisionSummarySection
          projectId="p1"
          run={makeRun({ _id: `run-${status}`, status })}
          enabled
        />,
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    },
  );
});

describe("evalRunDecisionRevision", () => {
  it("changes when an advisory judge lands after the run finished", () => {
    const before = evalRunDecisionRevision(makeRun());
    const after = evalRunDecisionRevision(
      // A terminal run's summary is NOT frozen: judge fanout is asynchronous
      // and can change what the run decided minutes after it stopped.
      makeRun({ goalCompletionStatus: "completed" }),
    );

    expect(after).not.toBe(before);
  });

  it("changes when a v2 decision becomes readable", () => {
    expect(
      evalRunDecisionRevision(
        makeRun({ verdictPolicyVersion: 2, verdictSummary: undefined }),
      ),
    ).not.toBe(
      evalRunDecisionRevision(
        makeRun({
          verdictPolicyVersion: 2,
          verdictSummary: {} as EvalSuiteRun["verdictSummary"],
        }),
      ),
    );
  });

  it("is stable for an unchanged row", () => {
    expect(evalRunDecisionRevision(makeRun())).toBe(
      evalRunDecisionRevision(makeRun()),
    );
  });
});
