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

import {
  SWARM_FINDING_COVERAGE_NOTE_LABELS,
  SWARM_FINDING_SIGNAL_LABELS,
  type SwarmJourneyFinding,
  type SwarmJourneyFindings,
} from "@mcpjam/sdk/contract";
import type { SwarmWaveSignals } from "@/lib/swarm-api";
import {
  JOURNEY_STAGES,
  JOURNEY_STAGE_BY_CHAIN,
  journeyStageTitle,
  type JourneyStageId,
} from "./journey-stages";
import {
  selectLeadWireMechanism,
  wireSignalTotals,
  type GoalFindingsModel,
  type LaunchTotals,
  type PersonaFindingsModel,
  type SwarmFindingsModel,
} from "./findings-derivation";

const LINE_MAX_WORDS = 16;
const GOAL_TITLE_MAX_WORDS = 4;

function firstFailingGoal(
  persona: PersonaFindingsModel,
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
    (item) => item.tone === "fail" && !item.personaScoped,
  );
}

/**
 * The friction equivalent of {@link diagnosisIsGoalSpecific}. A persona-scoped
 * warn detector fans to every goal that persona tried, so it can never say
 * WHICH goal rubbed.
 */
function frictionIsGoalSpecific(
  goal: GoalFindingsModel,
  stage: JourneyStageId,
): boolean {
  return goal.stages[stage].evidence.some(
    (item) => item.tone === "warn" && !item.personaScoped,
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Per-SENTENCE cap. The card joins these into a paragraph, so this no longer
 * keeps a line from wrapping — it keeps each answer short enough that four of
 * them still read as a summary rather than a report.
 */
export function limitWords(text: string, max = LINE_MAX_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return `${words.slice(0, max).join(" ")}…`;
}

/** Keep quoted goal titles to a few words so a line stays scannable. */
export function shortenGoalTitle(
  title: string,
  maxWords = GOAL_TITLE_MAX_WORDS,
): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * Lane A's wave summary, only when a model actually narrated something.
 *
 * A wave with no mined candidates completes WITHOUT calling a model: the
 * backend stores fixed prose ("No anomalies concentrated along any dimension
 * of this wave.") with `candidates: []`. Promoted to the headline, that prose
 * replaced a deterministic summary saying every graded session failed. Gate on
 * `candidates`, never on the sentence, which will be reworded.
 */
export function narratedWaveSummary(
  status: string | null | undefined,
  insights:
    | { summary?: string | null; candidates?: readonly unknown[] | null }
    | null
    | undefined,
): string | null {
  if (status !== "completed" || !insights) return null;
  if ((insights.candidates?.length ?? 0) === 0) return null;
  return insights.summary?.trim() || null;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/**
 * Lane A's narration, cut to something a card can carry.
 *
 * The backend stores it `.slice(0, SUMMARY_MAX)` — a hard character cut that
 * lands mid-word ("…and rejects host"), so the raw string cannot be rendered
 * as prose. Taking the FIRST SENTENCE sidesteps that: the truncation is almost
 * always in a later one. A narration with no sentence boundary at all was cut
 * inside its first, and gets an ellipsis so it never reads as a finished
 * thought.
 */
export function clampNarration(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return null;
  const sentence = firstSentence(trimmed);
  if (/[.!?]$/.test(sentence)) return sentence;
  return `${sentence.replace(/[\s,;:]+$/, "")}…`;
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
    (item) => item.tone === "fail" && !item.personaScoped,
  );
  return hit ? endWithStop(limitWords(firstSentence(hit.observation))) : null;
}

/**
 * Earliest stage on this goal that showed friction without breaking.
 *
 * Connection is skipped for the reason the derivation skips it everywhere that
 * aggregates: a launch failure is reporting, not friction in the experience.
 * Naming it here is what produced "showed friction at connection" for a wave
 * whose sessions never started.
 */
function firstFrictionStage(goal: GoalFindingsModel): JourneyStageId | null {
  for (const stage of JOURNEY_STAGES) {
    if (stage.id === "connection") continue;
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
 * Which branch spoke. The caller needs this to decide whether a generated
 * summary may replace the template: `not_launched` is the one answer no model
 * can improve on, because there is no session for a model to have read.
 */
export type FindingsSummaryKind =
  | "not_launched"
  | "broken"
  | "friction"
  | "landed"
  | "ungraded"
  | "unread";

export interface FindingsSummary {
  lines: string[];
  kind: FindingsSummaryKind;
}

/**
 * Branch order is the contract: a wave that never launched outranks
 * everything, then broken goals, then friction, then landed, then an ungraded
 * run. Each branch names the goal, the persona, the stage and the feeling —
 * that is the whole point of the card.
 */
export function composeFindingsSummary(
  model: SwarmFindingsModel,
  /** `terminal: null` — a legacy wave with no signals, where neither
   * "finished" nor "still running" can be claimed. */
  opts: { terminal: boolean | null },
): FindingsSummary {
  const composed = composeLines(model, opts);
  // The cap is applied in one place so no branch can smuggle a long sentence
  // past it — an interpolated persona name does that as easily as a goal title.
  return {
    lines: composed.lines.map((line) => limitWords(line)),
    kind: composed.kind,
  };
}

function composeLines(
  model: SwarmFindingsModel,
  opts: { terminal: boolean | null },
): FindingsSummary {
  const lines: string[] = [];

  // ── Nothing launched ──────────────────────────────────────────────────────
  //
  // Every session of a settled wave failed to launch. The goals were never
  // tried, so no count over them means anything: this used to fall through to
  // the friction branch and report "9 of 9 goals showed friction" about an
  // experience nobody ever had. Launch outcomes are reporting, and this is the
  // one place the summary reports them.
  // The launch-failure EVIDENCE is required, not just the absence of success:
  // a settled wave with no successes and no failures has sessions that never
  // resolved, which is an ungraded run, not a wave that failed to connect.
  const { launch } = model;
  if (
    opts.terminal === true &&
    launch.total > 0 &&
    model.neverLaunched === true
  ) {
    if (launch.failed > 0) {
      lines.push(
        `${launch.failed} of ${plural(
          launch.total,
          "session",
        )} failed to launch.`,
      );
    }
    if (launch.rateLimited > 0) {
      lines.push(`${plural(launch.rateLimited, "session")} were rate limited.`);
    }
    lines.push("Nothing about the server was tested.");
    // No feeling line: nothing happened to anyone.
    return { lines, kind: "not_launched" };
  }

  const failingPersonas = model.personas.filter(
    (persona) => firstFailingGoal(persona) !== undefined,
  );

  if (failingPersonas.length > 0) {
    const lead = failingPersonas[0]!;
    const goal = firstFailingGoal(lead)!;
    const stage = journeyStageTitle(goal.diagnosisStage!).toLowerCase();

    lines.push(
      diagnosisIsGoalSpecific(goal)
        ? `"${shortenGoalTitle(goal.title)}" broke at ${stage} for ${
            lead.name
          }.`
        : `The ${stage} stage broke for ${lead.name}.`,
    );

    const cause = diagnosisCause(goal);
    if (cause) lines.push(cause);

    // A failing persona usually still has goals that landed, so "did not land
    // either" would overclaim. Only the broken goal is established.
    const others = failingPersonas.slice(1);
    if (others.length === 1) {
      lines.push(`${others[0]!.name} also had a goal that broke.`);
    } else if (others.length > 1) {
      lines.push(`${others.length} other personas also had a goal that broke.`);
    }

    const feeling = feelingLine(lead);
    if (feeling) lines.push(feeling);
    return { lines, kind: "broken" };
  }

  const goals = model.personas.flatMap((persona) => persona.goals);

  const frictionPersona = model.personas.find((persona) =>
    persona.goals.some((goal) => goal.sentiment.tone === "warn"),
  );
  if (frictionPersona) {
    const goal = frictionPersona.goals.find(
      (candidate) => candidate.sentiment.tone === "warn",
    )!;
    const frictionGoals = goals.filter((g) => g.sentiment.tone === "warn");
    // Denominator counts measured goals only — an ungraded goal is not
    // evidence of a goal that held, and neither is one that never launched.
    // Filtered on the TONE, not the label: "Unscored" and "Not run" are both
    // muted, and a label test silently counted the untried ones.
    const measuredGoals = goals.filter((g) => g.sentiment.tone !== "muted");
    lines.push(
      `${frictionGoals.length} of ${measuredGoals.length} goals showed friction. No stage broke outright.`,
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
          : `The ${stageWord} stage showed friction for ${frictionPersona.name}.`,
      );
    }

    const feeling = feelingLine(frictionPersona);
    if (feeling) lines.push(feeling);
    return { lines, kind: "friction" };
  }

  // Tone, not the label: the legacy derivation says "Landed" and the shared
  // contract says "Relieved" for the same met goal.
  const landedGoals = goals.filter((goal) => goal.sentiment.tone === "ok");
  if (landedGoals.length > 0) {
    const personaCount = model.personas.length;
    lines.push("Every graded goal landed.");
    lines.push(
      `${landedGoals.length} goal${
        landedGoals.length === 1 ? "" : "s"
      } across ${personaCount} persona${
        personaCount === 1 ? "" : "s"
      }, and no stage broke.`,
    );
    const relieved = model.personas.find(
      (persona) => persona.sentiment.tone === "ok",
    );
    const feeling = relieved ? feelingLine(relieved) : null;
    if (feeling) lines.push(feeling);
    return { lines, kind: "landed" };
  }

  // Nothing was graded. A finished run still owes the reader a statement of
  // what it established — silence here is what made the card read as broken.
  const ungradedCaveat =
    "No goal was scored, so nothing here is evidence that the experience held.";
  if (opts.terminal === true) {
    return {
      lines: ["This run finished with nothing graded.", ungradedCaveat],
      kind: "ungraded",
    };
  }
  if (opts.terminal === false) {
    return {
      lines: [
        "Nothing graded yet.",
        "This run is still going. Findings land as sessions are analyzed.",
      ],
      kind: "ungraded",
    };
  }
  // Unknown: claim neither ending. The card still says what it knows.
  return {
    lines: ["Nothing has been graded for this run.", ungradedCaveat],
    kind: "ungraded",
  };
}

/**
 * Honesty footnotes — chips on the summary card, NEVER rubric rows. Each one
 * names a way the counts above could understate reality.
 */
export function deriveHonestyFootnotes(args: {
  signals: SwarmWaveSignals | null | undefined;
  /** Whether the wave carries a durable `swarmRunGroupId`. */
  hasGroupId: boolean;
  /** Wave launch outcomes. Absent on callers that predate the launch chips. */
  launch?: LaunchTotals;
  narration?: SwarmNarration;
}): string[] {
  const { signals, hasGroupId, launch } = args;
  const notes: string[] = [];
  if (args.narration?.modelRan === false)
    notes.push(
      `No model narration, ${Math.max(
        0,
        args.narration.sessionCount - args.narration.unanalyzedSessionCount,
      )} of ${
        args.narration.sessionCount
      } sessions covered by deterministic checks only`,
    );
  if (!signals || !hasGroupId) {
    // Legacy wave (or a backend that has not answered): the deterministic
    // detector lane never ran, so the tab is rubric findings only.
    notes.push(
      "Evaluator findings only — deterministic signals unavailable for this wave",
    );
  } else {
    if (!signals.terminal) {
      notes.push("This swarm is still running — findings may change");
    }
    if (signals.truncated) {
      notes.push("Session scan hit its cap — counts cover a subset");
    }
    if (signals.lowConfidence) {
      notes.push("Most sessions are unanalyzed — treat counts as partial");
    }
  }
  // Partial launch. Failed-to-launch counts used to chip here; they repeated
  // the header tally and are gone. Rate-limits stay — those do not already
  // have a sentence on the card.
  if (launch && launch.succeeded > 0 && launch.rateLimited > 0) {
    notes.push(`${plural(launch.rateLimited, "session")} rate limited`);
  }
  return notes;
}

export type SwarmNarration = {
  modelRan: boolean;
  sessionCount: number;
  unanalyzedSessionCount: number;
};
/**
 * What the footnote needs to know about Lane A. `modelRan` uses the SAME gate
 * as {@link narratedWaveSummary}, so the headline and the footnote can never
 * disagree about whether a model wrote anything. Undefined until the analysis
 * completes: a pending or failed analysis is not evidence that no model ran.
 */
export function waveNarration(
  status: string | null | undefined,
  insights:
    | {
        summary?: string | null;
        candidates?: readonly unknown[] | null;
        sessionCount?: number;
        unanalyzedSessionCount?: number;
      }
    | null
    | undefined,
): SwarmNarration | undefined {
  if (status !== "completed" || !insights) return undefined;
  return {
    modelRan: narratedWaveSummary(status, insights) !== null,
    sessionCount: insights.sessionCount ?? 0,
    unanalyzedSessionCount: insights.unanalyzedSessionCount ?? 0,
  };
}
const WIRE_SUMMARY_KIND: Record<
  SwarmJourneyFindings["summaryKind"],
  FindingsSummaryKind
> = {
  notLaunched: "not_launched",
  broken: "broken",
  friction: "friction",
  landed: "landed",
  ungraded: "ungraded",
  unread: "unread",
};

function genericWireLine(wire: SwarmJourneyFindings): string {
  switch (wire.summaryKind) {
    case "notLaunched":
      return "No sessions launched.";
    case "broken":
      return "Some goals were blocked.";
    case "friction":
      return "Goals were met with friction.";
    case "landed":
      return "The measured goals were met.";
    case "ungraded":
      return "No graded outcome is available.";
    case "unread":
      return `${wire.population.read} of ${wire.population.started} sessions were read.`;
  }
}

/**
 * The summary for a run the shared findings pipeline published. The KIND is
 * the producer's; the SENTENCES come from the same composer the legacy path
 * uses, fed the wire-derived model, so both paths name the goal, the persona
 * and the stage. When that composer lands on a different kind (a blocked goal
 * the chain never located, say) the goal and persona are still named from the
 * wire, and only a model with no personas falls back to a generic sentence.
 */
/**
 * How a stage is worded depends on how it was ESTABLISHED. A stage the chain
 * worker measured is reported as measured; a stage a model merely pointed at
 * is reported as a reading. Saying "recorded at" for a model's guess would
 * dress an opinion as a measurement.
 */
function stageLine(
  chainStage: SwarmJourneyFinding["chainStage"],
  basis: SwarmJourneyFinding["chainStageBasis"],
): string | null {
  if (!chainStage || basis === "unmeasured") return null;
  const stage = journeyStageTitle(
    JOURNEY_STAGE_BY_CHAIN[chainStage],
  ).toLowerCase();
  return basis === "derived"
    ? `Recorded at the ${stage} stage.`
    : `The explanation points at the ${stage}.`;
}

/** "in N of M sessions read", plus the goal span when the cause crosses goals. */
function populationClause(count: number, read: number, goals: number): string {
  const across = goals > 1 ? ` across ${goals} goals` : "";
  return ` in ${count} of ${read} sessions read${across}`;
}

/**
 * Which goal and whose, for a cause that may span several of both.
 *
 * Chosen by reach and then by id, never by position: the rows of one mechanism
 * arrive in whatever order the producer listed them, and naming `rows[0]`'s
 * goal let a reordered but identical payload name a different one.
 */
function personaGoalLine(rows: readonly SwarmJourneyFinding[]): string | null {
  const byGoal = new Map<string, { title: string; sessions: Set<string> }>();
  for (const row of rows) {
    const entry = byGoal.get(row.goal.runId) ?? {
      title: row.goal.title,
      sessions: new Set<string>(),
    };
    for (const id of row.sessionIds) entry.sessions.add(id);
    byGoal.set(row.goal.runId, entry);
  }
  const lead = [...byGoal.entries()].sort(
    ([aId, a], [bId, b]) =>
      b.sessions.size - a.sessions.size || aId.localeCompare(bId),
  )[0];
  if (!lead) return null;
  // The FULL title. `shortenGoalTitle` cuts to four words, which turns most
  // real goals into an ellipsis and tells the reader nothing.
  //
  // Only the personas who actually had THIS goal. One mechanism can span
  // non-cartesian pairs -- Zoe on goal A, Amy on goal B -- and naming every
  // persona on the lead goal's title told the reader Amy tried a goal she was
  // never given. How far the cause reaches is the population clause's job.
  const names = [
    ...new Set(
      rows
        .filter((row) => row.goal.runId === lead[0])
        .map((row) => row.persona.name),
    ),
  ].sort();
  const who =
    names.length > 1
      ? `${names[0]} and ${plural(names.length - 1, "other persona")}`
      : names[0];
  return `"${shortenGoalTitle(lead[1].title, 12)}" for ${who}.`;
}

/**
 * The summary for a run the shared findings pipeline published.
 *
 * Built from the ROWS, not delegated to the legacy composer: that composer
 * takes its stage from whichever stage the chain marked failed and its title
 * from a four-word truncation, so a verified cause could be named on the wire
 * and still reach the card as "the judge said no" about `"They want to quic…"`.
 */
export function composeWireFindingsSummary(
  wire: SwarmJourneyFindings,
  model: SwarmFindingsModel,
  opts: { terminal: boolean | null },
): FindingsSummary {
  const kind = WIRE_SUMMARY_KIND[wire.summaryKind];
  // Unread: the counts ARE the finding. The coverage notes ride as footnotes.
  if (kind === "unread" || model.personas.length === 0) {
    return { kind, lines: [genericWireLine(wire)] };
  }
  const lead = selectLeadWireMechanism(wire);
  if (lead?.mechanismPhrase) {
    const phrase = lead.mechanismPhrase.replace(/[.!?]+$/, "");
    const lines = [
      `${phrase}${populationClause(
        lead.sessionCount,
        wire.population.read,
        lead.goalRunIds.length,
      )}.`,
    ];
    const stage = stageLine(lead.chainStage, lead.chainStageBasis);
    if (stage) lines.push(stage);
    const persona = personaGoalLine(lead.rows);
    if (persona) lines.push(persona);
    return { kind, lines };
  }
  // No confirmed cause, but something WAS recorded. This is the honest floor:
  // the wave says what was observed rather than shrugging.
  const signals = wireSignalTotals(wire);
  const signal = signals[0];
  if (signal) {
    const lines = [
      `${SWARM_FINDING_SIGNAL_LABELS[signal.signal]} in ${signal.count} of ${
        wire.population.read
      } sessions read.`,
    ];
    const persona = personaGoalLine(
      wire.findings.filter((row) => row.signal === signal.signal),
    );
    if (persona) lines.push(persona);
    return { kind, lines };
  }
  const composed = composeFindingsSummary(model, {
    terminal: kind === "not_launched" ? true : opts.terminal,
  });
  if (composed.kind === kind) return composed;
  if (kind === "broken" || kind === "friction") {
    const tone = kind === "broken" ? "fail" : "warn";
    for (const persona of model.personas) {
      const goal = persona.goals.find((g) => g.sentiment.tone === tone);
      if (!goal) continue;
      const lines = [
        kind === "broken"
          ? `"${shortenGoalTitle(goal.title, 12)}" broke for ${persona.name}.`
          : `"${shortenGoalTitle(goal.title, 12)}" showed friction for ${
              persona.name
            }.`,
      ];
      const feeling = feelingLine(persona);
      if (feeling) lines.push(feeling);
      return { kind, lines };
    }
  }
  return { kind, lines: [genericWireLine(wire)] };
}

export function wireFindingsFootnotes(wire: SwarmJourneyFindings): string[] {
  const notes = wire.coverageNotes.map(
    (note) => SWARM_FINDING_COVERAGE_NOTE_LABELS[note],
  );
  const verification = wire.verification;
  if (!verification) return notes;
  // Only proposals that were LOOKED AT and did not hold. An empty reply, an
  // unavailable model and a publication cap are none of them a rejected cause.
  if (verification.rejected > 0)
    notes.push(
      `${plural(verification.rejected, "possible cause")} ${
        verification.rejected === 1 ? "was" : "were"
      } rejected.`,
    );
  if (verification.unverified > 0)
    notes.push(
      `${plural(
        verification.unverified,
        "possible cause",
      )} could not be verified.`,
    );
  return notes;
}
