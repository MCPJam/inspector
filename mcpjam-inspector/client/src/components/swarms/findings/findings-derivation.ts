/**
 * Pure derivation of the Findings tab model — personas → goals → 6-stage
 * tones + evidence — from data the swarm detail page ALREADY holds. No
 * queries, no LLM lanes: every sentence here is a deterministic template over
 * backend counts, and the copy rules of the Overview panel apply throughout
 * (graded/slice denominators only, absent is unknown, never 0%).
 *
 * "ok" is earned, never inferred: a stage is green only when positive
 * evidence landed on it (all sessions launched, every graded session
 * passed). Silence renders as "none" — the legend says "do not infer pass".
 */

import type {
  SwarmOverviewRun,
  SwarmWaveDetectorId,
  SwarmWaveSignalCandidate,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import { signalSentence } from "@/components/shared/usage-insights/run-insights";
import {
  findingName,
  findingSeverity,
  findingSessionLabel,
  waveSessionTotals,
} from "@/components/swarms/swarm-overview-panel";
import {
  JOURNEY_STAGES,
  journeyStageIndex,
  journeyStageTitle,
  type JourneyStageId,
} from "./journey-stages";

// ── Model ───────────────────────────────────────────────────────────────────

export type StageTone = "fail" | "warn" | "ok";
/** A stage with no evidence is `none` — rendered as unknown, never as pass. */
export type StageState = StageTone | "none";

export type SentimentTone = "fail" | "warn" | "ok" | "muted";

export interface SentimentPillModel {
  label: string;
  tone: SentimentTone;
}

/**
 * Which sessions a piece of evidence implicates.
 *
 * Carried by the evidence rather than inferred by the panel from its goal: a
 * goal-scoped list renders the same rows under all six stages, and puts a
 * count beside them that disagrees with the evidence's own denominator.
 */
export type EvidenceSessions =
  /** Nothing to open — a launch failure has no transcript, a pass no exemplar. */
  | { kind: "none" }
  /** Sessions in this run carrying a failing verdict for this criterion. */
  | { kind: "criterion"; criterionId: string }
  /** Sessions in this run whose goal-completion grade came back failed. */
  | { kind: "goalScoreFail" }
  /**
   * Sessions the miner named, worst-first. The list is BOUNDED, so `affected`
   * may exceed `ids.length` — a label over these has to admit the sample.
   * Persona-scoped candidates fan across a persona's runs, so an id here is
   * not guaranteed to belong to the goal being inspected.
   */
  | { kind: "ids"; ids: string[]; affected: number };

export interface StageEvidence {
  tone: StageTone;
  /** Deterministic sentence — detector phrasing reuses `signalSentence`. */
  observation: string;
  /** Denominator line ("2 of 3 sessions") or the launch-outcome caveat. */
  meta: string;
  /** Evidence fanned from a persona-scoped detector, not this goal's slice. */
  personaScoped?: boolean;
  /** The sessions this row can open. Required: silence here would list a goal. */
  sessions: EvidenceSessions;
}

/**
 * "3 shown" when the named ids are a sample of a larger affected set, else
 * null. Without it a bounded exemplar list sits under a claim of 12.
 */
export function evidenceSampleNote(sessions: EvidenceSessions): string | null {
  if (sessions.kind !== "ids") return null;
  if (sessions.ids.length === 0) return null;
  if (sessions.ids.length >= sessions.affected) return null;
  return `${sessions.ids.length} shown`;
}

export interface GoalStageModel {
  state: StageState;
  evidence: StageEvidence[];
}

export interface GoalFindingsModel {
  journeyRefId: string;
  runId: string;
  title: string;
  sessions: number;
  sentiment: SentimentPillModel;
  stages: Record<JourneyStageId, GoalStageModel>;
  /** Earliest stage with failure evidence, else null. */
  diagnosisStage: JourneyStageId | null;
  diagnosis: { title: string; detail: string };
  /** Stage to select when the goal expands. */
  defaultStage: JourneyStageId;
}

export interface PersonaFindingsModel {
  name: string;
  role?: string;
  /** Avatar identity: persona `_id` when the doc matched, else the name. */
  avatarSeed: string;
  avatarShape?: number;
  avatarPalette?: number;
  sessionsAuthored: number;
  sentiment: SentimentPillModel;
  /** Experience-blaming one-liner — the persona is never the failure's subject. */
  issue: string;
  goals: GoalFindingsModel[];
}

export interface SwarmFindingsModel {
  personas: PersonaFindingsModel[];
  /** Headline denominator — `waveSignals.sessionCount`, else wave totals. */
  sessionCount: number;
  /** First persona with a failing goal, else 0 — the default selected tab. */
  defaultPersonaIndex: number;
}

// ── Detector → stage attribution ────────────────────────────────────────────

/**
 * Exhaustive over `SwarmWaveDetectorId` ON PURPOSE: a new detector fails the
 * typecheck here until someone decides which stage its evidence lands on.
 * Detectors never map to "ok" — a mined anomaly is trouble by construction.
 */
export const DETECTOR_STAGE_MAP: Record<
  SwarmWaveDetectorId,
  { stage: JourneyStageId; tone: Exclude<StageTone, "ok"> }
> = {
  hallucinated_tool: { stage: "discovery", tone: "fail" },
  no_tools_used: { stage: "selection", tone: "warn" },
  tool_errors: { stage: "response", tone: "fail" },
  target_failures: { stage: "response", tone: "fail" },
  error_recovered_pass: { stage: "response", tone: "warn" },
  latency_outlier: { stage: "response", tone: "warn" },
  criterion_fail: { stage: "value", tone: "fail" },
  marginal_pass: { stage: "value", tone: "warn" },
  turn_cap_grind: { stage: "value", tone: "warn" },
  token_outlier: { stage: "value", tone: "warn" },
  persona_struggles: { stage: "value", tone: "warn" },
};

const TONE_RANK: Record<StageTone, number> = { fail: 2, warn: 1, ok: 0 };
const DEMO_SENTIMENTS: SentimentPillModel[] = [
  { label: "Stalled", tone: "fail" },
  { label: "Landed", tone: "ok" },
  { label: "On Track", tone: "ok" },
  { label: "Relieved", tone: "ok" },
  { label: "Frustrated", tone: "fail" },
  { label: "Lost", tone: "fail" },
];

function worstTone(evidence: readonly StageEvidence[]): StageState {
  if (evidence.length === 0) return "none";
  return evidence.reduce<StageTone>(
    (worst, e) => (TONE_RANK[e.tone] > TONE_RANK[worst] ? e.tone : worst),
    "ok"
  );
}

function emptyStages(): Record<JourneyStageId, StageEvidence[]> {
  return {
    connection: [],
    discovery: [],
    selection: [],
    call: [],
    response: [],
    value: [],
  };
}

const TERMINAL_EXCLUDED = new Set(["running", "pending"]);

function runIsTerminal(run: SwarmOverviewRun): boolean {
  return !TERMINAL_EXCLUDED.has(run.status);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The launch-outcome caveat every connection row carries, verbatim. */
export const CONNECTION_CAVEAT =
  "Launch outcomes — not a finding about the server";

// ── Per-goal evidence ───────────────────────────────────────────────────────

function connectionEvidence(run: SwarmOverviewRun): StageEvidence | null {
  const { total, succeeded, failed, rateLimited } = run.summary;
  if (failed > 0 || rateLimited > 0) {
    const parts: string[] = [];
    if (failed > 0) {
      parts.push(`${failed} of ${plural(total, "session")} failed to launch`);
    }
    if (rateLimited > 0) {
      parts.push(`${rateLimited} rate limited`);
    }
    return {
      tone: "warn",
      observation: parts.join(", "),
      meta: CONNECTION_CAVEAT,
      // A session that never launched has no transcript to open, and the
      // ones that did launch are not evidence for this row.
      sessions: { kind: "none" },
    };
  }
  if (runIsTerminal(run) && total > 0 && succeeded === total) {
    return {
      tone: "ok",
      observation: `All ${plural(total, "session")} launched`,
      meta: CONNECTION_CAVEAT,
      sessions: { kind: "none" },
    };
  }
  return null;
}

function rubricEvidence(run: SwarmOverviewRun): StageEvidence[] {
  return run.findings.map((finding) => ({
    tone: findingSeverity(finding) === "blocking" ? "fail" : ("warn" as const),
    observation: `Rubric check "${findingName(finding)}" failed`,
    meta: findingSessionLabel(finding),
    sessions: { kind: "criterion", criterionId: finding.criterionId },
  }));
}

function judgeEvidence(run: SwarmOverviewRun): StageEvidence | null {
  const rollup = run.goalScoreSummary;
  // A zero graded count contributes NOTHING — absent is unknown, never ok.
  if (!rollup || rollup.gradedCount <= 0) return null;
  const { gradedCount, passedCount } = rollup;
  if (passedCount >= gradedCount) {
    return {
      tone: "ok",
      observation: "Goal completion passed for every graded session",
      meta: `${passedCount} of ${plural(gradedCount, "graded session")}`,
      // A pass has no exemplar. Listing the sessions that passed would
      // invite reading the list as the finding.
      sessions: { kind: "none" },
    };
  }
  const missed = gradedCount - passedCount;
  return {
    tone: passedCount / gradedCount < 0.5 ? "fail" : "warn",
    observation: `Goal completion missed in ${plural(
      missed,
      "graded session"
    )}`,
    meta: `${missed} of ${plural(gradedCount, "graded session")}`,
    sessions: { kind: "goalScoreFail" },
  };
}

function detectorEvidence(
  candidate: SwarmWaveSignalCandidate,
  opts: { personaScoped: boolean }
): { stage: JourneyStageId; evidence: StageEvidence } | null {
  // Guard beyond the type: a newer server may mine detectors this build has
  // no id for, and an unmapped one has no stage to land on.
  const mapping = DETECTOR_STAGE_MAP[candidate.detector];
  if (!mapping) return null;
  return {
    stage: mapping.stage,
    evidence: {
      tone: mapping.tone,
      observation: signalSentence(candidate),
      meta: `${candidate.affectedSessions} of ${plural(
        candidate.sliceTotal,
        "session"
      )}${opts.personaScoped ? " · persona-scoped" : ""}`,
      ...(opts.personaScoped ? { personaScoped: true } : {}),
      sessions: {
        kind: "ids",
        ids: candidate.exemplarSessionIds,
        affected: candidate.affectedSessions,
      },
    },
  };
}

// ── Sentiment + diagnosis ───────────────────────────────────────────────────

function goalSentiment(
  stages: Record<JourneyStageId, GoalStageModel>,
  demoVariant = false,
  variantIndex = 0
): SentimentPillModel {
  const states = JOURNEY_STAGES.map((s) => stages[s.id].state);
  if (states.includes("fail")) {
    return demoVariant
      ? DEMO_SENTIMENTS[variantIndex % DEMO_SENTIMENTS.length]!
      : { label: "Stalled", tone: "fail" };
  }
  if (states.includes("warn")) return { label: "Uneasy", tone: "warn" };
  if (stages.value.state === "ok") return { label: "Landed", tone: "ok" };
  return { label: "Unscored", tone: "muted" };
}

/** Feeling word for the EARLIEST failing stage across a persona's goals. */
const FAIL_STAGE_SENTIMENT: Record<JourneyStageId, string> = {
  connection: "Stuck",
  discovery: "Lost",
  selection: "Lost",
  call: "Annoyed",
  response: "Frustrated",
  value: "Stalled",
};

function personaSentiment(
  goals: readonly GoalFindingsModel[],
  demoVariant = false,
  variantIndex = 0
): SentimentPillModel {
  let earliestFail: JourneyStageId | null = null;
  let sawWarn = false;
  let sawLanded = false;
  for (const goal of goals) {
    for (const stage of JOURNEY_STAGES) {
      const state = goal.stages[stage.id].state;
      if (state === "fail") {
        if (
          earliestFail === null ||
          journeyStageIndex(stage.id) < journeyStageIndex(earliestFail)
        ) {
          earliestFail = stage.id;
        }
      } else if (state === "warn") {
        sawWarn = true;
      }
    }
    if (goal.sentiment.label === "Landed") sawLanded = true;
  }
  if (earliestFail) {
    return demoVariant
      ? DEMO_SENTIMENTS[variantIndex % DEMO_SENTIMENTS.length]!
      : { label: FAIL_STAGE_SENTIMENT[earliestFail], tone: "fail" };
  }
  if (sawWarn) return { label: "Uneasy", tone: "warn" };
  if (sawLanded) return { label: "Relieved", tone: "ok" };
  return { label: "Unscored", tone: "muted" };
}

function goalDiagnosis(stages: Record<JourneyStageId, GoalStageModel>): {
  diagnosisStage: JourneyStageId | null;
  diagnosis: { title: string; detail: string };
} {
  for (const stage of JOURNEY_STAGES) {
    if (stages[stage.id].state === "fail") {
      return {
        diagnosisStage: stage.id,
        diagnosis: {
          title: stage.title,
          detail: `${stage.title} is the earliest stage with failure evidence for this goal.`,
        },
      };
    }
  }
  // Launch outcomes are not a finding about the server (CONNECTION_CAVEAT),
  // so a successful launch alone never earns "Landed" — it is not grading.
  const gradedStages = JOURNEY_STAGES.filter(
    (stage) => stage.id !== "connection" && stages[stage.id].state !== "none"
  );
  if (gradedStages.length > 0) {
    const sawWarn = gradedStages.some(
      (stage) => stages[stage.id].state === "warn"
    );
    return {
      diagnosisStage: null,
      diagnosis: sawWarn
        ? {
            title: "Friction",
            detail:
              "No stage broke outright, but at least one measured stage showed friction.",
          }
        : {
            title: "Landed",
            detail: "Every measured stage held for this goal.",
          },
    };
  }
  return {
    diagnosisStage: null,
    diagnosis: {
      title: "Nothing graded yet",
      detail: "No finding landed on any stage of this goal.",
    },
  };
}

/**
 * The persona aside's one-liner, templated from the worst goal. The
 * experience is always the failure's subject — never the persona.
 */
function personaIssue(goals: readonly GoalFindingsModel[]): string {
  const failing = goals
    .filter((g) => g.diagnosisStage !== null)
    .sort(
      (a, b) =>
        journeyStageIndex(a.diagnosisStage!) -
        journeyStageIndex(b.diagnosisStage!)
    );
  const worst = failing[0];
  if (worst) {
    const stageWord = journeyStageTitle(worst.diagnosisStage!).toLowerCase();
    return `"${worst.title}" broke at ${stageWord} before it could deliver.`;
  }
  const uneasy = goals.find((g) => g.sentiment.label === "Uneasy");
  if (uneasy) {
    return `No goal broke outright, but "${uneasy.title}" showed friction.`;
  }
  if (goals.some((g) => g.sentiment.label === "Landed")) {
    return "Every measured stage held across their goals.";
  }
  return "Nothing has been graded for their sessions yet.";
}

// ── The derivation ──────────────────────────────────────────────────────────

export interface FindingsPersonaDoc {
  _id: string;
  name: string;
  role?: string;
  avatarShape?: number;
  avatarPalette?: number;
}

export function deriveSwarmFindingsModel(args: {
  runs: readonly SwarmOverviewRun[];
  signals: SwarmWaveSignals | null | undefined;
  personas: ReadonlyArray<FindingsPersonaDoc>;
  /** Presentation-only variety for demos; never changes severity or evidence. */
  demoVariant?: boolean;
}): SwarmFindingsModel {
  const { runs, signals, personas, demoVariant = false } = args;

  // One run = one goal; evidence accumulates per goal keyed by run id (a
  // journeyRefId can appear twice in pathological waves, runId cannot).
  const goalEvidence = new Map<
    string,
    Record<JourneyStageId, StageEvidence[]>
  >();
  const forRun = (runId: string) => {
    let existing = goalEvidence.get(runId);
    if (!existing) {
      existing = emptyStages();
      goalEvidence.set(runId, existing);
    }
    return existing;
  };

  for (const run of runs) {
    const stages = forRun(run.runId);
    const connection = connectionEvidence(run);
    if (connection) stages.connection.push(connection);
    stages.value.push(...rubricEvidence(run));
    const judge = judgeEvidence(run);
    if (judge) stages.value.push(judge);
  }

  // Detector candidates: journey subjects land on their goal, persona
  // subjects fan to that persona's goals (labeled). Global subjects
  // (tool/criterion/environment/host) are wave-wide and skipped in v1 —
  // pinning them to one goal would invent attribution the miner never made.
  const personaByName = new Map(personas.map((p) => [p.name, p]));
  for (const candidate of signals?.candidates ?? []) {
    if (candidate.subjectKind === "journey") {
      const attributed = detectorEvidence(candidate, { personaScoped: false });
      if (!attributed) continue;
      for (const run of runs) {
        if (run.journeyRefId !== candidate.subjectId) continue;
        forRun(run.runId)[attributed.stage].push(attributed.evidence);
      }
    } else if (candidate.subjectKind === "persona") {
      const attributed = detectorEvidence(candidate, { personaScoped: true });
      if (!attributed) continue;
      // The candidate subject is a personaRefId; runs carry names. Match
      // through the persona doc, falling back to the display label.
      const doc = personas.find((p) => p._id === candidate.subjectId);
      const personaName = doc?.name ?? candidate.subjectLabel;
      for (const run of runs) {
        if (run.personaName !== personaName) continue;
        forRun(run.runId)[attributed.stage].push(attributed.evidence);
      }
    }
  }

  // Group goals under personas, alphabetical.
  const byPersona = new Map<string, SwarmOverviewRun[]>();
  for (const run of runs) {
    const list = byPersona.get(run.personaName);
    if (list) list.push(run);
    else byPersona.set(run.personaName, [run]);
  }

  const personaModels: PersonaFindingsModel[] = [...byPersona.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, personaRuns], personaIndex) => {
      const doc = personaByName.get(name);
      const goals: GoalFindingsModel[] = personaRuns.map((run, goalIndex) => {
        const evidence = forRun(run.runId);
        const stages = Object.fromEntries(
          JOURNEY_STAGES.map((stage) => [
            stage.id,
            {
              state: worstTone(evidence[stage.id]),
              evidence: evidence[stage.id],
            },
          ])
        ) as Record<JourneyStageId, GoalStageModel>;
        const { diagnosisStage, diagnosis } = goalDiagnosis(stages);
        const firstMeasured = JOURNEY_STAGES.find(
          (stage) => stages[stage.id].state !== "none"
        );
        return {
          journeyRefId: run.journeyRefId,
          runId: run.runId,
          title: run.journeyName,
          sessions: run.summary.total,
          sentiment: goalSentiment(
            stages,
            demoVariant,
            personaIndex + goalIndex
          ),
          stages,
          diagnosisStage,
          diagnosis,
          defaultStage: diagnosisStage ?? firstMeasured?.id ?? "value",
        };
      });
      return {
        name,
        ...(doc?.role !== undefined ? { role: doc.role } : {}),
        avatarSeed: doc?._id ?? name,
        ...(doc?.avatarShape !== undefined
          ? { avatarShape: doc.avatarShape }
          : {}),
        ...(doc?.avatarPalette !== undefined
          ? { avatarPalette: doc.avatarPalette }
          : {}),
        sessionsAuthored: personaRuns.reduce(
          (sum, run) => sum + run.summary.total,
          0
        ),
        sentiment: personaSentiment(goals, demoVariant, personaIndex),
        issue: personaIssue(goals),
        goals,
      };
    });

  const defaultPersonaIndex = Math.max(
    0,
    personaModels.findIndex((p) => p.sentiment.tone === "fail")
  );

  return {
    personas: personaModels,
    sessionCount: signals?.sessionCount ?? waveSessionTotals(runs).total,
    defaultPersonaIndex,
  };
}
