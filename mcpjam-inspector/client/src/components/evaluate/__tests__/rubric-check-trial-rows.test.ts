import { describe, expect, it } from "vitest";
import {
  buildEvaluationConfigSnapshot,
  errorScoreResult,
  finalizeScoreResult,
  resolveScoreDefinition,
  type ScoreDefinition,
} from "@mcpjam/sdk/contract";
import { hostedRubricCheckScorerId } from "@/shared/hosted-criterion-id";
import type { EvalIteration } from "@/components/evals/types";
import {
  buildCaseScorecard,
  expectationOf,
} from "../case-scorecard/case-scorecard-model";
import {
  joinTrialResults,
  rubricCheckTrialRows,
} from "../case-scorecard/trial-results";
import { withRubricCheckRows } from "../case-scorecard/trial-scorecard";
import { resultGlyph } from "../case-scorecard/trial-scorecard-row";

function definition(
  key: string,
  label: string,
  passThreshold: number,
): ScoreDefinition {
  return {
    scorerId: hostedRubricCheckScorerId(key),
    idSource: "platform",
    scorerVersion: "1",
    implementationHash: `impl-${key}`,
    label: `rubric check: ${label}`,
    deterministic: false,
    passThreshold,
    role: "advisory",
    model: "typesafe-ai/jev",
  };
}

const cites = definition("c:cites", "Cites a source", 0.5);
const polite = definition("c:polite", "Stays polite", 0.5);
const unsure = definition("c:unsure", "Names the file", 0.5);
const tone = definition("q:tone", "Tone", 0.5);

function iteration(): EvalIteration {
  const config = buildEvaluationConfigSnapshot([cites, polite, unsure, tone]);
  const scored = (d: ScoreDefinition, value: number) =>
    finalizeScoreResult(resolveScoreDefinition(d), {
      kind: "scored",
      value,
      rationale: `P(yes) ${value}`,
    });
  return {
    _id: "it1",
    status: "completed",
    result: "passed",
    metadata: {
      evaluationConfig: config,
      scores: [
        scored(cites, 0.93),
        errorScoreResult(resolveScoreDefinition(polite), "no_answer"),
        scored(unsure, 0.51),
        // A three-level score at its middle level: 0.5, and NOT a coin flip.
        scored(tone, 0.5),
      ],
    },
  } as unknown as EvalIteration;
}

/**
 * A trial graded on yes/no questions: each projected row's value is P(pass),
 * the way the backend scores it, and the verdict carries the kind and P(yes).
 */
function yesNoTrial(
  answers: Array<{
    key: string;
    pYes?: number;
    passOn: "yes" | "no";
    kind?: "boolean" | "score";
  }>,
): EvalIteration {
  const definitions = answers.map((a) => definition(a.key, a.key, 0.5));
  const value = (a: (typeof answers)[number]) =>
    a.kind === "score"
      ? 0.5
      : a.passOn === "no"
        ? 1 - (a.pYes ?? 0)
        : (a.pYes ?? 1);
  return {
    _id: "it-yes-no",
    status: "completed",
    result: "passed",
    metadata: {
      evaluationConfig: buildEvaluationConfigSnapshot(definitions),
      scores: answers.map((a, i) =>
        finalizeScoreResult(resolveScoreDefinition(definitions[i]!), {
          kind: "scored",
          value: value(a),
          rationale: `P(yes) ${a.pYes}`,
        }),
      ),
      rubricChecksVerdict: {
        questions: answers.map((a) => ({
          key: a.key,
          kind: a.kind ?? "boolean",
          label: a.key,
          contentDigest: `d-${a.key}`,
          passThreshold: 0.5,
          status: "scored",
          value: value(a),
          ...(a.pYes !== undefined ? { probability: a.pYes } : {}),
        })),
      },
    },
  } as unknown as EvalIteration;
}

describe("rubricCheckTrialRows", () => {
  it("shows nothing for a saved verdict the server never projected", () => {
    // Below dual_write, or when the goal half fails, the backend stores a
    // verdict and projects no rows; the scorecard must not invent them.
    const trial = yesNoTrial([{ key: "q:warned", pYes: 0.9, passOn: "yes" }]);
    expect(
      rubricCheckTrialRows({
        ...trial,
        metadata: { rubricChecksVerdict: trial.metadata?.rubricChecksVerdict },
      }),
    ).toEqual([]);
  });

  it("reads a yes/no question near even odds as Uncertain, whichever answer passes", () => {
    const rows = rubricCheckTrialRows(
      yesNoTrial([
        { key: "q:warned", pYes: 0.51, passOn: "yes" },
        { key: "q:invented", pYes: 0.45, passOn: "no" },
        { key: "q:clean", pYes: 0.1, passOn: "no" },
        { key: "q:caught", pYes: 0.8, passOn: "no" },
        { key: "q:levels", passOn: "yes", kind: "score" },
      ]),
    );
    expect(rows.map((row) => [row.rubricCheck?.key, row.result.state])).toEqual(
      [
        ["q:warned", "uncertain"],
        ["q:invented", "uncertain"],
        ["q:clean", "passed"],
        ["q:caught", "failed"],
        // A score at its middle level is a level, not a coin flip.
        ["q:levels", "passed"],
      ],
    );
    expect(rows[1]!.result).toMatchObject({ value: 0.55, threshold: 0.5 });
    expect(resultGlyph(rows[1]!.result, "advisory").label).toBe("Uncertain");
    expect(rows[2]!.result).toMatchObject({ value: 0.9 });
  });

  it("bands on P(yes), not on a pass-on-No row's P(no)", () => {
    const [atLowEdge, atHighEdge] = rubricCheckTrialRows(
      yesNoTrial([
        // P(yes) 0.40 is inside the band, though its row value is 0.60.
        { key: "q:low", pYes: 0.4, passOn: "no" },
        // P(yes) 0.60 is outside it, though its row value is 0.40.
        { key: "q:high", pYes: 0.6, passOn: "no" },
      ]),
    );
    expect(atLowEdge!.result.state).toBe("uncertain");
    expect(atHighEdge!.result.state).toBe("failed");
  });

  it("keeps a fallback model's yes or no, which has no probability", () => {
    const [answered] = rubricCheckTrialRows(
      yesNoTrial([{ key: "q:warned", passOn: "yes" }]),
    );
    expect(answered!.result).toMatchObject({ state: "passed", value: 1 });
  });

  it("lists what the trial was asked, in the backend's order", () => {
    const rows = rubricCheckTrialRows(iteration());
    expect(rows.map((row) => row.label)).toEqual([
      "Cites a source",
      "Stays polite",
      "Names the file",
      "Tone",
    ]);
    for (const row of rows) {
      expect(row.provenance).toBe("rubricCheck");
      expect(row.role).toBe("advisory");
      expect(row.stage).toBe("userValue");
    }
  });

  it("reads a criterion near even odds as Uncertain, and nothing else", () => {
    const [yes, noAnswer, coinFlip, middleLevel] =
      rubricCheckTrialRows(iteration());
    expect(yes!.result.state).toBe("passed");
    expect(noAnswer!.result.state).toBe("error");
    expect(coinFlip!.result).toMatchObject({ state: "uncertain", value: 0.51 });
    expect(resultGlyph(coinFlip!.result, "advisory").label).toBe("Uncertain");
    // Authored questions keep their pass or miss: 0.5 there is a level.
    expect(middleLevel!.result.state).toBe("passed");
  });

  it("names what a criterion row expected", () => {
    const [yes, , , middleLevel] = rubricCheckTrialRows(iteration());
    expect(expectationOf(yes!)).toBe("Yes: Cites a source");
    expect(expectationOf(middleLevel!)).toBe("On or above the pass line: Tone");
  });

  it("is empty for a trial with no rubric-check rows", () => {
    expect(rubricCheckTrialRows(null)).toEqual([]);
    expect(
      rubricCheckTrialRows({
        _id: "it2",
        status: "completed",
        metadata: {},
      } as unknown as EvalIteration),
    ).toEqual([]);
  });

  it("files the rows under User value, after the goal judge", () => {
    const trial = iteration();
    const card = buildCaseScorecard({
      steps: [],
      toolsChoice: "unset",
    });
    const groups = withRubricCheckRows(
      joinTrialResults(card.groups, { steps: [], iteration: trial }),
      rubricCheckTrialRows(trial),
    );
    const userValue = groups.find((group) => group.stage === "userValue")!;
    expect(userValue.rows[0]!.key).toBe("judge:goalCompletion");
    expect(userValue.rows.slice(1).map((row) => row.provenance)).toEqual([
      "rubricCheck",
      "rubricCheck",
      "rubricCheck",
      "rubricCheck",
    ]);
  });
});

describe("the goal verdict answers for the goal judge only", () => {
  it("does not lend its score to another judge's row", () => {
    const card = buildCaseScorecard({ steps: [], toolsChoice: "unset" });
    const judgeCase = {
      status: "scored",
      score: 0.9,
      passed: true,
    } as never;
    const withRubricJoin = card.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) =>
        row.key === "judge:goalCompletion"
          ? {
              ...row,
              key: "judge:rubricChecks:c:cites",
              join: {
                kind: "judge" as const,
                slot: "rubricChecks" as const,
                scorerId: "judge:rubricChecks:c:cites",
              },
            }
          : row,
      ),
    }));
    const rows = joinTrialResults(withRubricJoin, {
      steps: [],
      iteration: null,
      judgeCase,
    }).flatMap((group) => group.rows);
    expect(
      rows.find((row) => row.key === "judge:rubricChecks:c:cites")!.result
        .state,
    ).toBe("notMeasured");
    const goal = joinTrialResults(card.groups, {
      steps: [],
      iteration: null,
      judgeCase,
    })
      .flatMap((group) => group.rows)
      .find((row) => row.key === "judge:goalCompletion")!;
    expect(goal.result.state).toBe("passed");
  });
});
