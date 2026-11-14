/**
 * The request a run sends: candidates the backend accepts, each question and
 * key once, at most the per-run cap. Questions take turns, each in its own
 * order (best first), so one with many candidates cannot crowd out the rest.
 * A candidate left out is counted: nobody judged it, so it is never a pass.
 * Pure. Safe from the browser entry.
 */

import {
  DIRECTORY_DECISION_LIMITS as LIMITS,
  DIRECTORY_DECISION_QUESTIONS,
  decisionHints,
  type DirectoryDecisionCandidate,
  type DirectoryDecisionDirectory,
  type DirectoryDecisionItem,
  type DirectoryDecisionQuestion,
} from "./catalog.js";

export interface DirectoryDecisionSelection {
  /** The request's `items`. */
  items: DirectoryDecisionItem[];
  /** This run's candidates left out, by question: over the cap or the bounds. */
  unasked: Record<string, number>;
  /** Candidates the backend would refuse, repeated keys included. */
  refused: number;
}

export function selectDecisionItems(
  directory: DirectoryDecisionDirectory,
  candidates: readonly DirectoryDecisionItem[],
  { maxQuestions = LIMITS.maxQuestionsPerRun }: { maxQuestions?: number } = {}
): DirectoryDecisionSelection {
  const asks = DIRECTORY_DECISION_QUESTIONS.filter((question) =>
    question.directories.includes(directory)
  );
  const queues = new Map(
    asks.map((question) => [question.id, [] as DirectoryDecisionItem[]])
  );
  const unasked: Record<string, number> = {};
  const seen = new Set<string>();
  let refused = 0;
  for (const { questionId, candidate } of candidates) {
    const queue = queues.get(questionId);
    const question = asks.find((entry) => entry.id === questionId);
    const valid = question && accepted(question, candidate);
    const pair = JSON.stringify([questionId, candidate.key]);
    if (!queue || !valid || seen.has(pair)) {
      refused += 1;
      if (queue && !valid) unasked[questionId] = (unasked[questionId] ?? 0) + 1;
      continue;
    }
    seen.add(pair);
    queue.push({ questionId, candidate: valid });
  }
  // The backend refuses a request over its per-run cap, so no caller exceeds it.
  const cap = Math.min(maxQuestions, LIMITS.maxQuestionsPerRun);
  const items: DirectoryDecisionItem[] = [];
  for (let round = 0; items.length < cap; round += 1) {
    const turn = [...queues.values()].flatMap((queue) => queue[round] ?? []);
    if (turn.length === 0) break;
    items.push(...turn.slice(0, cap - items.length));
  }
  for (const [id, queue] of queues) {
    const left = queue.length - items.filter((i) => i.questionId === id).length;
    if (left > 0) unasked[id] = (unasked[id] ?? 0) + left;
  }
  return { items, unasked, refused };
}

/**
 * The candidate as the backend's schema takes it, or `undefined` where it
 * would refuse it, rebuilt from the known fields since it refuses any other.
 */
function accepted(
  question: DirectoryDecisionQuestion,
  candidate: DirectoryDecisionCandidate
): DirectoryDecisionCandidate | undefined {
  const { key, field, text, tool, references, annotations } = candidate;
  const fits = (value: unknown, max: number) =>
    typeof value === "string" && value.length <= max && /\S/.test(value);
  // An annotations object with no boolean hint is refused, not emptied.
  const hints = decisionHints(annotations);
  const sent = { tool, references, annotations };
  const ok =
    fits(key, LIMITS.maxKeyChars) &&
    fits(field, LIMITS.maxFieldChars) &&
    fits(text, LIMITS.maxTextChars) &&
    (tool === undefined || fits(tool, LIMITS.maxNameChars)) &&
    (references === undefined ||
      (references.length > 0 &&
        references.length <= LIMITS.maxReferences &&
        references.every((name) => fits(name, LIMITS.maxNameChars)))) &&
    (annotations === undefined || hints !== undefined) &&
    (["tool", "references", "annotations"] as const).every((input) =>
      sent[input] === undefined
        ? question.inputs[input] !== "required"
        : question.inputs[input] !== undefined
    );
  if (!ok) return undefined;
  return {
    key,
    field,
    text,
    ...(tool === undefined ? {} : { tool }),
    ...(references === undefined ? {} : { references: [...references] }),
    ...(hints === undefined ? {} : { annotations: hints }),
  };
}
