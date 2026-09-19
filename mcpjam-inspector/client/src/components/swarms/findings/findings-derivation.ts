/** Presentation joins for the canonical swarm findings contract. */
import {
  SWARM_FINDING_DISPOSITIONS,
  SWARM_FINDING_DISPOSITION_LABELS,
  SWARM_FINDING_TONE_OF_DISPOSITION,
  type SwarmFindingDisposition,
  type SwarmFindingTone,
  type SwarmJourneyFinding,
  type SwarmJourneyFindings,
} from "@mcpjam/sdk/contract";
import type { SwarmOverviewRun } from "@/lib/swarm-api";
import {
  JOURNEY_STAGES,
  JOURNEY_STAGE_BY_CHAIN,
  type JourneyStageId,
} from "./journey-stages";
import type {
  FindingsPersonaDoc,
  SwarmFindingsModel,
  GoalFindingsModel,
  GoalStageModel,
  StageState,
} from "./findings-derivation-legacy";
export * from "./findings-derivation-legacy";

/**
 * Tone is a function of disposition. The client derives it rather than
 * trusting the row, so a producer bug can never paint a met goal red.
 */
export function toneOfDisposition(
  disposition: SwarmFindingDisposition,
): SwarmFindingTone {
  return SWARM_FINDING_TONE_OF_DISPOSITION[disposition];
}

/** How bad a tone reads. `muted` is not good news: it outranks `ok`. */
const TONE_SEVERITY: Record<SwarmFindingTone, number> = {
  fail: 3,
  warn: 2,
  muted: 1,
  ok: 0,
};

/** Worst wins. `none` (unmeasured) never overwrites a measured state. */
const STAGE_STATE_RANK: Record<StageState, number> = {
  fail: 3,
  warn: 2,
  ok: 1,
  none: 0,
};

function worseStage(a: StageState, b: StageState): StageState {
  return STAGE_STATE_RANK[b] > STAGE_STATE_RANK[a] ? b : a;
}

function dispositionIndex(disposition: SwarmFindingDisposition): number {
  return SWARM_FINDING_DISPOSITIONS.indexOf(disposition);
}

/**
 * The row that speaks for a goal, independent of wire order: the goal-scoped
 * row when there is one, else the worst row by tone, ties broken by the
 * contract's disposition order and finally by id.
 */
export function representativeGoalRow(
  rows: readonly SwarmJourneyFinding[],
): SwarmJourneyFinding | undefined {
  return [...rows].sort((a, b) => {
    const scope =
      Number(b.scopeLevel === "goal") - Number(a.scopeLevel === "goal");
    if (scope !== 0) return scope;
    const tone =
      TONE_SEVERITY[toneOfDisposition(b.disposition)] -
      TONE_SEVERITY[toneOfDisposition(a.disposition)];
    if (tone !== 0) return tone;
    const order =
      dispositionIndex(a.disposition) - dispositionIndex(b.disposition);
    if (order !== 0) return order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * The wire path's suggested fix: the `fixPhrase` of the verified mechanism
 * that reaches the most sessions (wire order breaks ties). Session reports
 * and population facts never carry a fix a reader should act on.
 */
export function wireRecommendation(wire: SwarmJourneyFindings): string | null {
  let best: SwarmJourneyFinding | null = null;
  for (const row of wire.findings) {
    if (row.basis !== "verifiedMechanism" || !row.fixPhrase?.trim()) continue;
    if (!best || row.population.count > best.population.count) best = row;
  }
  return best?.fixPhrase?.trim() ?? null;
}

function stageStateOf(row: SwarmJourneyFinding): StageState {
  if (row.chainStageState === "failed") return "fail";
  if (row.chainStageState === "passed") return "ok";
  return "none";
}

export function deriveSwarmFindingsModelFromWire({
  journeyFindings: wire,
  personas,
  runs,
}: {
  journeyFindings: SwarmJourneyFindings;
  personas: ReadonlyArray<FindingsPersonaDoc>;
  runs: readonly SwarmOverviewRun[];
}): SwarmFindingsModel {
  const models = wire.personas.map((persona) => {
    const doc =
      personas.find((p) => p._id === persona.persona.personaRefId) ??
      personas.find((p) => p.name === persona.persona.name);
    const personaRows = wire.findings.filter(
      (row) =>
        row.persona.name === persona.persona.name &&
        row.persona.personaRefId === persona.persona.personaRefId,
    );
    const goals: GoalFindingsModel[] = persona.goalRunIds.map((runId) => {
      const rows = personaRows.filter((row) => row.goal.runId === runId);
      const run = runs.find((candidate) => candidate.runId === runId);
      const lead = representativeGoalRow(rows);
      const emptyStage = (): GoalStageModel => ({
        state: "none",
        evidence: [],
      });
      const stages: Record<JourneyStageId, GoalStageModel> = {
        connection: emptyStage(),
        discovery: emptyStage(),
        selection: emptyStage(),
        call: emptyStage(),
        response: emptyStage(),
        value: emptyStage(),
      };
      for (const row of rows) {
        if (!row.chainStage) continue;
        const stage = stages[JOURNEY_STAGE_BY_CHAIN[row.chainStage]];
        stage.state = worseStage(stage.state, stageStateOf(row));
        const tone = toneOfDisposition(row.disposition);
        if (tone !== "muted")
          stage.evidence.push({
            tone,
            observation:
              row.mechanismPhrase ??
              row.reportExcerpt?.actual ??
              SWARM_FINDING_DISPOSITION_LABELS[row.disposition],
            meta: `${row.population.count} of ${row.population.total} sessions`,
            sessionId: row.sessionIds[0],
          });
      }
      const diagnosisStage =
        JOURNEY_STAGES.find((stage) => stages[stage.id].state === "fail")?.id ??
        null;
      const disposition = lead?.disposition ?? "notMeasured";
      return {
        runId,
        journeyRefId: lead?.goal.journeyRefId ?? run?.journeyRefId ?? "",
        title: lead?.goal.title ?? run?.journeyName ?? "Untitled goal",
        sessions: new Set(rows.flatMap((row) => row.sessionIds)).size,
        notRun: disposition === "notRun",
        sentiment: {
          label: SWARM_FINDING_DISPOSITION_LABELS[disposition],
          tone: toneOfDisposition(disposition),
        },
        stages,
        diagnosisStage,
        diagnosis: {
          title: SWARM_FINDING_DISPOSITION_LABELS[disposition],
          detail:
            lead?.mechanismPhrase ??
            lead?.reportExcerpt?.actual ??
            "No session evidence available.",
        },
        defaultStage: diagnosisStage ?? "value",
      };
    });
    return {
      name: persona.persona.name,
      role: doc?.role,
      avatarSeed: persona.persona.personaRefId ?? persona.persona.name,
      avatarShape: doc?.avatarShape,
      avatarPalette: doc?.avatarPalette,
      sessionsAuthored: new Set(personaRows.flatMap((row) => row.sessionIds))
        .size,
      sentiment: {
        label: SWARM_FINDING_DISPOSITION_LABELS[persona.disposition],
        tone: toneOfDisposition(persona.disposition),
      },
      issue: goals.find((g) => g.diagnosisStage)?.diagnosis.detail ?? "",
      goals,
    };
  });
  const { configured, started, limited } = wire.population;
  return {
    personas: models,
    launch: {
      total: configured,
      succeeded: started,
      failed: Math.max(0, configured - started - limited),
      rateLimited: limited,
    },
    neverLaunched: wire.summaryKind === "notLaunched",
    sessionCount: started,
    defaultPersonaIndex: Math.max(
      0,
      models.findIndex((p) => p.sentiment.tone === "fail"),
    ),
  };
}
