/**
 * Maps User Testing window data into the Findings model the swarm tab already
 * renders (BB-145). Pure: no queries, no LLM lanes.
 *
 * The two surfaces disagree about what a "persona" is, and that disagreement is
 * the whole reason this module exists. A swarm persona is authored: we wrote
 * Maya, gave her goals, and stamped every session with her name. User Testing
 * has real visitors who were never assigned anything, and the visitor facets we
 * do hold (new/returning, guest/signed-in, device) do not discriminate on a
 * surface whose sessions all arrive through one shared link.
 *
 * So a User Testing persona is a SENTIMENT: how the user came across. That is
 * the closed five-value `sentiment` on each session, not the emergent sentiment
 * CLUSTER — cluster labels are regenerated on every analysis, so tabs built on
 * them would rename themselves between runs.
 *
 * Honesty rules carry over from the swarm derivation:
 *  - `unclear` is a verdict (the model looked and could not tell) and earns a
 *    persona. An ABSENT sentiment is not a verdict, it is an unanalyzed
 *    session, so it is counted separately and never folded into `unclear`.
 *  - The six-stage chain is not populated here. Per-goal stage data is not
 *    reachable on this surface yet: `getScenarioStageFunnel` takes no cluster
 *    filter and the drilldown projection carries no `stageDerivation`. An empty
 *    stage renders as "no finding", never as a pass.
 */

import type {
  SessionOutcome,
  SessionSentiment,
} from "@/hooks/scenario-usage-filters";
// Type-only: erased at compile time, so no swarm runtime is pulled in here.
import type {
  GoalFindingsModel,
  GoalStageModel,
  PersonaFindingsModel,
  SentimentPillModel,
  SwarmFindingsModel,
} from "@/components/swarms/findings/findings-derivation";
import {
  JOURNEY_STAGES,
  type JourneyStageId,
} from "@/components/swarms/findings/journey-stages";

/**
 * The subset of a drilldown row this derivation reads. Structural on purpose:
 * `ScenarioUsageThread` and `SharedChatThread` both satisfy it, and a test does
 * not have to build a whole session document.
 */
export interface ScenarioFindingsSession {
  _id: string;
  /** Closed five-value verdict. Absent until the session has been analyzed. */
  sentiment?: SessionSentiment;
  /** The GOAL-axis cluster. Absent when clustering has not placed it. */
  themeClusterId?: string;
  themeClusterLabel?: string;
  outcome?: SessionOutcome;
}

export interface ScenarioFindingsModel extends SwarmFindingsModel {
  /**
   * Sessions carrying no sentiment yet. Deliberately NOT a persona: absence is
   * not a feeling. The card footnotes them so the strip's counts never quietly
   * understate the study.
   */
  unanalyzedCount: number;
  /**
   * How much of the study the persona × goal grid was actually built from.
   *
   * Nothing stores that grid, so it is tallied from sessions, and the drilldown
   * that supplies them pages against a server-side cap. On a large study the
   * grid is therefore a SUBSET, and a goal can be missing from a persona
   * entirely because its sessions were never scanned. That is not a rounding
   * error, so it is reported rather than absorbed — see
   * {@link deriveScenarioFindingsFootnotes}.
   */
  coverage: {
    /** Rows the grid was built from. */
    scanned: number;
    /** The study's real total, as Insights reports it. */
    total: number;
    /** The grid is a subset: some sessions were never looked at. */
    truncated: boolean;
  };
}

/**
 * Persona titles. The tab names the feeling and the pill under it carries the
 * session count rather than repeating the title.
 *
 * `gave_up` reads as an outcome but is not one. The backend admits it as a
 * sentiment only when the user SAID they were quitting; it is never inferred
 * from a session that simply stops.
 */
const SENTIMENT_TITLE: Record<SessionSentiment, string> = {
  gave_up: "Gave up",
  frustrated: "Frustrated users",
  neutral: "Neutral users",
  satisfied: "Satisfied users",
  unclear: "Uncategorized users",
};

/** Worst first, so the strip opens on the sessions worth reading. */
const SENTIMENT_ORDER: readonly SessionSentiment[] = [
  "gave_up",
  "frustrated",
  "neutral",
  "satisfied",
  "unclear",
];

const SENTIMENT_PILL: Record<SessionSentiment, SentimentPillModel> = {
  gave_up: { label: "Gave up", tone: "fail" },
  frustrated: { label: "Frustrated", tone: "fail" },
  neutral: { label: "Neutral", tone: "muted" },
  satisfied: { label: "Satisfied", tone: "ok" },
  unclear: { label: "Uncategorized", tone: "muted" },
};

/** Every stage unknown. Absent evidence is not a pass, and the panel says so. */
function emptyStages(): Record<JourneyStageId, GoalStageModel> {
  const stages = {} as Record<JourneyStageId, GoalStageModel>;
  for (const stage of JOURNEY_STAGES) {
    stages[stage.id] = { state: "none", evidence: [] };
  }
  return stages;
}

/**
 * Goal pill from the measured OUTCOME of its sessions. Outcome is a real
 * verdict, so this reads it rather than inventing a feeling for the goal.
 */
function goalSentiment(
  outcomes: readonly (SessionOutcome | undefined)[]
): SentimentPillModel {
  if (outcomes.some((o) => o === "errored" || o === "unresolved")) {
    return { label: "Stalled", tone: "fail" };
  }
  if (outcomes.some((o) => o === "partial")) {
    return { label: "Uneasy", tone: "warn" };
  }
  if (outcomes.some((o) => o === "completed")) {
    return { label: "Landed", tone: "ok" };
  }
  return { label: "Unscored", tone: "muted" };
}

/** The persona aside. The experience is the subject, never the person. */
function personaIssue(goals: readonly GoalFindingsModel[]): string {
  const stalled = goals.find((goal) => goal.sentiment.label === "Stalled");
  if (stalled) return `"${stalled.title}" did not resolve for these sessions.`;
  const uneasy = goals.find((goal) => goal.sentiment.label === "Uneasy");
  if (uneasy) return `"${uneasy.title}" only partly resolved.`;
  if (goals.some((goal) => goal.sentiment.label === "Landed")) {
    return "Every measured goal completed for these sessions.";
  }
  return "No goal has been scored for these sessions yet.";
}

function buildGoals(
  sessions: readonly ScenarioFindingsSession[]
): GoalFindingsModel[] {
  // Sessions clustering has not placed carry no goal. They still count toward
  // the persona's total, so goal counts can sum to less than that total. That
  // gap is real, and is not papered over with an "Unknown goal" bucket.
  const byCluster = new Map<string, ScenarioFindingsSession[]>();
  for (const session of sessions) {
    const clusterId = session.themeClusterId;
    if (clusterId === undefined) continue;
    const existing = byCluster.get(clusterId);
    if (existing) existing.push(session);
    else byCluster.set(clusterId, [session]);
  }

  return [...byCluster.entries()]
    .map(([clusterId, clusterSessions]) => ({
      journeyRefId: clusterId,
      // The drilldown pages a goal by its cluster id, so that is this goal's
      // identity on this surface — there is no run to key it by.
      runId: clusterId,
      title: clusterSessions[0]?.themeClusterLabel ?? "Unlabeled goal",
      sessions: clusterSessions.length,
      sentiment: goalSentiment(clusterSessions.map((s) => s.outcome)),
      stages: emptyStages(),
      diagnosisStage: null,
      diagnosis: {
        title: "Not measured per goal yet",
        detail:
          "The user value chain is measured for this study as a whole, not yet per goal.",
      },
      defaultStage: "value" as JourneyStageId,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.title.localeCompare(b.title));
}

export function deriveScenarioFindingsModel(args: {
  sessions: readonly ScenarioFindingsSession[];
  /**
   * Headline denominator. Pass `breakdown.totalSessions` so Findings and
   * Insights report the same number for the same study, which is the first
   * thing BB-145 asks for. Defaults to the rows handed in.
   */
  sessionCount?: number;
  /**
   * Whether the fetch that produced `sessions` stopped short — the drilldown's
   * `totalTruncated`. Omit and it is inferred from the counts, which is the
   * conservative read: fewer rows than the study has means the grid is partial.
   */
  truncated?: boolean;
}): ScenarioFindingsModel {
  const { sessions, sessionCount } = args;
  const total = sessionCount ?? sessions.length;
  const truncated = args.truncated ?? sessions.length < total;

  const bySentiment = new Map<SessionSentiment, ScenarioFindingsSession[]>();
  let unanalyzedCount = 0;
  for (const session of sessions) {
    const sentiment = session.sentiment;
    if (sentiment === undefined) {
      unanalyzedCount += 1;
      continue;
    }
    const existing = bySentiment.get(sentiment);
    if (existing) existing.push(session);
    else bySentiment.set(sentiment, [session]);
  }

  const personas: PersonaFindingsModel[] = SENTIMENT_ORDER.flatMap(
    (sentiment) => {
      const group = bySentiment.get(sentiment);
      // Only render a tab that has sessions. `gave_up` needs the user to say it
      // in words, so most studies would otherwise carry an empty tab.
      if (!group || group.length === 0) return [];
      const goals = buildGoals(group);
      return [
        {
          name: SENTIMENT_TITLE[sentiment],
          avatarSeed: sentiment,
          sessionsAuthored: group.length,
          sentiment: SENTIMENT_PILL[sentiment],
          issue: personaIssue(goals),
          goals,
        },
      ];
    }
  );

  return {
    personas,
    sessionCount: total,
    // SENTIMENT_ORDER is worst-first, so the first tab is already the one worth
    // reading.
    defaultPersonaIndex: 0,
    unanalyzedCount,
    coverage: { scanned: sessions.length, total, truncated },
  };
}

/**
 * Honesty footnotes for the summary card — chips, never a rubric row. Each one
 * names a way the strip above could understate the study.
 *
 * The truncation note reuses the swarm wording verbatim: the two surfaces hit
 * the same cap for the same reason, and a reader who has seen one should not
 * have to work out that the other means the same thing.
 */
export function deriveScenarioFindingsFootnotes(
  model: ScenarioFindingsModel
): string[] {
  const notes: string[] = [];
  if (model.coverage.truncated) {
    notes.push("Session scan hit its cap — counts cover a subset");
  }
  if (model.unanalyzedCount > 0) {
    notes.push(
      `${model.unanalyzedCount} session${
        model.unanalyzedCount === 1 ? "" : "s"
      } not analyzed yet — in no persona above`
    );
  }
  return notes;
}
