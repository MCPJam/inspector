/**
 * The decision scan's held-out cases, shared by the tests that measure the
 * candidate rules with no model and the script that measures the model
 * through the broker. Each case is scanned alone, in a listing that holds its
 * text and the tools it names, so one case's text cannot propose another's.
 * Pure: reads the committed fixture and sends nothing.
 */

import { readFileSync } from "node:fs";

import {
  DIRECTORY_DECISION_LIMITS,
  DIRECTORY_DECISION_QUESTIONS,
  directoryDecisionQuestion,
  findDecisionCandidates,
  judgeDecisionAnswer,
  type DirectoryDecisionAnnotations,
  type DirectoryDecisionAnswer,
  type DirectoryDecisionCandidate,
  type DirectoryDecisionDirectory,
  type DirectoryDecisionEvidence,
  type DirectoryDecisionItem,
  type DirectoryDecisionQuestionId,
} from "../src/directory-readiness/decisions/index.js";

export interface HeldOutCase {
  id: string;
  question: DirectoryDecisionQuestionId;
  /** The verdict the question should give. */
  expected: string;
  tool?: string;
  /** Puts the text in this parameter's description instead of the tool's. */
  param?: string;
  /** Without a tool: `instructions`, or a listing field. */
  field?: string;
  text: string;
  /** The other tools in the listing. */
  siblings?: string[];
  annotations?: DirectoryDecisionAnnotations;
}

/** The thresholds a measurement reports, for the engineer to choose from. */
export const MEASURED_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

export function loadHeldOutCases(): HeldOutCase[] {
  const fixture = new URL(
    "../tests/fixtures/decision-scan/held-out.json",
    import.meta.url
  );
  return (JSON.parse(readFileSync(fixture, "utf8")) as { cases: HeldOutCase[] })
    .cases;
}

export function isViolation(heldOut: HeldOutCase): boolean {
  return (
    heldOut.expected === directoryDecisionQuestion(heldOut.question)?.violation
  );
}

/** The field the text sits in, named as a candidate names it. */
export function caseField({ tool, param, field }: HeldOutCase): string {
  if (tool === undefined) return field ?? "instructions";
  return param === undefined
    ? "description"
    : `inputSchema.properties.${param}.description`;
}

/** The run that asks the case: Claude's for a question both ask. */
export function caseDirectory(
  heldOut: HeldOutCase
): DirectoryDecisionDirectory {
  return (
    directoryDecisionQuestion(heldOut.question)?.directories[0] ?? "claude"
  );
}

export function caseEvidence(heldOut: HeldOutCase): DirectoryDecisionEvidence {
  const { tool, param, text, annotations } = heldOut;
  const siblings = (heldOut.siblings ?? []).map((name) => ({ name }));
  if (tool === undefined) {
    return heldOut.field === "instructions"
      ? { tools: siblings, instructions: text }
      : { tools: siblings, listing: [{ field: caseField(heldOut), text }] };
  }
  const owner =
    param === undefined
      ? { name: tool, description: text, annotations }
      : {
          name: tool,
          inputSchema: {
            type: "object",
            properties: { [param]: { type: "string", description: text } },
          },
        };
  return { tools: [owner, ...siblings] };
}

/** What the rules propose for the case's own question. */
export function proposedCandidates(heldOut: HeldOutCase) {
  const evidence = caseEvidence(heldOut);
  const all = findDecisionCandidates(caseDirectory(heldOut), evidence);
  return all.filter((item) => item.questionId === heldOut.question);
}

/** One question of a measurement, tied back to its case. */
export interface MeasuredItem {
  caseId: string;
  directory: DirectoryDecisionDirectory;
  /** False when the rules proposed nothing and the case is asked whole. */
  proposed: boolean;
  item: DirectoryDecisionItem;
}

/**
 * A question per candidate the rules propose, keyed by the case's id. A case
 * the rules pass over is asked whole, so the model's own accuracy can be read
 * apart from the rules' recall; scoring keeps the two apart.
 */
export function measurementItems(
  cases: readonly HeldOutCase[]
): MeasuredItem[] {
  return cases.flatMap((heldOut) => {
    const proposed = proposedCandidates(heldOut);
    const asked = proposed.length > 0 ? proposed : [wholeCase(heldOut)];
    return asked.map(({ questionId, candidate }, index) => ({
      caseId: heldOut.id,
      directory: caseDirectory(heldOut),
      proposed: proposed.length > 0,
      item: {
        questionId,
        candidate: {
          ...candidate,
          key: index === 0 ? heldOut.id : `${heldOut.id} #${index + 1}`,
        },
      },
    }));
  });
}

/** The case as one candidate carrying only the inputs its question reads. */
function wholeCase(heldOut: HeldOutCase): DirectoryDecisionItem {
  const { inputs } = directoryDecisionQuestion(heldOut.question) ?? {};
  const candidate: DirectoryDecisionCandidate = {
    key: heldOut.id,
    field: caseField(heldOut),
    text: heldOut.text,
    ...(inputs?.tool && heldOut.tool ? { tool: heldOut.tool } : {}),
    ...(inputs?.references ? { references: heldOut.siblings ?? [] } : {}),
    ...(inputs?.annotations ? { annotations: heldOut.annotations } : {}),
  };
  return { questionId: heldOut.question, candidate };
}

/** One request each: a run asks one directory's questions, at most its cap. */
export function measurementBatches(items: readonly MeasuredItem[]) {
  const size = DIRECTORY_DECISION_LIMITS.maxQuestionsPerRun;
  return (["claude", "openai"] as const).flatMap((directory) => {
    const asked = items.filter((item) => item.directory === directory);
    const count = Math.ceil(asked.length / size);
    return Array.from({ length: count }, (_, at) => ({
      directory,
      items: asked.slice(at * size, (at + 1) * size),
    }));
  });
}

type Outcome = "violated" | "inconclusive" | "passed" | "unjudged";

/**
 * Each case's outcome at each threshold, as the grading reads its answers:
 * one violated candidate makes the case violated, an inconclusive one a
 * warning, and a dropped or missing answer leaves it unjudged. Per question,
 * `proposed` counts the cases the rules send, `dropped` holds the keys the
 * quote check drops (a quote not in the text, or a verdict the question does
 * not allow) and `unanswered` the keys with no answer. Per threshold,
 * `missed` violations would pass (judged benign, or never proposed),
 * `falseAlarms` benign cases would be reported, `warned` cases would show as
 * inconclusive, and the `model` pair counts every case asked.
 */
export function scoreMeasurement(
  cases: readonly HeldOutCase[],
  items: readonly MeasuredItem[],
  answers: readonly DirectoryDecisionAnswer[],
  thresholds: readonly number[] = MEASURED_THRESHOLDS
) {
  const pair = (questionId: string, key: string) =>
    JSON.stringify([questionId, key]);
  const answered = new Map(
    answers.map((a) => [pair(a.questionId, a.candidateKey), a])
  );
  const answerTo = ({ item }: MeasuredItem) =>
    answered.get(pair(item.questionId, item.candidate.key));
  const key = ({ item }: MeasuredItem) => item.candidate.key;

  return DIRECTORY_DECISION_QUESTIONS.map(({ id }) => {
    const mine = cases.filter((heldOut) => heldOut.question === id);
    const asked = items.filter((measured) => measured.item.questionId === id);
    const outcome = (
      caseId: string,
      threshold: number,
      whole: boolean
    ): Outcome => {
      const own = asked.filter(
        (measured) => measured.caseId === caseId && (whole || measured.proposed)
      );
      // Nothing proposed: the scan never asks, so the case passes silently.
      if (own.length === 0) return "passed";
      const outcomes = own.map((measured) => {
        const answer = answerTo(measured);
        const result =
          answer && judgeDecisionAnswer(measured.item, answer, threshold);
        return result?.outcome ?? "unjudged";
      });
      const worst = (["violated", "inconclusive", "unjudged"] as const).find(
        (candidate) => outcomes.includes(candidate)
      );
      return worst ?? "passed";
    };
    /** Cases with that outcome, of one side when `violation` is given. */
    const ids = (
      at: number,
      whole: boolean,
      wanted: Outcome,
      violation?: boolean
    ) =>
      mine
        .filter((c) => violation === undefined || isViolation(c) === violation)
        .filter((heldOut) => outcome(heldOut.id, at, whole) === wanted)
        .map((heldOut) => heldOut.id);
    const proposedCases = new Set(
      asked.filter((measured) => measured.proposed).map((m) => m.caseId)
    );
    const count = (violation: boolean) =>
      mine.filter(
        (heldOut) =>
          isViolation(heldOut) === violation && proposedCases.has(heldOut.id)
      ).length;
    return {
      questionId: id,
      violations: mine.filter(isViolation).length,
      benign: mine.filter((heldOut) => !isViolation(heldOut)).length,
      proposed: { violations: count(true), benign: count(false) },
      dropped: asked
        .filter((measured) => {
          const answer = answerTo(measured);
          return answer && !judgeDecisionAnswer(measured.item, answer, 0);
        })
        .map(key),
      unanswered: asked.filter((measured) => !answerTo(measured)).map(key),
      thresholds: thresholds.map((threshold) => ({
        threshold,
        missed: ids(threshold, false, "passed", true),
        falseAlarms: ids(threshold, false, "violated", false),
        warned: ids(threshold, false, "inconclusive"),
        modelMissed: ids(threshold, true, "passed", true),
        modelFalseAlarms: ids(threshold, true, "violated", false),
      })),
    };
  });
}

export type QuestionScore = ReturnType<typeof scoreMeasurement>[number];
