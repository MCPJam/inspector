/** Presentation joins for the canonical swarm findings contract. */
import {
  SWARM_FINDING_DISPOSITION_LABELS,
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
} from "./findings-derivation-legacy";
export * from "./findings-derivation-legacy";

export function deriveSwarmFindingsModelFromWire({
  journeyFindings: wire,
  personas,
}: {
  journeyFindings: SwarmJourneyFindings;
  personas: ReadonlyArray<FindingsPersonaDoc>;
  runs: readonly SwarmOverviewRun[];
}): SwarmFindingsModel {
  const models = wire.personas.map((persona) => {
    const doc =
      personas.find((p) => p._id === persona.persona.personaRefId) ??
      personas.find((p) => p.name === persona.persona.name);
    const goals: GoalFindingsModel[] = persona.goalRunIds.map((runId) => {
      const rows = wire.findings.filter(
        (row) =>
          row.goal.runId === runId &&
          row.persona.name === persona.persona.name &&
          row.persona.personaRefId === persona.persona.personaRefId,
      );
      const first = rows[0];
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
        const state =
          row.chainStageState === "failed"
            ? "fail"
            : row.chainStageState === "passed"
              ? "ok"
              : "none";
        if (stage.state !== "fail") stage.state = state;
        if (row.tone !== "muted")
          stage.evidence.push({
            tone: row.tone,
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
      const disposition = first?.disposition ?? "notMeasured";
      return {
        runId,
        journeyRefId: first?.goal.journeyRefId ?? "",
        title: first?.goal.title ?? "Goal",
        sessions: new Set(rows.flatMap((row) => row.sessionIds)).size,
        notRun: disposition === "notRun",
        sentiment: {
          label: SWARM_FINDING_DISPOSITION_LABELS[disposition],
          tone: first?.tone ?? "muted",
        },
        stages,
        diagnosisStage,
        diagnosis: {
          title: SWARM_FINDING_DISPOSITION_LABELS[disposition],
          detail:
            first?.mechanismPhrase ??
            first?.reportExcerpt?.actual ??
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
      sessionsAuthored: new Set(
        wire.findings
          .filter(
            (row) =>
              row.persona.name === persona.persona.name &&
              row.persona.personaRefId === persona.persona.personaRefId,
          )
          .flatMap((row) => row.sessionIds),
      ).size,
      sentiment: {
        label: SWARM_FINDING_DISPOSITION_LABELS[persona.disposition],
        tone: persona.tone,
      },
      issue: goals.find((g) => g.diagnosisStage)?.diagnosis.detail ?? "",
      goals,
    };
  });
  return {
    personas: models,
    launch: {
      total: wire.population.configured,
      succeeded: wire.population.started,
      failed: 0,
      rateLimited: wire.population.limited,
    },
    neverLaunched: wire.summaryKind === "notLaunched",
    sessionCount: wire.population.started,
    defaultPersonaIndex: Math.max(
      0,
      models.findIndex((p) => p.sentiment.tone === "fail"),
    ),
  };
}
