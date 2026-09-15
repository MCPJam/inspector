/**
 * Deterministic summary sentences + honesty footnotes for the Findings card.
 *
 * The summary answers four questions in the reader's order — which goal broke,
 * for whom, where in the value chain, and how it felt. Each answer is returned
 * as its OWN sentence, so each can be asserted on its own; the card joins them
 * into one paragraph at render.
 *
 * A finished run that opens on "No findings yet" reads as a broken product
 * rather than an honest one, so the terminal branch states what the run
 * actually established instead of shrugging. Templates only: the LLM headline (`SwarmWaveInsights.summary`)
 * is a later iteration, and nothing here may claim more than the counts
 * support.
 *
 * Copy rule, inherited from the persona aside: the EXPERIENCE is the subject of
 * every failure verb, never the persona. A persona may FEEL something ("Maya
 * Chen left frustrated"); a persona never fails.
 */

import type { SwarmWaveSignals } from "@/lib/swarm-api";
import {
  JOURNEY_STAGES,
  journeyStageTitle,
  type JourneyStageId,
} from "./journey-stages";
import type {
  GoalFindingsModel,
  PersonaFindingsModel,
  SwarmFindingsModel,
} from "./findings-derivation";

const LINE_MAX_WORDS = 16;
const GOAL_TITLE_MAX_WORDS = 4;

function firstFailingGoal(
  persona: PersonaFindingsModel
): GoalFindingsModel | undefined {
  return persona.goals.find((goal) => goal.diagnosisStage !== null);
}

/**
 * Whether this goal's diagnosis rests on evidence the miner attached to the
 * goal itself. Persona-scoped evidence fans to ALL of a persona's goals, so a
 * stage carrying only that cannot single one out.
 */
function diagnosisIsGoalSpecific(goal: GoalFindingsModel): boolean {
  if (goal.diagnosisStage === null) return false;
  return goal.stages[goal.diagnosisStage].evidence.some(
    (item) => item.tone === "fail" && !item.personaScoped
  );
}

/**
 * The friction equivalent of {@link diagnosisIsGoalSpecific}. A persona-scoped
 * warn detector fans to every goal that persona tried, so it can never say
 * WHICH goal rubbed.
 */
function frictionIsGoalSpecific(
  goal: GoalFindingsModel,
  stage: JourneyStageId
): boolean {
  return goal.stages[stage].evidence.some(
    (item) => item.tone === "warn" && !item.personaScoped
  );
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Per-SENTENCE cap. The card joins these into a paragraph, so this no longer
 * keeps a line from wrapping — it keeps each answer short enough that four of
 * them still read as a summary rather than a report.
 */
export function limitWords(text: string, max = LINE_MAX_WORDS): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return `${words.slice(0, max).join(" ")}…`;
}

/** Keep quoted goal titles to a few words so a line stays scannable. */
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

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/** Detector sentences do not all ship a full stop; the card's do. */
function endWithStop(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * The concrete observation behind a goal's diagnosis. A tool name or rubric
 * label tells the reader more than restating the stage they just read, so the
 * cause line prefers it. Goal-scoped evidence only: persona-scoped evidence
 * fanned to every goal and cannot speak for this one.
 */
function diagnosisCause(goal: GoalFindingsModel): string | null {
  if (goal.diagnosisStage === null) return null;
  const hit = goal.stages[goal.diagnosisStage].evidence.find(
    (item) => item.tone === "fail" && !item.personaScoped
  );
  return hit ? endWithStop(limitWords(firstSentence(hit.observation))) : null;
}

/** Earliest stage on this goal that showed friction without breaking. */
function firstFrictionStage(goal: GoalFindingsModel): JourneyStageId | null {
  for (const stage of JOURNEY_STAGES) {
    if (goal.stages[stage.id].state === "warn") return stage.id;
  }
  return null;
}

/** "Unscored" is not a feeling — say nothing rather than invent one. */
function feelingLine(persona: PersonaFindingsModel): string | null {
  if (persona.sentiment.tone === "muted") return null;
  return `${persona.name} left ${persona.sentiment.label.toLowerCase()}.`;
}

/**
 * Branch order is the contract: broken goals outrank friction, friction
 * outranks landed, landed outranks an ungraded run. Each branch names the
 * goal, the persona, the stage and the feeling — that is the whole point of
 * the card.
 */
export function composeFindingsSummary(
  model: SwarmFindingsModel,
  /** `terminal: null` — a legacy wave with no signals, where neither
   * "finished" nor "still running" can be claimed. */
  opts: { terminal: boolean | null }
): string[] {
  // The cap is applied in one place so no branch can smuggle a long sentence
  // past it — an interpolated persona name does that as easily as a goal title.
  return composeLines(model, opts).map((line) => limitWords(line));
}

function composeLines(
  model: SwarmFindingsModel,
  opts: { terminal: boolean | null }
): string[] {
  const lines: string[] = [];
  const failingPersonas = model.personas.filter(
    (persona) => firstFailingGoal(persona) !== undefined
  );

  if (failingPersonas.length > 0) {
    const lead = failingPersonas[0]!;
    const goal = firstFailingGoal(lead)!;
    const stage = journeyStageTitle(goal.diagnosisStage!).toLowerCase();

    lines.push(
      diagnosisIsGoalSpecific(goal)
        ? `"${shortenGoalTitle(goal.title)}" broke at ${stage} for ${lead.name}.`
        : `The ${stage} stage broke for ${lead.name}.`
    );

    const cause = diagnosisCause(goal);
    if (cause) lines.push(cause);

    // A failing persona usually still has goals that landed, so "did not land
    // either" would overclaim. Only the broken goal is established.
    const others = failingPersonas.slice(1);
    if (others.length === 1) {
      lines.push(`${others[0]!.name} also had a goal that broke.`);
    } else if (others.length > 1) {
      lines.push(
        `${others.length} other personas also had a goal that broke.`
      );
    }

    const feeling = feelingLine(lead);
    if (feeling) lines.push(feeling);
    return lines;
  }

  const goals = model.personas.flatMap((persona) => persona.goals);

  const frictionPersona = model.personas.find((persona) =>
    persona.goals.some((goal) => goal.sentiment.tone === "warn")
  );
  if (frictionPersona) {
    const goal = frictionPersona.goals.find(
      (candidate) => candidate.sentiment.tone === "warn"
    )!;
    const frictionGoals = goals.filter((g) => g.sentiment.tone === "warn");
    // Denominator counts measured goals only — an ungraded goal is not
    // evidence of a goal that held.
    const measuredGoals = goals.filter((g) => g.sentiment.label !== "Unscored");
    lines.push(
      `${frictionGoals.length} of ${measuredGoals.length} goals showed friction. No stage broke outright.`
    );

    // Same rule the broken-goal branch follows: persona-scoped evidence fanned
    // to every one of that persona's goals cannot single one out, so a line
    // built on it stays at persona level.
    const stageId = firstFrictionStage(goal);
    const title = shortenGoalTitle(goal.title);
    if (stageId === null) {
      lines.push(`"${title}" showed friction for ${frictionPersona.name}.`);
    } else {
      const stageWord = journeyStageTitle(stageId).toLowerCase();
      lines.push(
        frictionIsGoalSpecific(goal, stageId)
          ? `"${title}" showed friction at ${stageWord} for ${frictionPersona.name}.`
          : `The ${stageWord} stage showed friction for ${frictionPersona.name}.`
      );
    }

    const feeling = feelingLine(frictionPersona);
    if (feeling) lines.push(feeling);
    return lines;
  }

  const landedGoals = goals.filter((goal) => goal.sentiment.label === "Landed");
  if (landedGoals.length > 0) {
    const personaCount = model.personas.length;
    lines.push("Every graded goal landed.");
    lines.push(
      `${landedGoals.length} goal${
        landedGoals.length === 1 ? "" : "s"
      } across ${personaCount} persona${
        personaCount === 1 ? "" : "s"
      }, and no stage broke.`
    );
    const relieved = model.personas.find(
      (persona) => persona.sentiment.tone === "ok"
    );
    const feeling = relieved ? feelingLine(relieved) : null;
    if (feeling) lines.push(feeling);
    return lines;
  }

  // Nothing was graded. A finished run still owes the reader a statement of
  // what it established — silence here is what made the card read as broken.
  const ungradedCaveat =
    "No goal was scored, so nothing here is evidence that the experience held.";
  if (opts.terminal === true) {
    return ["This run finished with nothing graded.", ungradedCaveat];
  }
  if (opts.terminal === false) {
    return [
      "Nothing graded yet.",
      "This run is still going — findings land as sessions are analyzed.",
    ];
  }
  // Unknown: claim neither ending. The card still says what it knows.
  return ["Nothing has been graded for this run.", ungradedCaveat];
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
  if (signals.truncated) {
    notes.push("Session scan hit its cap — counts cover a subset");
  }
  if (signals.lowConfidence) {
    notes.push("Most sessions are unanalyzed — treat counts as partial");
  }
  return notes;
}
