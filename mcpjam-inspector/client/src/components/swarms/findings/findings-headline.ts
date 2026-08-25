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

/** First failure evidence on the goal's diagnosis stage, for the headline. */
function diagnosisEvidence(goal: GoalFindingsModel): string | null {
  if (!goal.diagnosisStage) return null;
  const failing = goal.stages[goal.diagnosisStage].evidence.find(
    (e) => e.tone === "fail"
  );
  return failing?.observation ?? null;
}

/**
 * Branch order is the contract: broken goals outrank friction outranks
 * landed outranks silence. The experience is the failure's subject — the
 * persona only ever "left" with a feeling.
 */
export function composeFindingsHeadline(model: SwarmFindingsModel): string {
  const failingPersonas = model.personas.filter(
    (persona) => firstFailingGoal(persona) !== undefined
  );

  if (failingPersonas.length > 0) {
    return failingPersonas
      .slice(0, 2)
      .map((persona) => {
        const goal = firstFailingGoal(persona)!;
        const stage = journeyStageTitle(goal.diagnosisStage!).toLowerCase();
        const evidence = diagnosisEvidence(goal);
        const broke = evidence
          ? `${persona.name}'s "${goal.title}" broke at ${stage} — ${evidence}.`
          : `${persona.name}'s "${goal.title}" broke at ${stage}.`;
        return `${broke} They left ${feelingWord(persona)}.`;
      })
      .join(" ");
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
