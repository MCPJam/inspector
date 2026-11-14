/**
 * The decision scan's candidate rules on held-out cases, with no model. Every
 * labelled violation should reach the model; each test names the ones the
 * rules do not propose, and the benign cases they send anyway (each one a
 * question MCPJam pays for and a chance of a false alarm). The cases were
 * written before the rules ran on them and were not used to tune them, so a
 * rule change shows up as a change in these lists. The model's side is
 * measured by `scripts/measure-decision-scan.ts`, through the broker.
 */

import { describe, expect, it } from "vitest";

import {
  caseDirectory,
  isViolation,
  loadHeldOutCases,
  measurementItems,
  proposedCandidates,
  type HeldOutCase,
} from "../../scripts/decision-scan-held-out.js";
import {
  DIRECTORY_DECISION_QUESTIONS,
  directoryDecisionQuestion,
  selectDecisionItems,
} from "../../src/directory-readiness/index.js";

const DIRECTION = "claude.decision.cross-tool-direction";
const FAIR_PLAY = "openai.decision.fair-play";
const SECRETS = "openai.decision.secret-seeking";
const ANNOTATION = "both.decision.annotation-matches-behaviour";

const CASES = loadHeldOutCases();

function cases(question: string, violation: boolean): HeldOutCase[] {
  return CASES.filter(
    (heldOut) =>
      heldOut.question === question && isViolation(heldOut) === violation
  );
}

const ids = (list: HeldOutCase[]) => list.map(({ id }) => id);
const proposed = (heldOut: HeldOutCase) =>
  proposedCandidates(heldOut).length > 0;

/** Violations the rules never send to the model. */
const missed = (question: string) =>
  ids(cases(question, true).filter((heldOut) => !proposed(heldOut)));
/** Benign cases the rules send anyway. */
const sent = (question: string) => ids(cases(question, false).filter(proposed));

describe("the held-out cases", () => {
  it("label 36 directions and 36 references, and 18 of each side for the other questions", () => {
    const counts = DIRECTORY_DECISION_QUESTIONS.map(({ id }) => [
      cases(id, true).length,
      cases(id, false).length,
    ]);
    expect(counts).toEqual([
      [36, 36],
      [18, 18],
      [18, 18],
      [18, 18],
    ]);
    expect(new Set(ids(CASES)).size).toBe(CASES.length);
  });

  it("put the text in a parameter's description in 20 cross-tool cases and 15 others", () => {
    const inParameters = (list: HeldOutCase[]) =>
      list.filter((heldOut) => heldOut.param !== undefined).length;
    expect(inParameters(CASES.filter((c) => c.question === DIRECTION))).toBe(
      20
    );
    expect(inParameters(CASES.filter((c) => c.question !== DIRECTION))).toBe(
      15
    );
  });

  it("each give a verdict their question allows, never unsure, with the inputs it reads", () => {
    for (const heldOut of CASES) {
      const question = directoryDecisionQuestion(heldOut.question);
      expect(question?.verdicts, heldOut.id).toContain(heldOut.expected);
      expect(heldOut.expected, heldOut.id).not.toBe("unsure");
      if (question?.inputs.references) {
        // Each tool the text names is in its listing, and the text names each.
        expect(heldOut.siblings?.length, heldOut.id).toBeGreaterThan(0);
        for (const sibling of heldOut.siblings ?? []) {
          expect(heldOut.text, heldOut.id).toContain(sibling);
        }
      }
      if (question?.inputs.annotations) {
        expect(heldOut.annotations, heldOut.id).toBeDefined();
      }
    }
  });

  it("each become one question the backend accepts, proposed or asked whole", () => {
    const items = measurementItems(CASES);
    expect(items).toHaveLength(CASES.length);
    for (const directory of ["claude", "openai"] as const) {
      const asked = items
        .filter((measured) => measured.directory === directory)
        .map((measured) => measured.item);
      const selection = selectDecisionItems(directory, asked, {
        maxQuestions: asked.length,
      });
      expect(selection).toMatchObject({ refused: 0, unasked: {} });
      expect(
        CASES.filter((heldOut) => caseDirectory(heldOut) === directory)
      ).toHaveLength(asked.length);
    }
  });
});

describe("cross-tool direction candidates", () => {
  it("propose 18 of 36 held-out directions, 6 of the 10 in parameter descriptions", () => {
    // Most misses use a verb outside the short lists ("look the thread up",
    // "fall back to", "try", "validate", "open one with") or describe an
    // order with no verb at all ("it comes after acknowledge_incident").
    expect(missed(DIRECTION)).toEqual([
      "dir-01",
      "dir-06",
      "dir-07",
      "dir-08",
      "dir-09",
      "dir-10",
      "dir-12",
      "dir-13",
      "dir-14",
      "dir-17",
      "dir-19",
      "dir-23",
      "dir-24",
      "dir-26",
      "dir-p01",
      "dir-p07",
      "dir-p09",
      "dir-p10",
    ]);
  });

  it("propose none of 36 held-out references", () => {
    expect(sent(DIRECTION)).toEqual([]);
  });
});

describe("fair-play candidates", () => {
  it("propose 6 of 18 held-out steering cases", () => {
    // The rules know "always use this", "prefer this", "instead of other"
    // and a few comparisons; "pick ours", "beat every other", "steer them
    // back" and "rival apps" go unproposed.
    expect(missed(FAIR_PLAY)).toEqual([
      "steer-02",
      "steer-03",
      "steer-06",
      "steer-08",
      "steer-09",
      "steer-10",
      "steer-11",
      "steer-12",
      "steer-14",
      "steer-15",
      "steer-16",
      "steer-17",
    ]);
  });

  it("send 2 of 18 fair cases: a scope limit and a comparison with a rewrite", () => {
    expect(sent(FAIR_PLAY)).toEqual(["fair-03", "fair-13"]);
  });
});

describe("secret-seeking candidates", () => {
  it("propose 14 of 18 held-out requests for secrets", () => {
    // A private SSH key, the whole conversation, a recovery phrase and a
    // card PIN fall outside the word list.
    expect(missed(SECRETS)).toEqual([
      "seek-09",
      "seek-12",
      "seek-13",
      "seek-14",
    ]);
  });

  it("send 8 of 18 clean cases, each naming a secret it does not ask for", () => {
    expect(sent(SECRETS)).toEqual([
      "clean-01",
      "clean-02",
      "clean-03",
      "clean-08",
      "clean-10",
      "clean-13",
      "clean-15",
      "clean-18",
    ]);
  });
});

describe("annotation candidates", () => {
  it("propose 13 of 18 held-out mismatches", () => {
    // "marks it as read", "charges the card again" and "resets" are outside
    // the verb lists; a negation ("without changing anything", "never
    // modifies anything") reads as the behaviour it denies.
    expect(missed(ANNOTATION)).toEqual([
      "mismatch-06",
      "mismatch-07",
      "mismatch-08",
      "mismatch-14",
      "mismatch-16",
    ]);
  });

  it("send 7 of 18 matching cases, each mentioning a behaviour it denies or repeats safely", () => {
    expect(sent(ANNOTATION)).toEqual([
      "match-06",
      "match-07",
      "match-08",
      "match-09",
      "match-15",
      "match-16",
      "match-17",
    ]);
  });
});
