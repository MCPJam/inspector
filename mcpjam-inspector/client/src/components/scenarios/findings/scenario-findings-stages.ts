/**
 * One goal's `ChatSessionStageFunnel` mapped to the six stage buttons Findings
 * renders.
 *
 * PURE, and deliberately split from the query that feeds it. The backend
 * argument this consumes (`getScenarioStageFunnel({ clusterId })`) is still in
 * review, so keeping the mapping holdable against a fixture is what lets these
 * rules be settled now instead of eyeballed later against live data.
 *
 * NOTHING HERE DECIDES A VERDICT. Every state below is read off tallies the
 * backend already folded (`convex/lib/chatSessionStageAggregate.ts`); this
 * module only picks which of the backend's own answers a button shows. Its
 * honesty rules are that fold's rules, restated where they bite:
 *
 *  - `eligible` is `passed + failed`. `notMeasured`, `notApplicable` and
 *    `notReached` are three different reasons there is no verdict, and none of
 *    them is a "no".
 *  - Zero eligible is `none` — UNKNOWN. Never a pass, and never a 0% fail. A
 *    stage nobody was graded on is the easiest place for this panel to lie,
 *    because "no failures recorded" and "it worked" look identical.
 *  - `ok` is EARNED: every eligible session passed. One failure is `warn`.
 */

import { USER_VALUE_STAGES, type UserValueStage } from "@mcpjam/sdk/contract";
// Type-only: erased at compile time, so the swarm runtime stays out of here.
import type {
  GoalStageModel,
  StageEvidence,
  StageState,
} from "@/components/swarms/findings/findings-derivation";
import {
  JOURNEY_STAGES,
  journeyStageTitle,
  type JourneyStageId,
} from "@/components/swarms/findings/journey-stages";
import type {
  ChatSessionStageFunnel,
  StageTally,
} from "@/components/shared/user-value-chain/user-value-chain-types";

/**
 * The chain's stage ids to the panel's. Five are identical; the sixth is not.
 * The chain calls the last stage `userValue`, the Findings panel has always
 * called it `value`. A `Record` rather than a cast, so a seventh stage on
 * either side fails the build instead of silently dropping a column.
 */
const STAGE_ID: Record<UserValueStage, JourneyStageId> = {
  connection: "connection",
  discovery: "discovery",
  selection: "selection",
  call: "call",
  response: "response",
  userValue: "value",
};

/**
 * A stage's state, from its tally alone.
 *
 * Reads `passed` and `failed` rather than `passRate`, on purpose: `passRate` is
 * `null` on an empty denominator, and a `null` flowing through a comparison
 * quietly answers "false" to every question asked of it. The counts cannot.
 */
export function stageStateFromTally(tally: StageTally): StageState {
  if (tally.eligible === 0) return "none";
  if (tally.failed === 0) return "ok";
  if (tally.passed === 0) return "fail";
  return "warn";
}

/**
 * The denominator line under an observation.
 *
 * Every non-eligible bucket is named rather than dropped. "8 graded" on its own
 * invites the reader to assume the other four agreed; "8 graded, 4 never got
 * here" tells them where the other four actually went.
 */
function tallyMeta(tally: StageTally): string {
  const parts = [`${tally.eligible} graded`];
  if (tally.notReached > 0) parts.push(`${tally.notReached} never got here`);
  if (tally.notMeasured > 0) parts.push(`${tally.notMeasured} not measured`);
  if (tally.notApplicable > 0) {
    parts.push(`${tally.notApplicable} not applicable`);
  }
  return parts.join(" · ");
}

/**
 * One row, or none.
 *
 * A `none` stage returns NOTHING, so the panel falls through to
 * `EMPTY_STAGE_COPY` — the verbatim "this is not evidence that the stage
 * passed". A row would have to claim a `StageTone`, and there is no honest
 * tone for a stage nobody was graded on.
 */
function stageEvidence(tally: StageTally): StageEvidence[] {
  const state = stageStateFromTally(tally);
  if (state === "none") return [];
  const title = journeyStageTitle(STAGE_ID[tally.stage]);
  const observation =
    state === "ok"
      ? `${title} passed in every graded session.`
      : state === "fail"
        ? `${title} failed in every graded session.`
        : `${title} failed in ${tally.failed} of ${tally.eligible} graded sessions.`;
  return [{ tone: state, observation, meta: tallyMeta(tally) }];
}

/** Every stage unknown — the shape a goal keeps when no funnel answered. */
function noStages(): Record<JourneyStageId, GoalStageModel> {
  const stages = {} as Record<JourneyStageId, GoalStageModel>;
  for (const stage of JOURNEY_STAGES) {
    stages[stage.id] = { state: "none", evidence: [] };
  }
  return stages;
}

/**
 * Where these sessions break: the most common FIRST failure.
 *
 * A different question from any single stage's rate, and the one a funnel is
 * usually being read for — a late stage can fail in most sessions purely
 * because an earlier one already broke. Iterates `USER_VALUE_STAGES` so a tie
 * goes to the EARLIEST stage, which is the diagnosis worth acting on.
 */
function breakStage(
  funnel: ChatSessionStageFunnel,
): { stage: JourneyStageId; count: number } | null {
  let best: { stage: JourneyStageId; count: number } | null = null;
  for (const stage of USER_VALUE_STAGES) {
    const count = funnel.firstFailedStage[stage] ?? 0;
    if (count > 0 && (best === null || count > best.count)) {
      best = { stage: STAGE_ID[stage], count };
    }
  }
  return best;
}

/** Why a scanned session contributed no rows. Named, never quietly dropped. */
function describeExclusions(funnel: ChatSessionStageFunnel): string {
  const { absent, deriving, stale, failed } = funnel.exclusions;
  const parts: string[] = [];
  if (absent > 0) parts.push(`${absent} never derived`);
  if (deriving > 0) parts.push(`${deriving} still deriving`);
  if (stale > 0) parts.push(`${stale} out of date`);
  if (failed > 0) parts.push(`${failed} could not be derived`);
  return parts.join(", ");
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

export interface ScenarioGoalStages {
  stages: Record<JourneyStageId, GoalStageModel>;
  /** Earliest-worst stage to blame, or null when nothing failed. */
  diagnosisStage: JourneyStageId | null;
  diagnosis: { title: string; detail: string };
  /** Stage to select when the goal expands. */
  defaultStage: JourneyStageId;
  /** The scan hit its limit — this goal has older sessions nobody counted. */
  truncated: boolean;
}

/**
 * Map a goal's funnel, or answer `null` when there is no funnel to map.
 *
 * `null` in means `null` out rather than a fabricated unmeasured model: the
 * backend already distinguishes "cannot answer this goal" (a deleted cluster,
 * a non-goal axis) from "measured, and it was nothing", and collapsing those
 * here would undo the distinction that query exists to make. The caller keeps
 * its own unmeasured fallback, so there is exactly one of them.
 */
export function mapGoalStageFunnel(
  funnel: ChatSessionStageFunnel | null | undefined,
): ScenarioGoalStages | null {
  if (!funnel) return null;

  const stages = noStages();
  for (const tally of funnel.stages) {
    const id = STAGE_ID[tally.stage];
    // A stage id the client does not know is skipped rather than crashing the
    // tab: this type is a hand-kept mirror, so a backend that grows a stage
    // reaches here before the mirror does.
    if (!id) continue;
    stages[id] = {
      state: stageStateFromTally(tally),
      evidence: stageEvidence(tally),
    };
  }

  const broke = breakStage(funnel);
  const firstWith = (state: StageState): JourneyStageId | null =>
    JOURNEY_STAGES.find((stage) => stages[stage.id].state === state)?.id ??
    null;

  // Three situations, three sentences. They are NOT interchangeable: "nothing
  // broke" and "nothing was graded" are the pair a reader is most likely to
  // confuse, and the one that would cost them a day chasing a healthy server.
  const diagnosis = funnel.notMeasured
    ? {
        title: "No session in this goal has a graded chain yet.",
        detail: (() => {
          const why = describeExclusions(funnel);
          const scanned = `${funnel.total} session${plural(funnel.total)} scanned`;
          return why ? `${scanned}: ${why}.` : `${scanned}.`;
        })(),
      }
    : broke
      ? {
          title: `${journeyStageTitle(broke.stage)} is where these sessions break.`,
          detail: `${broke.count} of ${funnel.counted} graded session${plural(
            funnel.counted,
          )} failed first at ${journeyStageTitle(broke.stage)}.`,
        }
      : {
          title: "No graded session failed a stage in this goal.",
          detail: `${funnel.counted} of ${funnel.total} session${plural(
            funnel.total,
          )} carried a chain, and none of them broke.`,
        };

  return {
    stages,
    diagnosisStage: broke?.stage ?? firstWith("fail"),
    diagnosis,
    // Open on the break when there is one. Falling back through fail and warn
    // before `value` keeps the panel from opening on an empty stage while a red
    // one sits unread two columns to the left.
    defaultStage:
      broke?.stage ?? firstWith("fail") ?? firstWith("warn") ?? "value",
    truncated: funnel.truncated,
  };
}
