/** Presentation joins for the canonical swarm findings contract. */
import {
  SWARM_FINDING_DISPOSITIONS,
  SWARM_FINDING_DISPOSITION_LABELS,
  SWARM_FINDING_SIGNAL_LABELS,
  SWARM_FINDING_TONE_OF_DISPOSITION,
  type SwarmFindingDisposition,
  type SwarmFindingTone,
  type SwarmJourneyFinding,
  type SwarmFindingSignal,
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
  PersonaFindingsModel,
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
 * The one cause the card speaks for.
 *
 * The producer fans a single mechanism into one row per persona, goal and
 * target, so the rows sharing a `mechanismId` ARE one cause and are ranked
 * together by how many distinct sessions support them. Ranking individual rows
 * instead — which is what the fix slot used to do — lets a cause that touched
 * four sessions of one goal outrank a cause that touched six across three.
 *
 * Headline and fix both read this, so the fix on the card is always the fix
 * for the cause the card just named. Ties break on mechanism id, so the choice
 * does not depend on wire order.
 */
export type WireLeadMechanism = {
  mechanismId: string;
  rows: SwarmJourneyFinding[];
  sessionCount: number;
  goalRunIds: string[];
  mechanismPhrase: string | null;
  fixPhrase: string | null;
  chainStage: SwarmJourneyFinding["chainStage"];
  chainStageBasis: SwarmJourneyFinding["chainStageBasis"];
};

export function selectLeadWireMechanism(
  wire: SwarmJourneyFindings,
): WireLeadMechanism | null {
  const groups = new Map<string, SwarmJourneyFinding[]>();
  for (const row of wire.findings) {
    if (row.basis !== "verifiedMechanism" || !row.mechanismId) continue;
    groups.set(row.mechanismId, [...(groups.get(row.mechanismId) ?? []), row]);
  }
  let lead: WireLeadMechanism | null = null;
  for (const [mechanismId, rows] of groups) {
    const sessionCount = new Set(rows.flatMap((row) => row.sessionIds)).size;
    if (
      lead &&
      (sessionCount < lead.sessionCount ||
        (sessionCount === lead.sessionCount && mechanismId >= lead.mechanismId))
    )
      continue;
    const withPhrase = rows.find((row) => row.mechanismPhrase?.trim());
    const withFix = rows.find((row) => row.fixPhrase?.trim());
    lead = {
      mechanismId,
      rows,
      sessionCount,
      goalRunIds: [...new Set(rows.map((row) => row.goal.runId))],
      mechanismPhrase: withPhrase?.mechanismPhrase?.trim() ?? null,
      // The SELECTED cause's fix or none. Borrowing another cause's
      // recommendation would tell a reader to fix something the headline
      // never mentioned.
      fixPhrase: withFix?.fixPhrase?.trim() ?? null,
      chainStage: rows[0]!.chainStage,
      chainStageBasis: rows[0]!.chainStageBasis,
    };
  }
  return lead;
}

/** The suggested fix, always belonging to the cause the headline named. */
export function wireRecommendation(wire: SwarmJourneyFindings): string | null {
  return selectLeadWireMechanism(wire)?.fixPhrase ?? null;
}

/**
 * Rows reporting a recorded fact, aggregated by the fact. Used when no cause
 * was confirmed: a wave still has to be able to say what was observed.
 */
export function wireSignalTotals(
  wire: SwarmJourneyFindings,
): Array<{ signal: SwarmFindingSignal; count: number; total: number }> {
  const totals = new Map<
    SwarmFindingSignal,
    { count: number; total: number }
  >();
  for (const row of wire.findings) {
    if (!row.signal) continue;
    const previous = totals.get(row.signal) ?? { count: 0, total: 0 };
    totals.set(row.signal, {
      count: previous.count + row.population.count,
      total: previous.total + row.population.total,
    });
  }
  return [...totals.entries()]
    .map(([signal, counts]) => ({ signal, ...counts }))
    .sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal));
}

function stageStateOf(row: SwarmJourneyFinding): StageState {
  if (row.chainStageState === "failed") return "fail";
  if (row.chainStageState === "passed") return "ok";
  return "none";
}

/**
 * What this persona says happened, and which session said it.
 *
 * A verified mechanism intentionally carries `reportExcerpt: null` — it speaks
 * for a group, and no single session's words are the group's. So the lead is
 * kept as the diagnostic, and the prose comes from a SUPPORTING session: same
 * persona, same goal, same target, and a session id the mechanism actually
 * counted. Preferring a row that has an account, then the lowest session id,
 * keeps the choice stable no matter what order the wire arrived in.
 *
 * It describes that one representative session, never every member of the
 * group, which is why its source session travels with it.
 */
function personaAccount(
  rows: readonly SwarmJourneyFinding[],
  goals: readonly GoalFindingsModel[],
): Pick<
  PersonaFindingsModel,
  "issue" | "account" | "accountSessionId" | "cited" | "signal"
> {
  const leadGoal = goals.find((goal) => goal.diagnosisStage);
  const lead =
    rows.find(
      (row) =>
        row.basis === "verifiedMechanism" &&
        (!leadGoal || row.goal.runId === leadGoal.runId),
    ) ??
    rows.find(
      (row) => row.signal && (!leadGoal || row.goal.runId === leadGoal.runId),
    ) ??
    null;
  const supporting = (
    lead
      ? rows.filter(
          (row) =>
            row.basis === "sessionReport" &&
            row.goal.runId === lead.goal.runId &&
            row.target.id === lead.target.id &&
            row.sessionIds.some((id) => lead.sessionIds.includes(id)),
        )
      : rows.filter((row) => row.basis === "sessionReport")
  ).sort((a, b) => {
    const account =
      Number(!!b.reportExcerpt?.account) - Number(!!a.reportExcerpt?.account);
    if (account !== 0) return account;
    return (a.sessionIds[0] ?? "").localeCompare(b.sessionIds[0] ?? "");
  })[0];
  const account = supporting?.reportExcerpt?.account?.trim();
  return {
    // Never empty on this path. The old expression bottomed out at `""`
    // whenever no goal had a located failure, which rendered as an empty
    // paragraph with a border above it.
    issue:
      account ??
      lead?.outcomePhrase ??
      leadGoal?.diagnosis.detail ??
      goals[0]?.diagnosis.detail ??
      "No session evidence available.",
    ...(account ? { account } : {}),
    ...(account && supporting?.sessionIds[0]
      ? { accountSessionId: supporting.sessionIds[0] }
      : {}),
    ...(supporting?.reportExcerpt
      ? {
          cited: {
            actual: supporting.reportExcerpt.actual,
            citations: [...supporting.reportExcerpt.citations],
          },
        }
      : {}),
    ...(lead?.signal ? { signal: lead.signal } : {}),
  };
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
              // A recorded fact has no mechanism and no excerpt; without this
              // it would render as a feeling word ("Frustrated") rather than
              // as the thing that was actually observed.
              (row.signal ? SWARM_FINDING_SIGNAL_LABELS[row.signal] : null) ??
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
      ...personaAccount(personaRows, goals),
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
