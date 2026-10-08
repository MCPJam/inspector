import { describe, expect, it } from "vitest";
import type { StageResultRow, UserValueStage } from "@mcpjam/sdk/contract";
import {
  NO_RECORDED_STATE_LABEL,
  buildStageRailCells,
} from "../case-scorecard/stage-rail";
import { MASKED_STAGE_LABEL } from "../trial-chain-panel";
import { openingStage } from "../case-scorecard/trial-scorecard";

const rows = (
  entries: Array<[UserValueStage, Partial<StageResultRow>]>,
): ReadonlyMap<UserValueStage, StageResultRow> =>
  new Map(
    entries.map(([stage, row]) => [
      stage,
      { stage, state: "passed", ...row } as StageResultRow,
    ]),
  );

describe("buildStageRailCells", () => {
  it("numbers a cell by the stage's place in the chain, not in the list", () => {
    // A chain that recorded no `discovery` row must not renumber the rest:
    // `04` beside Tool call is a claim about where the reader is standing.
    const cells = buildStageRailCells({
      stages: ["connection", "selection", "call"],
      rows: rows([
        ["connection", {}],
        ["selection", { state: "failed", reason: "missingToolCall" }],
        ["call", { state: "notReached" }],
      ]),
    });
    expect(cells.map((cell) => [cell.ordinal, cell.label])).toEqual([
      ["01", "Connection"],
      ["03", "Selection"],
      ["04", "Tool call"],
    ]);
  });

  it("takes its tone from the same derivation the run page's cards use", () => {
    const cells = buildStageRailCells({
      stages: ["connection", "selection", "call"],
      rows: rows([
        ["connection", {}],
        ["selection", { state: "failed", reason: "missingToolCall" }],
        ["call", { state: "notReached" }],
      ]),
    });
    expect(cells.map((cell) => cell.toneClass)).toEqual([
      "text-success",
      "text-destructive",
      // Neutral: an unmeasured stage is an absence of evidence, not a warning.
      "text-muted-foreground",
    ]);
    expect(cells.map((cell) => cell.stateLabel)).toEqual([
      "Session connected",
      "failed",
      "never ran (an earlier stage failed)",
    ]);
  });

  it("gives a masked stage a neutral dot and says why", () => {
    const [cell] = buildStageRailCells({
      stages: ["userValue"],
      rows: rows([["userValue", { state: "failed", reason: "judgeFailed" }]]),
      maskedStage: "userValue",
    });
    // The state the mask exists to withhold must not reach the rail, in tone
    // or in the accessible name.
    expect(cell.stateLabel).toBe(MASKED_STAGE_LABEL);
    expect(cell.toneClass).toBe("text-muted-foreground");
  });

  it("says the read came up empty for a stage the chain left out", () => {
    const [cell] = buildStageRailCells({
      stages: ["response"],
      rows: rows([]),
    });
    expect(cell.stateLabel).toBe(NO_RECORDED_STATE_LABEL);
    expect(cell.toneClass).toBe("text-muted-foreground");
  });
});

describe("openingStage", () => {
  const stages: UserValueStage[] = [
    "connection",
    "discovery",
    "selection",
    "call",
    "response",
    "userValue",
  ];
  const chain = (extra: Record<string, unknown>) =>
    ({
      status: "verified",
      stages: stages.map((stage) => ({ stage, state: "passed" })),
      ...extra,
    }) as never;

  it("opens on the contract's own first failed stage", () => {
    expect(
      openingStage({
        chain: chain({ firstFailedStage: "selection" }),
        stages,
        judgeHidden: false,
        maskedStage: null,
      }),
    ).toBe("selection");
  });

  it("opens on the end of the chain when nothing broke", () => {
    expect(
      openingStage({
        chain: chain({}),
        stages,
        judgeHidden: false,
        maskedStage: null,
      }),
    ).toBe("userValue");
  });

  it("opens where the only explanation is, when no verdict was established", () => {
    // The setup-abort shape: every stage unmeasured, and the one sentence a
    // reader wants sits in a row's reason.
    const aborted = {
      status: "verified",
      stages: stages.map((stage) => ({
        stage,
        state: "notMeasured",
        ...(stage === "connection" ? { reason: "setupFailed" } : {}),
      })),
    } as never;
    expect(
      openingStage({
        chain: aborted,
        stages,
        judgeHidden: false,
        maskedStage: null,
      }),
    ).toBe("connection");
  });

  it("opens on User value for a blind reviewer, masked or not", () => {
    // The label control lives in that section; a reviewer who has to go and
    // find it labels a different thing on every iteration.
    for (const maskedStage of ["userValue", null] as const) {
      expect(
        openingStage({
          chain: chain({ firstFailedStage: "selection" }),
          stages,
          judgeHidden: true,
          maskedStage,
        }),
      ).toBe("userValue");
    }
  });

  it("never opens a stage that has no section", () => {
    expect(
      openingStage({
        chain: chain({ firstFailedStage: "selection" }),
        stages: ["connection", "response"],
        judgeHidden: false,
        maskedStage: null,
      }),
      // Neither the break nor the end of the chain is on screen, so the
      // first section it does have is the only honest answer.
    ).toBe("connection");
    expect(
      openingStage({
        chain: null,
        stages: [],
        judgeHidden: false,
        maskedStage: null,
      }),
    ).toBeNull();
  });
});
