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

/** How the persona "left" — the sentiment word, lowercased for prose. */
function feelingWord(persona: PersonaFindingsModel): string {
  return persona.sentiment.tone === "fail"
    ? persona.sentiment.label.toLowerCase()
    : "uneasy";
}

function firstFailingGoal(
  persona: PersonaFindingsModel
): GoalFindingsModel | undefined {
  return persona.goals.find((goal) => goal.diagnosisStage !== null);
}

/** Keep quoted goal titles short enough to sit on one display line. */
export function shortenGoalTitle(title: string, max = 40): string {
  const trimmed = title.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const breakAt = slice.lastIndexOf(" ");
  const base = (breakAt > 16 ? slice.slice(0, breakAt) : slice).trimEnd();
  return `${base}…`;
}

/**
 * Branch order is the contract: broken goals outrank friction outranks
 * landed outranks silence. Lead with one persona; extra failures become a
 * count so the summary card stays a headline, not a report.
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
    let headline = `${lead.name} left ${feelingWord(lead)}. "${title}" broke at ${stage}.`;
    const others = failingPersonas.length - 1;
    if (others > 0) {
      headline += ` ${others} other${others === 1 ? "" : "s"} never landed.`;
    }
    return headline;
  }

  const goals = model.personas.flatMap((persona) => persona.goals);
  const frictionGoals = goals.filter((goal) => goal.sentiment.tone === "warn");
  if (frictionGoals.length > 0) {
    return `No goal broke outright, but ${frictionGoals.length} of ${goals.length} goals showed friction.`;
  }

  if (goals.some((goal) => goal.sentiment.label === "Landed")) {
    return `Every graded goal landed. ${model.sessionCount} sessions, no failures found.`;
  }

  return `No findings yet. ${model.sessionCount} sessions ran; nothing has been graded.`;
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
  if (graded === 0 && total > 0) {
    notes.push("No judge graded these sessions");
  } else if (graded > 0 && graded < total) {
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
