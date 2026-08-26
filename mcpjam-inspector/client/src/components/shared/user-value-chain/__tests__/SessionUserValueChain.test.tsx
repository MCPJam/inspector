/**
 * The per-session chain panel.
 *
 * Every test here is one way the panel could quietly mislead, and the
 * assertion that stops it: absence rendered as nothing, the three non-verdicts
 * collapsed into one word, a stale chain shown as current, and the phrase
 * "root cause" appearing anywhere near a stage position.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionUserValueChain } from "../SessionUserValueChain";
import type {
  ChatSessionStageDerivation,
  StageResultRow,
} from "../user-value-chain-types";

const ROWS: StageResultRow[] = [
  { stage: "connection", state: "passed", reason: "observed" },
  { stage: "discovery", state: "passed", reason: "observed" },
  {
    stage: "selection",
    state: "notMeasured",
    reason: "matchVerdictUnavailable",
  },
  { stage: "call", state: "passed", reason: "observed" },
  { stage: "response", state: "passed", reason: "observed" },
  { stage: "userValue", state: "notMeasured", reason: "judgeNotRequested" },
];

function derivation(
  over: Partial<ChatSessionStageDerivation> = {}
): ChatSessionStageDerivation {
  return {
    status: "completed",
    generation: 1,
    source: "user_testing",
    requestedAt: 1,
    attempts: 1,
    stageResults: ROWS,
    stageAnalyzerVersion: 5,
    derivedAt: 2,
    ...over,
  };
}

describe("absence is rendered, not hidden", () => {
  it("says not measured when the session carries no chain", () => {
    render(<SessionUserValueChain derivation={null} />);
    expect(screen.getByText(/Not measured for this session/i)).toBeTruthy();
  });

  it("a worker that gave up is unmeasured, not a failure", () => {
    render(
      <SessionUserValueChain
        derivation={derivation({
          status: "failed",
          stageResults: undefined,
          errorCode: "attempts_exhausted",
        })}
      />
    );
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/could not be derived/i);
    expect(text).toMatch(/says anything about the server/i);
  });

  it("the panel never disappears", () => {
    const { container } = render(<SessionUserValueChain derivation={null} />);
    expect(container.querySelector("section")).toBeTruthy();
  });
});

describe("the six rows", () => {
  it("renders every stage in chain order", () => {
    const { container } = render(
      <SessionUserValueChain derivation={derivation()} />
    );
    const stages = [...container.querySelectorAll("[data-stage]")].map((el) =>
      el.getAttribute("data-stage")
    );
    expect(stages).toEqual([
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]);
  });

  it("uses the canonical labels, never the wire spelling", () => {
    const { container } = render(
      <SessionUserValueChain derivation={derivation()} />
    );
    const userValueRow = container.querySelector("[data-stage='userValue']");
    expect(userValueRow?.textContent).toContain("User value");
    expect(document.body.textContent).not.toContain("userValue");
  });

  it("keeps the three non-verdicts as three different sentences", () => {
    render(
      <SessionUserValueChain
        derivation={derivation({
          stageResults: [
            { stage: "connection", state: "passed" },
            { stage: "discovery", state: "notMeasured" },
            { stage: "selection", state: "notApplicable" },
            { stage: "call", state: "failed" },
            { stage: "response", state: "notReached" },
            { stage: "userValue", state: "notReached" },
          ],
          firstFailedStage: "call",
        })}
      />
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("not measured");
    expect(text).toContain("not applicable to this case");
    expect(text).toContain("never ran (an earlier stage failed)");
  });

  it("shows the reason a stage landed where it did", () => {
    render(<SessionUserValueChain derivation={derivation()} />);
    expect(document.body.textContent).toContain(
      "no judge verdict was ever owed"
    );
  });

  it("renders bounded evidence reasons when the row carries them", () => {
    render(
      <SessionUserValueChain
        derivation={derivation({
          stageResults: ROWS.map((row) =>
            row.stage === "userValue"
              ? {
                  ...row,
                  state: "failed" as const,
                  reason: "predicateFailed" as const,
                  evidence: { predicateReasons: ["the order was never found"] },
                }
              : row
          ),
          firstFailedStage: "userValue",
        })}
      />
    );
    expect(screen.getByText("the order was never found")).toBeTruthy();
  });
});

describe("where the chain stopped", () => {
  const failed = derivation({
    stageResults: ROWS.map((row) =>
      row.stage === "call"
        ? { ...row, state: "failed" as const, reason: "protocolError" as const }
        : row
    ),
    firstFailedStage: "call",
    failureCategory: "serverData",
  });

  it("names the position and its bucket", () => {
    render(<SessionUserValueChain derivation={failed} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("The chain stopped at");
    expect(text).toContain("Tool call");
    expect(text).toContain("server data");
  });

  it("never says root cause", () => {
    // A first failed stage is WHERE the chain stopped, not why. Phrasing that
    // suggests otherwise is how an operator fixes the wrong system.
    render(<SessionUserValueChain derivation={failed} />);
    expect((document.body.textContent ?? "").toLowerCase()).not.toContain(
      "root cause"
    );
  });

  it("reports an evaluator bucket with no failed stage honestly", () => {
    render(
      <SessionUserValueChain
        derivation={derivation({ failureCategory: "evaluator" })}
      />
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("No stage failed");
    expect(text).toContain("evaluator");
  });
});

describe("deriving and stale are visible", () => {
  it("a first derivation in flight says so and shows no rows", () => {
    const { container } = render(
      <SessionUserValueChain
        derivation={derivation({ status: "pending", stageResults: undefined })}
      />
    );
    expect(document.body.textContent).toContain("A chain is being derived");
    expect(container.querySelectorAll("[data-stage]")).toHaveLength(0);
  });

  it("a stale chain still shows its rows, labelled", () => {
    const { container } = render(
      <SessionUserValueChain derivation={derivation({ status: "pending" })} />
    );
    // Blanking would empty the panel on every re-grade.
    expect(container.querySelectorAll("[data-stage]")).toHaveLength(6);
    expect(document.body.textContent).toMatch(/evidence has changed/i);
    expect(container.querySelector("[data-presentation='stale']")).toBeTruthy();
  });

  it("a current chain is not labelled stale", () => {
    render(<SessionUserValueChain derivation={derivation()} />);
    expect(document.body.textContent).not.toMatch(/evidence has changed/i);
  });
});

describe("a newer analyzer is flagged, not discarded", () => {
  it("keeps the rows and warns", () => {
    const { container } = render(
      <SessionUserValueChain
        derivation={derivation({ analyzerVersionAhead: true })}
      />
    );
    expect(container.querySelectorAll("[data-stage]")).toHaveLength(6);
    expect(document.body.textContent).toContain("Derived by a newer analyzer");
  });
});

describe("a row from a newer analyzer degrades, it never throws", () => {
  /**
   * `STATE_META`, `USER_VALUE_STAGE_LABELS`, `STAGE_STATE_LABELS` and
   * `STAGE_REASON_LABELS` are total over THIS build's vocabularies, but rows
   * arrive off the wire and the panel itself says they may come from a build
   * ahead of this one. This panel is mounted in the session detail pane with
   * no boundary above it, so a throw here would take the transcript, the
   * judge and the checks down with it.
   */
  const alien = derivation({
    stageResults: [
      { stage: "connection", state: "passed", reason: "observed" },
      { stage: "discovery", state: "passed", reason: "observed" },
      // A seventh state and an unknown reason, from a build we have not shipped.
      {
        stage: "selection",
        state: "quarantined" as never,
        reason: "somethingNew" as never,
      },
      { stage: "call", state: "passed", reason: "observed" },
      { stage: "response", state: "passed", reason: "observed" },
      { stage: "invented" as never, state: "passed", reason: "observed" },
    ],
    analyzerVersionAhead: true,
  });

  it("renders all six rows instead of throwing", () => {
    const { container } = render(<SessionUserValueChain derivation={alien} />);
    expect(container.querySelectorAll("[data-stage]")).toHaveLength(6);
  });

  it("says the state is not recognized rather than rendering blank", () => {
    render(<SessionUserValueChain derivation={alien} />);
    expect(document.body.textContent).toContain("state not recognized");
  });

  it("falls back to the wire spelling for an unknown stage", () => {
    render(<SessionUserValueChain derivation={alien} />);
    // A poor label, but a better one than nothing: it still tells a reader
    // which row they are looking at.
    expect(document.body.textContent).toContain("invented");
  });

  it("shows an unknown REASON rather than dropping the line", () => {
    // This one fails differently from the others: an unrecognized reason with
    // no fallback is falsy, so the whole line is omitted and the row loses the
    // only thing that says why it landed where it did. Silence, not a blank.
    render(<SessionUserValueChain derivation={alien} />);
    expect(document.body.textContent).toContain("somethingNew");
  });

  it("survives an unknown failure category too", () => {
    const { container } = render(
      <SessionUserValueChain
        derivation={derivation({ failureCategory: "brandNew" as never })}
      />
    );
    expect(container.querySelectorAll("[data-stage]")).toHaveLength(6);
    expect(document.body.textContent).toContain("brandNew");
  });
});
