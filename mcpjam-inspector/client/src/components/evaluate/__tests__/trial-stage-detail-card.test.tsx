/**
 * The per-trial "what happened" card.
 *
 * The assertions guard the two things that would mislead a reader most: a wire
 * spelling reaching the screen in place of a sentence, and a statistic being
 * manufactured out of one observation.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
  type StageResultRow,
} from "@mcpjam/sdk/contract";
import { TrialStageDetailCard } from "../trial-stage-detail-card";

afterEach(cleanup);

function row(overrides: Partial<StageResultRow> = {}): StageResultRow {
  return { stage: "response", state: "failed", ...overrides } as StageResultRow;
}

describe("TrialStageDetailCard", () => {
  it("asks the stage's own question and answers it in words", () => {
    render(<TrialStageDetailCard row={row({ reason: "toolError" })} />);

    const card = screen.getByTestId("trial-stage-detail-card");
    expect(card).toHaveTextContent(USER_VALUE_STAGE_QUESTIONS.response);
    expect(screen.getByTestId("trial-stage-state")).toHaveTextContent(
      STAGE_STATE_LABELS.failed,
    );
    expect(screen.getByTestId("trial-stage-reason")).toHaveTextContent(
      STAGE_REASON_LABELS.toolError,
    );
    // The wire spelling rides as an attribute, never as prose.
    expect(screen.getByTestId("trial-stage-reason")).toHaveAttribute(
      "data-reason",
      "toolError",
    );
    expect(card.textContent).not.toContain("toolError");
  });

  it("omits the reason line when the row recorded none", () => {
    render(<TrialStageDetailCard row={row({ state: "notReached" })} />);
    expect(screen.queryByTestId("trial-stage-reason")).toBeNull();
    expect(screen.getByTestId("trial-stage-state")).toHaveTextContent(
      STAGE_STATE_LABELS.notReached,
    );
  });

  it("NEVER manufactures a rate from one observation", () => {
    const card = render(
      <TrialStageDetailCard row={row({ state: "passed" })} />,
    ).container;
    // "100% (1/1)" over a single row is a statistic invented from one trial.
    expect(card.textContent).not.toMatch(/%/);
    expect(card.textContent).not.toMatch(/\b1\s*\/\s*1\b/);
  });

  it("renders this row's own evidence, and only this row's", () => {
    render(
      <TrialStageDetailCard
        row={row({
          evidence: {
            spanIds: ["tool-call_abc"],
            promptIndexes: [2],
            predicateReasons: ["expected a non-empty result"],
          },
        })}
      />,
    );

    const card = screen.getByTestId("trial-stage-detail-card");
    expect(card).toHaveTextContent("span ids tool-call_abc");
    expect(card).toHaveTextContent("prompt indexes 2");
    expect(
      screen.getByTestId("trial-stage-predicate-reasons"),
    ).toHaveTextContent("expected a non-empty result");
  });

  it("shows a next action only when the caller supplies one", () => {
    const { rerender } = render(<TrialStageDetailCard row={row()} />);
    expect(screen.queryByTestId("trial-stage-next-action")).toBeNull();

    rerender(
      <TrialStageDetailCard
        row={row()}
        nextAction="inspect the tool response returned by the server"
      />,
    );
    expect(screen.getByTestId("trial-stage-next-action")).toHaveTextContent(
      "inspect the tool response returned by the server",
    );
  });

  it("degrades on a state this build has no word for", () => {
    render(
      <TrialStageDetailCard
        row={row({ state: "judgeDeferred" as StageResultRow["state"] })}
      />,
    );
    expect(screen.getByTestId("trial-stage-state")).toHaveTextContent(
      "state not recognized",
    );
  });
});
