/**
 * The decision scan's contract with the backend, the request a run builds,
 * and how answers become findings: a verdict counts only when its quote is
 * verbatim in its candidate's text, and anything under the threshold is a
 * warning, never a pass.
 */

import { describe, expect, it } from "vitest";

import {
  CLAUDE_CONNECTOR_FLOW,
  DIRECTORY_DECISION_LIMITS,
  DIRECTORY_DECISION_QUESTIONS,
  directoryVerdict,
  gradeDecisionAnswers,
  judgeDecisionAnswer,
  placeDirectoryResults,
  selectDecisionItems,
  type DirectoryCheckDefinition,
  type DirectoryDecisionAnswer,
  type DirectoryDecisionCandidate,
  type DirectoryDecisionItem,
  type DirectoryDecisionQuestionId,
} from "../../src/directory-readiness/index.js";

/** The backend's catalog, as its decision route accepts it. */
const CONTRACT = [
  {
    id: "claude.decision.cross-tool-direction",
    directories: ["claude"],
    verdicts: ["direction", "reference", "unsure"],
    violation: "direction",
    inputs: { tool: "required", references: "required" },
  },
  {
    id: "openai.decision.fair-play",
    directories: ["openai"],
    verdicts: ["steers", "fair", "unsure"],
    violation: "steers",
    inputs: { tool: "optional" },
  },
  {
    id: "openai.decision.secret-seeking",
    directories: ["openai"],
    verdicts: ["seeks", "clean", "unsure"],
    violation: "seeks",
    inputs: { tool: "optional" },
  },
  {
    id: "both.decision.annotation-matches-behaviour",
    directories: ["claude", "openai"],
    verdicts: ["mismatch", "matches", "unsure"],
    violation: "mismatch",
    inputs: { tool: "required", annotations: "required" },
  },
];

const DIRECTION = "claude.decision.cross-tool-direction";
const ANNOTATION = "both.decision.annotation-matches-behaviour";
const FAIR_PLAY = "openai.decision.fair-play";
const STAMP = { evaluatedAt: "2026-11-13T00:00:00.000Z" };
const SOURCE = { page: "submission", section: "§Sample" };

function check(id: string): DirectoryCheckDefinition {
  return {
    id,
    title: id,
    lane: "experience-insights",
    class: "heuristic",
    source: SOURCE,
    provenance: "llm",
    intrusiveness: "passive",
  };
}

const CHECKS = { checks: [check(DIRECTION)], engineVersion: "1", stamp: STAMP };

function item(
  questionId: DirectoryDecisionQuestionId,
  key: string,
  rest: Partial<DirectoryDecisionCandidate> = {}
): DirectoryDecisionItem {
  const inputs =
    questionId === DIRECTION
      ? { tool: "update_record", references: ["lookup_record"] }
      : questionId === ANNOTATION
        ? { tool: "update_record", annotations: { readOnlyHint: true } }
        : {};
  return {
    questionId,
    candidate: {
      key,
      field: "description",
      text: "Call lookup_record first to read the current values.",
      ...inputs,
      ...rest,
    },
  };
}

function answer(
  rest: Partial<DirectoryDecisionAnswer> = {}
): DirectoryDecisionAnswer {
  return {
    questionId: DIRECTION,
    candidateKey: "a",
    verdict: "direction",
    quote: "Call lookup_record first",
    confidence: 0.95,
    ...rest,
  };
}

function grade(
  answers: DirectoryDecisionAnswer[],
  items = [item(DIRECTION, "a")],
  extra: { unasked?: Record<string, number> } = {}
) {
  return gradeDecisionAnswers(items, answers, {
    ...CHECKS,
    confidenceThreshold: 0.8,
    ...extra,
  });
}

describe("the question catalog", () => {
  it("mirrors the backend's ids, directories, verdicts, violations and inputs", () => {
    expect(
      DIRECTORY_DECISION_QUESTIONS.map(
        ({ id, directories, verdicts, violation, inputs }) => ({
          id,
          directories,
          verdicts,
          violation,
          inputs,
        })
      )
    ).toEqual(CONTRACT);
    expect(DIRECTORY_DECISION_LIMITS).toEqual({
      maxQuestionsPerRun: 24,
      maxKeyChars: 200,
      maxNameChars: 200,
      maxFieldChars: 300,
      maxTextChars: 2_000,
      maxReferences: 10,
      maxQuoteChars: 400,
    });
  });

  it("puts each violation first, and lets every question answer unsure", () => {
    for (const question of DIRECTORY_DECISION_QUESTIONS) {
      expect(question.verdicts[0], question.id).toBe(question.violation);
      expect(question.verdicts, question.id).toContain("unsure");
    }
  });
});

describe("the request", () => {
  it("sends only what each question reads, refusing what the backend would", () => {
    const claude = selectDecisionItems("claude", [
      item(DIRECTION, "ok"),
      item(DIRECTION, "no-references", { references: undefined }),
      item(ANNOTATION, "no-hints", { annotations: {} }),
      item(ANNOTATION, "titled", {
        annotations: { readOnlyHint: true, title: "x" } as never,
      }),
      item(FAIR_PLAY, "other-directory"),
    ]);
    expect(claude.items.map(({ candidate }) => candidate.key)).toEqual([
      "ok",
      "titled",
    ]);
    expect(claude.items[1].candidate.annotations).toEqual({
      readOnlyHint: true,
    });
    // Another directory's question is not this run's to leave unjudged.
    expect(claude).toMatchObject({
      refused: 3,
      unasked: { [DIRECTION]: 1, [ANNOTATION]: 1 },
    });

    const openai = selectDecisionItems("openai", [
      item(FAIR_PLAY, "no-tool"),
      item(FAIR_PLAY, "references", { references: ["other_tool"] }),
      item(FAIR_PLAY, "long", { text: "x".repeat(2_001) }),
      item(FAIR_PLAY, " "),
    ]);
    expect(openai.items.map(({ candidate }) => candidate.key)).toEqual([
      "no-tool",
    ]);
    expect(openai.items[0].candidate).toEqual({
      key: "no-tool",
      field: "description",
      text: "Call lookup_record first to read the current values.",
    });
    expect(openai).toMatchObject({ refused: 3, unasked: { [FAIR_PLAY]: 3 } });
  });

  it("sends each question and key once", () => {
    const selection = selectDecisionItems("claude", [
      item(DIRECTION, "a"),
      item(DIRECTION, "a", { text: "Use lookup_record again." }),
      item(ANNOTATION, "a"),
    ]);
    expect(
      selection.items.map((entry) => [entry.questionId, entry.candidate.key])
    ).toEqual([
      [DIRECTION, "a"],
      [ANNOTATION, "a"],
    ]);
    expect(selection).toMatchObject({ refused: 1, unasked: {} });
  });

  it("asks at most the cap, questions taking turns in their own order", () => {
    const candidates = [
      ...Array.from({ length: 20 }, (_, n) => item(DIRECTION, `d${n + 1}`)),
      ...Array.from({ length: 10 }, (_, n) => item(ANNOTATION, `a${n + 1}`)),
    ];
    const full = selectDecisionItems("claude", candidates);
    expect(full.items).toHaveLength(24);
    expect(full.items.slice(0, 4).map((entry) => entry.candidate.key)).toEqual([
      "d1",
      "a1",
      "d2",
      "a2",
    ]);
    expect(full.items.at(-1)?.candidate.key).toBe("d14");
    expect(full.unasked).toEqual({ [DIRECTION]: 6 });

    const three = selectDecisionItems("claude", candidates, {
      maxQuestions: 3,
    });
    expect(three.items.map((entry) => entry.candidate.key)).toEqual([
      "d1",
      "a1",
      "d2",
    ]);
    expect(three.unasked).toEqual({ [DIRECTION]: 18, [ANNOTATION]: 9 });
  });
});

describe("the quote check", () => {
  it("keeps a verdict quoted verbatim, with the check's citation and details", () => {
    const { findings, dropped } = grade([answer()]);
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: DIRECTION,
      status: "violated",
      source: SOURCE,
      provenance: "llm",
      class: "heuristic",
      details: {
        asked: 1,
        candidates: [
          {
            key: "a",
            tool: "update_record",
            field: "description",
            verdict: "direction",
            quote: "Call lookup_record first",
            confidence: 0.95,
            outcome: "violated",
          },
        ],
      },
    });
    expect(findings[0].remediation).toContain("update_record description");
  });

  it("drops a paraphrased quote and counts it, never as a finding", () => {
    for (const quote of [
      "Call lookup_record before anything else",
      "call lookup_record first",
      "Call  lookup_record first",
    ]) {
      const { findings, dropped } = grade([answer({ quote })]);
      expect(dropped, quote).toBe(1);
      expect(findings[0], quote).toMatchObject({
        status: "not-evaluated",
        details: { candidates: [], dropped: 1 },
      });
      expect(findings[0].notEvaluatedReason).toBe(
        "No verdict for 1 of 1 candidates: 0 not asked, 0 not answered, 1 quoting text the source does not contain."
      );
    }
  });

  it("drops a blank quote and a verdict the question does not have", () => {
    const one = item(DIRECTION, "a");
    expect(judgeDecisionAnswer(one, answer({ quote: " " }), 0.8)).toBe(
      undefined
    );
    expect(judgeDecisionAnswer(one, answer({ verdict: "steers" }), 0.8)).toBe(
      undefined
    );
  });
});

describe("the confidence threshold", () => {
  it("makes every verdict below it, and any unsure one, inconclusive", () => {
    for (const given of [
      { verdict: "direction", confidence: 0.6 },
      { verdict: "reference", confidence: 0.6 },
      { verdict: "unsure", confidence: 0.99 },
      { verdict: "direction", confidence: Number.NaN },
    ]) {
      const [finding] = grade([answer(given)]).findings;
      expect(finding, given.verdict).toMatchObject({
        status: "informational",
        details: { confidence: "low" },
      });
      expect(finding.status).not.toBe("satisfied");
      expect(finding.remediation).toContain("could not settle");
    }
  });

  it("reads as inconclusive where it is placed, and never passes a gate", () => {
    const [finding] = grade([answer({ confidence: 0.6 })]).findings;
    const placed = placeDirectoryResults({
      flow: CLAUDE_CONNECTOR_FLOW,
      answers: [],
      findings: [finding],
    }).flatMap((step) => step.findings);
    expect(placed[0]).toMatchObject({
      step: "compliance",
      evidenceStatus: "inconclusive",
    });
    const gate = {
      path: "hosted",
      checkGate: { failOn: [DIRECTION] },
    } as const;
    for (const findings of [placed, [finding]]) {
      expect(directoryVerdict(findings, gate)).toMatchObject({
        verdict: "incomplete",
        undetermined: [DIRECTION],
        failing: [],
      });
    }
  });

  it("passes a candidate on a settled verdict that is not the violation", () => {
    for (const confidence of [0.8, 0.97]) {
      const [finding] = grade([
        answer({ verdict: "reference", confidence }),
      ]).findings;
      expect(finding.status, String(confidence)).toBe("satisfied");
    }
  });
});

describe("one finding per question", () => {
  const two = [item(DIRECTION, "a"), item(DIRECTION, "b")];
  const second = (rest: Partial<DirectoryDecisionAnswer>) =>
    answer({ candidateKey: "b", ...rest });

  it("is violated when any candidate is, whatever the others say", () => {
    const { findings } = grade(
      [answer(), second({ verdict: "unsure", confidence: 0.4 })],
      two
    );
    expect(findings[0].status).toBe("violated");
    expect(findings[0].details?.candidates).toHaveLength(2);
  });

  it("is inconclusive over a candidate nobody judged", () => {
    const { findings } = grade([second({ confidence: 0.5 })], two);
    expect(findings[0]).toMatchObject({
      status: "informational",
      details: { unanswered: 1 },
    });
  });

  it("is not evaluated while any candidate has no verdict, and says why", () => {
    const passed = second({ verdict: "reference" });
    expect(grade([passed], two).findings[0]).toMatchObject({
      status: "not-evaluated",
      notEvaluatedReason:
        "No verdict for 1 of 2 candidates: 0 not asked, 1 not answered, 0 quoting text the source does not contain.",
    });
    expect(
      grade([answer({ verdict: "reference" })], undefined, {
        unasked: { [DIRECTION]: 4 },
      }).findings[0]
    ).toMatchObject({
      status: "not-evaluated",
      notEvaluatedReason:
        "No verdict for 4 of 5 candidates: 4 not asked, 0 not answered, 0 quoting text the source does not contain.",
    });
  });

  it("is satisfied when every candidate passed, or none needed asking", () => {
    expect(grade([answer({ verdict: "reference" })]).findings[0].status).toBe(
      "satisfied"
    );
    expect(grade([], []).findings[0]).toMatchObject({
      status: "satisfied",
      details: { asked: 0, candidates: [] },
    });
  });
});

describe("the scan is off by default", () => {
  const off = (finding: { notEvaluatedReason?: string; details?: object }) => {
    expect(finding).toMatchObject({
      status: "not-evaluated",
      details: { ungatheredEvidence: "decisionAnswers" },
    });
    expect(finding.notEvaluatedReason).toMatch(/decision scan is off/);
  };

  it("says so on every check when nothing was asked", () => {
    const { findings, dropped } = gradeDecisionAnswers([], [], {
      ...CHECKS,
      checks: [check(DIRECTION), check(ANNOTATION)],
    });
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(2);
    findings.forEach(off);
  });

  it("grades nothing without a threshold in range, whatever came back", () => {
    for (const confidenceThreshold of [undefined, 1.5, -0.1, Number.NaN]) {
      const { findings } = gradeDecisionAnswers(
        [item(DIRECTION, "a")],
        [answer()],
        { ...CHECKS, confidenceThreshold }
      );
      off(findings[0]);
    }
  });

  it("grades once a threshold is set, unless the tool listing was not read in full", () => {
    const graded = (listing?: { read: boolean; complete?: boolean }) =>
      gradeDecisionAnswers([item(DIRECTION, "a")], [answer()], {
        ...CHECKS,
        confidenceThreshold: 0.8,
        listing,
        missingInput: "toolListing",
      }).findings[0];
    expect(graded().status).toBe("violated");
    expect(graded({ read: true }).status).toBe("violated");
    expect(graded({ read: false })).toMatchObject({
      status: "not-evaluated",
      notEvaluatedReason:
        "no tool listing was captured for this run, so the decision scan cannot cover every tool",
      details: { missingInput: "toolListing" },
    });
    expect(graded({ read: true, complete: false }).notEvaluatedReason).toBe(
      "the tool listing was truncated, so the decision scan cannot cover every tool"
    );
  });
});
