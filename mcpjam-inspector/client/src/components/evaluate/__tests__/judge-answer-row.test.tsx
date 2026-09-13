/**
 * The judge's answer, in every state a real trial can be in.
 *
 * The states carry as much weight as the answer. "Not run" on a quick-run
 * trial would let a reader conclude the judge is broken, when in fact a quick
 * run is not gradable at all — it has no `suiteRunId`, and every judge surface
 * is keyed by one. Each state below names its reason instead.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  JudgeAnswerRow,
  judgeAnswerState,
} from "../case-scorecard/judge-answer-row";

const scored = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    caseKey: "c",
    score: 0.82,
    passed: true,
    reason: "Stated the address.",
    rubricHits: [],
    status: "scored",
    ...over,
  }) as never;

const base = {
  isQuickRun: false,
  judgeEnabledOnSuite: true,
  skippedForCase: false,
  runJudgeStatus: undefined,
  judgeCase: null,
  threshold: 0.7,
  gating: false,
};

describe("judgeAnswerState", () => {
  it("reports a scored verdict", () => {
    expect(judgeAnswerState({ ...base, judgeCase: scored() }).kind).toBe(
      "scored",
    );
  });

  it("says a quick run is not gradable rather than 'not run'", () => {
    expect(judgeAnswerState({ ...base, isQuickRun: true }).kind).toBe(
      "quickRun",
    );
  });

  it("reports the suite's judge being off before anything else", () => {
    expect(judgeAnswerState({ ...base, judgeEnabledOnSuite: false }).kind).toBe(
      "suiteOff",
    );
  });

  it("reports a per-case skip ahead of the suite setting", () => {
    // The case opted out; saying "off for this suite" would send the reader to
    // the wrong control.
    expect(
      judgeAnswerState({
        ...base,
        skippedForCase: true,
        judgeEnabledOnSuite: false,
      }).kind,
    ).toBe("skipped");
  });

  it("shows judging while the run's request is in flight", () => {
    expect(judgeAnswerState({ ...base, runJudgeStatus: "pending" }).kind).toBe(
      "judging",
    );
  });

  it("shows a failure when the run's judge failed", () => {
    expect(judgeAnswerState({ ...base, runJudgeStatus: "failed" }).kind).toBe(
      "failed",
    );
  });

  it("prefers a verdict that exists over the run's status", () => {
    expect(
      judgeAnswerState({
        ...base,
        runJudgeStatus: "pending",
        judgeCase: scored(),
      }).kind,
    ).toBe("scored");
  });

  it("falls back to 'not run' with no verdict and no status", () => {
    expect(judgeAnswerState(base).kind).toBe("notRun");
  });
});

describe("JudgeAnswerRow", () => {
  it("answers in a word, with the score and the threshold", () => {
    render(
      <JudgeAnswerRow
        state={{
          kind: "scored",
          judgeCase: scored(),
          threshold: 0.7,
          gating: false,
        }}
      />,
    );
    expect(screen.getByText("Did it accomplish the goal?")).toBeTruthy();
    expect(screen.getByTestId("judge-answer-word").textContent).toBe("Yes");
    expect(screen.getByText("0.82 ≥ 0.70")).toBeTruthy();
  });

  it("says an advisory verdict does not change the result", () => {
    render(
      <JudgeAnswerRow
        state={{
          kind: "scored",
          judgeCase: scored(),
          threshold: 0.7,
          gating: false,
        }}
      />,
    );
    expect(
      screen.getByText("Advisory — does not change the result"),
    ).toBeTruthy();
  });

  it("says Gate when the suite earned one", () => {
    render(
      <JudgeAnswerRow
        state={{
          kind: "scored",
          judgeCase: scored(),
          threshold: 0.7,
          gating: true,
        }}
      />,
    );
    expect(screen.getByText("Gate")).toBeTruthy();
  });

  it("distinguishes a near miss from a flat no", () => {
    const partly = {
      kind: "scored" as const,
      judgeCase: scored({ score: 0.55, passed: false }),
      threshold: 0.7,
      gating: false,
    };
    const { unmount } = render(<JudgeAnswerRow state={partly} />);
    expect(screen.getByTestId("judge-answer-word").textContent).toBe("Partly");
    unmount();
    render(
      <JudgeAnswerRow
        state={{
          ...partly,
          judgeCase: scored({ score: 0.1, passed: false }),
        }}
      />,
    );
    expect(screen.getByTestId("judge-answer-word").textContent).toBe("No");
  });

  it("offers a retry when the judge could not grade the trial", async () => {
    const onRetry = vi.fn();
    render(<JudgeAnswerRow state={{ kind: "failed" }} onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("treats an errored verdict as ungraded, not as a low score", () => {
    render(
      <JudgeAnswerRow
        state={{
          kind: "scored",
          judgeCase: scored({ status: "error", score: 0, passed: false }),
          threshold: 0.7,
          gating: false,
        }}
      />,
    );
    // A score the judge did not produce from evidence is a non-answer.
    expect(screen.queryByTestId("judge-answer-word")).toBeNull();
    expect(
      screen.getByText("The judge could not grade this iteration"),
    ).toBeTruthy();
  });

  it("points a quick-run trial at the control that works", () => {
    render(<JudgeAnswerRow state={{ kind: "quickRun" }} />);
    expect(
      screen.getByText("Quick runs are not graded — use Run test"),
    ).toBeTruthy();
  });

  it("links to suite settings when the judge is off", async () => {
    const onOpenSuiteSettings = vi.fn();
    render(
      <JudgeAnswerRow
        state={{ kind: "suiteOff" }}
        onOpenSuiteSettings={onOpenSuiteSettings}
      />,
    );
    await userEvent.setup().click(screen.getByText("Edit in suite settings"));
    expect(onOpenSuiteSettings).toHaveBeenCalled();
  });
});

describe("blind review", () => {
  it("withholds the verdict while a label is being taken", () => {
    // A label recorded as `blind: true` beside a visible score is not
    // calibration data, and calibration gates other people's builds.
    expect(
      judgeAnswerState({ ...base, hidden: true, judgeCase: scored() }).kind,
    ).toBe("withheld");
  });

  it("withholds ahead of every other state, including a skip", () => {
    expect(
      judgeAnswerState({
        ...base,
        hidden: true,
        skippedForCase: true,
        judgeEnabledOnSuite: false,
      }).kind,
    ).toBe("withheld");
  });

  it("prints no score when withheld", () => {
    render(<JudgeAnswerRow state={{ kind: "withheld" }} />);
    expect(screen.queryByTestId("judge-answer-word")).toBeNull();
    expect(screen.getByText("Hidden until you label this iteration")).toBeTruthy();
  });

  it("still hosts the review control, which is the point", () => {
    render(
      <JudgeAnswerRow state={{ kind: "withheld" }}>
        <button>Label this iteration</button>
      </JudgeAnswerRow>,
    );
    expect(screen.getByText("Label this iteration")).toBeTruthy();
  });
});
