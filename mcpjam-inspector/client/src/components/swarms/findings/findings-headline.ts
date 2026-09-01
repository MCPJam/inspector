/**
 * Deterministic headline + honesty footnotes for the Findings summary card.
 * Templates only — the LLM headline (`SwarmWaveInsights.summary`) is a later
 * iteration, and nothing here may claim more than the counts support.
 */

import type { SwarmWaveSignals } from "@/lib/swarm-api";
import { journeyStageTitle } from "./journey-stages";
import type {
  GoalFindingsModel,
  PersonaFindingsModel,
  SwarmFindingsModel,
} from "./findings-derivation";

const HEADLINE_MAX_WORDS = 10;
const GOAL_TITLE_MAX_WORDS = 4;

function firstFailingGoal(
  persona: PersonaFindingsModel
): GoalFindingsModel | undefined {
  return persona.goals.find((goal) => goal.diagnosisStage !== null);
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Hard cap — the summary card is a headline, not a paragraph. */
export function limitWords(text: string, max = HEADLINE_MAX_WORDS): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return `${words.slice(0, max).join(" ")}…`;
}

/** Keep quoted goal titles to a few words so the headline stays ≤10. */
export function shortenGoalTitle(
  title: string,
  maxWords = GOAL_TITLE_MAX_WORDS
): string {
  const words = title
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * Branch order is the contract: broken goals outrank friction outranks
 * landed outranks silence. Persona names stay off the line — they blow
 * the 10-word cap. Extra failures become a count.
 */
export function composeFindingsHeadline(model: SwarmFindingsModel): string {
  const failingPersonas = model.personas.filter(
    (persona) => firstFailingGoal(persona) !== undefined
  );

  if (failingPersonas.length > 0) {
    const lead = failingPersonas[0]!;
    const goal = firstFailingGoal(lead)!;
    const stage = journeyStageTitle(goal.diagnosisStage!).toLowerCase();
    const title = shortenGoalTitle(goal.title);
    const others = failingPersonas.length - 1;
    const headline =
      others > 0
        ? `"${title}" broke at ${stage}. ${failingPersonas.length} stalled.`
        : `"${title}" broke at ${stage}.`;
    return limitWords(headline);
  }

  const goals = model.personas.flatMap((persona) => persona.goals);
  const frictionGoals = goals.filter((goal) => goal.sentiment.tone === "warn");
  if (frictionGoals.length > 0) {
    return limitWords(
      `${frictionGoals.length} of ${goals.length} goals showed friction.`
    );
  }

  if (goals.some((goal) => goal.sentiment.label === "Landed")) {
    return "Every graded goal landed.";
  }

  return "No findings yet.";
}

/**
 * Honesty footnotes — chips on the summary card, NEVER rubric rows. Each one
 * names a way the counts above could understate reality.
 */
export function deriveHonestyFootnotes(args: {
  signals: SwarmWaveSignals | null | undefined;
  /** Whether the wave carries a durable `swarmRunGroupId`. */
  hasGroupId: boolean;
}): string[] {
  const { signals, hasGroupId } = args;
  if (!signals || !hasGroupId) {
    // Legacy wave (or a backend that has not answered): the deterministic
    // detector lane never ran, so the tab is rubric findings only.
    return [
      "Rubric findings only — deterministic signals unavailable for this wave",
    ];
  }
  const notes: string[] = [];
  if (!signals.terminal) {
    notes.push("This swarm is still running — findings may change");
  }
  const { graded, total } = signals.judgeCoverage;
  if (graded > 0 && graded < total) {
    notes.push(`Judge covered ${graded} of ${total} sessions`);
  }
  if (signals.truncated) {
    notes.push("Session scan hit its cap — counts cover a subset");
  }
  if (signals.lowConfidence) {
    notes.push("Most sessions are unanalyzed — treat counts as partial");
  }
  return notes;
}
