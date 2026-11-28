import { describe, expect, it } from "vitest";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import {
  areRubricChecksValid,
  blankRubricCheckQuestion,
  libraryQuestionIdError,
  rubricCheckQuestionError,
  rubricChecksRun,
  withAddedOption,
  withOptionPassing,
  withoutLevel,
  withoutOption,
  withQuestionLabel,
  withRubricChecks,
} from "../rubric-checks-model";

const choice: RubricCheckQuestion = {
  id: "tone",
  kind: "choice",
  label: "Tone",
  instructions: "Which best describes the reply?",
  options: [
    { id: "warm", label: "Warm" },
    { id: "neutral", label: "Neutral" },
    { id: "curt", label: "Curt" },
  ],
  pass: { anyOf: ["warm", "neutral"] },
};

const score: RubricCheckQuestion = {
  id: "coverage",
  kind: "score",
  label: "Coverage",
  instructions: "How completely did the answer cover the request?",
  levels: ["None", "Some", "Most", "All"],
  pass: { minLevel: 2 },
};

function errorOf(question: RubricCheckQuestion) {
  return rubricCheckQuestionError(question, 0, [question]);
}

describe("rubricCheckQuestionError mirrors the backend's refusals", () => {
  it("accepts a well-formed choice and score", () => {
    expect(errorOf(choice)).toBeUndefined();
    expect(errorOf(score)).toBeUndefined();
    expect(areRubricChecksValid({ questions: [choice, score] })).toBe(true);
    expect(areRubricChecksValid(undefined)).toBe(true);
  });

  it("requires ids that can name a score row, once each", () => {
    expect(errorOf({ ...choice, id: "has space" })).toMatch(/Id must be/);
    expect(
      rubricCheckQuestionError(choice, 1, [{ ...score, id: "tone" }, choice]),
    ).toMatch(/unique/);
  });

  it("requires a label and the question itself", () => {
    expect(errorOf({ ...choice, label: "  " })).toMatch(/label/);
    expect(errorOf({ ...choice, instructions: "" })).toMatch(/question/);
  });

  it("requires a pass line that some answer fails", () => {
    expect(errorOf({ ...choice, pass: { anyOf: [] } })).toMatch(
      /at least one option as passing/,
    );
    expect(errorOf({ ...choice, pass: { anyOf: ["ghost"] } })).toMatch(
      /passing/,
    );
    expect(
      errorOf({ ...choice, pass: { anyOf: ["warm", "neutral", "curt"] } }),
    ).toMatch(/must fail/);
    // Level 0 can never pass; the top level must be reachable.
    expect(errorOf({ ...score, pass: { minLevel: 0 } })).toMatch(/lowest/);
    expect(errorOf({ ...score, pass: { minLevel: 4 } })).toMatch(/lowest/);
    expect(errorOf({ ...score, pass: {} })).toMatch(/lowest/);
  });

  it("bounds the options and levels", () => {
    expect(
      errorOf({ ...choice, options: [{ id: "warm", label: "Warm" }] }),
    ).toMatch(/2 to 20 options/);
    expect(errorOf({ ...score, levels: ["Only"] })).toMatch(/2 to 10 levels/);
    expect(errorOf({ ...score, levels: ["", "Some", "All"] })).toMatch(
      /Each level/,
    );
  });

  it("refuses more than ten questions", () => {
    const questions = Array.from({ length: 11 }, (_, i) => ({
      ...score,
      id: `q${i}`,
    }));
    expect(areRubricChecksValid({ questions })).toBe(false);
  });
});

describe("question edits", () => {
  it("starts a blank question with an unused id, invalid until written", () => {
    const next = blankRubricCheckQuestion("choice", [choice]);
    expect(next.id).toBe("choice");
    expect(blankRubricCheckQuestion("choice", [next]).id).toBe("choice-2");
    expect(errorOf(next)).toBeDefined();
    expect(blankRubricCheckQuestion("score", []).pass).toEqual({
      minLevel: 2,
    });
  });

  it("mints the id from the first label only", () => {
    const blank = { ...blankRubricCheckQuestion("score", []), label: "" };
    const named = withQuestionLabel(blank, "Answer depth", []);
    expect(named.id).toBe("answer-depth");
    // A typo fix keeps the id, and so keeps the score row.
    expect(withQuestionLabel(named, "Answer depths", []).id).toBe(
      "answer-depth",
    );
  });

  it("keeps the pass line in step with the options", () => {
    const added = withAddedOption(choice);
    expect(added.options).toHaveLength(4);
    expect(new Set(added.options!.map((o) => o.id)).size).toBe(4);
    const dropped = withoutOption(choice, "warm");
    expect(dropped.pass).toEqual({ anyOf: ["neutral"] });
    // Stored in option order, whatever order the boxes were ticked in.
    const ticked = withOptionPassing(
      { ...choice, pass: { anyOf: ["neutral"] } },
      "warm",
      true,
    );
    expect(ticked.pass.anyOf).toEqual(["warm", "neutral"]);
    expect(withOptionPassing(ticked, "warm", false).pass.anyOf).toEqual([
      "neutral",
    ]);
  });

  it("keeps the pass line on the same level when a level goes", () => {
    // Removing a level below the line moves the line down with its level.
    expect(withoutLevel(score, 0).pass.minLevel).toBe(1);
    // Removing one above it leaves the line alone.
    expect(withoutLevel(score, 3).pass.minLevel).toBe(2);
    // And the line never falls out of range.
    const two = withoutLevel({ ...score, pass: { minLevel: 3 } }, 3);
    expect(two.pass.minLevel).toBe(2);
    expect(errorOf(two)).toBeUndefined();
  });

  it("drops an emptied question list instead of storing []", () => {
    expect(
      withRubricChecks(
        { rubricChecks: { questions: [score] } },
        {
          questions: [],
        },
      ),
    ).toEqual({ rubricChecks: {} });
    expect(
      withRubricChecks(
        { goalCompletion: { threshold: 0.8 } },
        {
          enabled: false,
        },
      ),
    ).toEqual({
      goalCompletion: { threshold: 0.8 },
      rubricChecks: { enabled: false },
    });
  });

  it("runs only while the goal judge and the slot are both on", () => {
    expect(rubricChecksRun(undefined)).toBe(true);
    expect(rubricChecksRun({ goalCompletion: { enabled: false } })).toBe(false);
    expect(rubricChecksRun({ rubricChecks: { enabled: false } })).toBe(false);
  });
});

describe("yes/no questions", () => {
  it("starts passing on Yes and needs a pass answer", () => {
    const blank = blankRubricCheckQuestion("yesno", []);
    expect(blank).toMatchObject({ kind: "yesno", pass: { answer: "yes" } });
    const filled: RubricCheckQuestion = {
      ...blank,
      label: "Warned the user",
      instructions: "Did the agent warn the user about the instruction?",
    };
    expect(rubricCheckQuestionError(filled, 0, [filled])).toBeUndefined();
    const noAnswer: RubricCheckQuestion = { ...filled, pass: {} };
    expect(rubricCheckQuestionError(noAnswer, 0, [noAnswer])).toBe(
      "Choose whether Yes or No passes.",
    );
  });
});

describe("question kinds this build does not know", () => {
  // As the wire delivers it: a newer backend's kind this build's types lack.
  const fromNewerBackend: RubricCheckQuestion = JSON.parse(
    JSON.stringify({
      id: "rank",
      kind: "ranking",
      label: "Ranks the options",
      instructions: "Rank the answers.",
      pass: { top: 1 },
    }),
  );

  it("passes client validation, since the backend validates it on save", () => {
    expect(
      rubricCheckQuestionError(fromNewerBackend, 0, [fromNewerBackend]),
    ).toBeUndefined();
    expect(areRubricChecksValid({ questions: [score, fromNewerBackend] })).toBe(
      true,
    );
  });

  it("still checks the fields every kind shares, and scores on their own branch", () => {
    const unlabeled = { ...fromNewerBackend, label: "" };
    expect(rubricCheckQuestionError(unlabeled, 0, [unlabeled])).toBe(
      "A label is required.",
    );
    const flat: RubricCheckQuestion = { ...score, levels: ["Only"] };
    expect(rubricCheckQuestionError(flat, 0, [flat])).toMatch(
      /A score needs 2 to/,
    );
  });
});

describe("library question IDs", () => {
  const reserved = "reports-tool-errors-reports-failures";
  const authored: RubricCheckQuestion = {
    id: reserved,
    kind: "yesno",
    label: "Mine",
    instructions: "Did it report every failure?",
    pass: { answer: "yes" },
  };

  it("refuses a library preset's ID on a question written here", () => {
    expect(libraryQuestionIdError(authored)).toBe(
      "This ID belongs to a library preset. Enter a different ID.",
    );
  });

  it("accepts the ID on the preset's own tagged question", () => {
    const fromPreset = {
      ...authored,
      evaluator: { id: "reports-tool-errors", version: 1 },
    };
    expect(libraryQuestionIdError(fromPreset)).toBeUndefined();
  });

  it("never blocks saving a stored question that already holds one", () => {
    expect(libraryQuestionIdError(authored, reserved)).toBeUndefined();
    expect(rubricCheckQuestionError(authored, 0, [authored])).toBeUndefined();
    expect(areRubricChecksValid({ questions: [authored] })).toBe(true);
  });

  it("never names a question with a library preset's ID", () => {
    const blank = blankRubricCheckQuestion("yesno", []);
    expect(
      withQuestionLabel(blank, "Reports tool errors reports failures", []).id,
    ).toBe(`${reserved}-2`);
  });
});
