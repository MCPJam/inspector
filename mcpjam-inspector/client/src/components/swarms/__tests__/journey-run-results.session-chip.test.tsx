import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { deriveSwarmSessionVerdict } from "@mcpjam/sdk/contract";
import type {
  SwarmSessionVerdict,
  SwarmSessionVerdictInput,
} from "@mcpjam/sdk/contract";
import {
  SwarmHostCell,
  SwarmSessionsMatrix,
  type SwarmMatrixCellOutcome,
} from "../journey-run-results";
import {
  reduceSwarmStreamEvent,
  type JourneyRunStreamState,
} from "../use-journey-run-stream";
import type { SwarmStreamEvent } from "@/shared/swarm-stream-events";

vi.mock("convex/react", () => ({
  useQuery: () => null,
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

function cell(
  verdict: SwarmSessionVerdict | undefined,
  outcome: SwarmMatrixCellOutcome = "succeeded",
  hasTranscript = false,
) {
  render(
    <SwarmHostCell
      hostLabel="Claude"
      sessionIndex={0}
      outcome={outcome}
      verdict={verdict}
      hasTranscript={hasTranscript}
      selected={false}
      onSelect={() => {}}
    />,
  );
  return screen.getByTestId("swarm-host-cell");
}

/** A goal with no rubric: the judge decides alone, so `counts.gating` is 0. */
const unrubricked = {
  hasTranscript: true,
  rubric: [],
  criteria: null,
  judge: { automatic: true, role: "required" },
  grading: { state: "settled" },
} as const satisfies Partial<SwarmSessionVerdictInput>;

describe("SwarmHostCell status", () => {
  it("says the goal passed", () => {
    const el = cell(
      deriveSwarmSessionVerdict({
        ...unrubricked,
        attempt: { status: "succeeded" },
        goalScore: { status: "completed", passed: true },
      }),
    );
    expect(el).toHaveTextContent("Goal passed");
    expect(el).not.toHaveTextContent("Ran");
  });

  it("says the goal failed on a session that broke after the judge failed it", () => {
    const verdict = deriveSwarmSessionVerdict({
      ...unrubricked,
      attempt: { status: "failed" },
      goalScore: { status: "completed", passed: false },
    });
    expect(verdict.lifecycle).toBe("broke");
    const el = cell(verdict, "failed");
    expect(el).toHaveTextContent("Goal failed");
    expect(el).not.toHaveTextContent("Broke");
  });

  it.each([
    ["broke", { status: "failed" }],
    ["limited", { status: "rate_limited" }],
    ["withdrawn", { status: "failed", errorCode: "canceled" }],
  ] as const)("says a %s session did not run", (lifecycle, attempt) => {
    const verdict = deriveSwarmSessionVerdict({
      ...unrubricked,
      hasTranscript: false,
      attempt,
      goalScore: null,
    });
    expect(verdict.lifecycle).toBe(lifecycle);
    expect(cell(verdict, "failed")).toHaveTextContent("Did not run");
  });

  it("does not say a session withdrawn mid-conversation did not run", () => {
    const verdict = deriveSwarmSessionVerdict({
      ...unrubricked,
      attempt: { status: "failed", errorCode: "canceled" },
      goalScore: null,
    });
    expect(verdict.lifecycle).toBe("withdrawn");
    const el = cell(verdict, "failed", true);
    expect(el).toHaveTextContent("Not established");
    expect(el).not.toHaveTextContent("Did not run");
  });

  it("does not say a session that broke partway through did not run", () => {
    const grading = deriveSwarmSessionVerdict({
      ...unrubricked,
      attempt: { status: "failed" },
      goalScore: null,
      grading: { state: "queued" },
    });
    expect(grading.lifecycle).toBe("broke");
    expect(cell(grading, "failed")).toHaveTextContent("Grading");
  });

  it("gives an ungraded session that broke partway through a neutral label", () => {
    const el = cell(
      deriveSwarmSessionVerdict({
        ...unrubricked,
        attempt: { status: "failed" },
        goalScore: null,
        judge: { automatic: false, role: "required" },
      }),
      "failed",
    );
    expect(el).toHaveTextContent("Not graded");
    expect(el).not.toHaveTextContent("Did not run");
  });

  it("says a session is being graded rather than claiming a result", () => {
    const el = cell(
      deriveSwarmSessionVerdict({
        ...unrubricked,
        attempt: { status: "succeeded" },
        goalScore: { status: "running" },
        grading: { state: "running" },
      }),
    );
    expect(el).toHaveTextContent("Grading");
    expect(el).not.toHaveTextContent(/Goal (passed|failed)/);
  });

  it("falls back to the execution outcome without a verdict", () => {
    expect(cell(undefined, "rate_limited")).toHaveTextContent("Did not run");
  });

  it("says a verdictless session that broke with no transcript did not run", () => {
    expect(cell(undefined, "failed")).toHaveTextContent("Did not run");
  });

  it.each(["failed", "rate_limited"] as const)(
    "does not say a verdictless %s session with a transcript did not run",
    (outcome) => {
      const el = cell(undefined, outcome, true);
      expect(el).toHaveTextContent("Broke");
      expect(el).not.toHaveTextContent("Did not run");
    },
  );
});

describe("SwarmSessionsMatrix transcript evidence", () => {
  it("counts streamed messages before Convex records them", () => {
    const event = (
      partial: Partial<SwarmStreamEvent> & Pick<SwarmStreamEvent, "type">,
    ) =>
      ({
        runId: "run_1",
        hostId: "host_a",
        chatSessionId: "synth_run_1_host_a_0",
        sessionIndex: 0,
        ...partial,
      }) as SwarmStreamEvent;
    const stream = [
      event({ type: "turn_start", turnIndex: 0, prompt: "draw a dog" }),
      event({ type: "text_delta", content: "Sure" }),
      event({ type: "attempt_status", status: "failed" }),
    ].reduce<JourneyRunStreamState>(reduceSwarmStreamEvent, {
      sessions: {},
      cellStatus: {},
      runComplete: false,
      connected: true,
      error: null,
    });

    render(
      <SwarmSessionsMatrix
        runId="run_1"
        targets={[
          {
            key: "host_a",
            hostId: "host_a",
            label: "Claude",
            identity: { hostId: "host_a" },
          },
        ]}
        sessionsPerTarget={1}
        sessions={[]}
        hostSummaries={[]}
        stream={stream}
        runStatus="running"
        selection={null}
        onSelect={() => {}}
      />,
    );

    const el = screen.getByTestId("swarm-host-cell");
    expect(el).toHaveAttribute("data-outcome", "failed");
    expect(el).toHaveTextContent("Broke");
    expect(el).not.toHaveTextContent("Did not run");
  });
});

describe("SwarmHostCell evaluator count", () => {
  const noFraction = (el: HTMLElement) => {
    expect(el).toHaveTextContent("Goal passed");
    expect(el).not.toHaveTextContent(/evaluators|\d+\/\d+/);
  };

  it("prints no fraction when the run pinned no rubric", () => {
    noFraction(
      cell(
        deriveSwarmSessionVerdict({
          ...unrubricked,
          attempt: { status: "succeeded" },
          goalScore: { status: "completed", passed: true },
        }),
      ),
    );
  });

  it("prints no fraction when required criteria were graded", () => {
    const verdict = deriveSwarmSessionVerdict({
      hasTranscript: true,
      attempt: { status: "succeeded" },
      rubric: [{ id: "c1", role: "required" }],
      criteria: {
        status: "completed",
        results: [{ criterionId: "c1", passed: true }],
      },
      goalScore: null,
      judge: { automatic: false, role: "advisory" },
      grading: { state: "settled" },
    });
    expect(verdict.counts.gating).toBe(1);
    noFraction(cell(verdict));
  });
});
