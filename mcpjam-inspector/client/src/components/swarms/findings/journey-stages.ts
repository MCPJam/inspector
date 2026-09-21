/**
 * The 6-stage user-value chain the Findings tab narrates a goal through.
 *
 * A client-side map, not a Convex field: evidence is ATTRIBUTED to stages by
 * `findings-derivation.ts`, the backend never stores a stage. Order is
 * load-bearing — diagnosis is the EARLIEST failing stage, and "earliest" is
 * index order here.
 */

import { USER_VALUE_STAGES, type UserValueStage } from "@mcpjam/sdk/contract";

export type JourneyStageId =
  | "connection"
  | "discovery"
  | "selection"
  | "call"
  | "response"
  | "value";

export interface JourneyStage {
  id: JourneyStageId;
  /** Two-digit ordinal for the stage button ("01"…"06"). */
  num: string;
  title: string;
  /** The question the stage answers about the experience. */
  question: string;
}

export const JOURNEY_STAGE_COPY = {
  connection: {
    id: "connection",
    num: "01",
    title: "Connection",
    question: "Could the configured client establish a session?",
  },
  discovery: {
    id: "discovery",
    num: "02",
    title: "Discovery",
    question: "Did the client receive usable primitives and metadata?",
  },
  selection: {
    id: "selection",
    num: "03",
    title: "Selection",
    question: "Did the agent choose an appropriate primitive?",
  },
  call: {
    id: "call",
    num: "04",
    title: "Tool call",
    question: "Were the arguments valid and faithful to intent?",
  },
  response: {
    id: "response",
    num: "05",
    title: "Tool response",
    question: "Did the server return an honest, usable result?",
  },
  userValue: {
    id: "value",
    num: "06",
    title: "User value",
    question: "Did the configured system complete the original task?",
  },
} as const satisfies Record<UserValueStage, JourneyStage>;
export const JOURNEY_STAGES = USER_VALUE_STAGES.map(
  (stage) => JOURNEY_STAGE_COPY[stage],
);

/**
 * Compile-time proof every panel stage has a ROW here.
 *
 * The array used to be annotated `readonly JourneyStage[]`, which widened the
 * `as const` away: a seventh stage added to `JourneyStageId` and to both maps
 * but forgotten HERE typechecked clean, and then `journeyStageTitle` read
 * `.title` off `undefined` at runtime — the exact throw the map guard below
 * exists to prevent, through the one list it did not cover.
 */
type UnlistedJourneyStage = Exclude<
  JourneyStageId,
  (typeof JOURNEY_STAGES)[number]["id"]
>;
const JOURNEY_STAGES_ARE_EXHAUSTIVE: UnlistedJourneyStage extends never
  ? true
  : UnlistedJourneyStage = true;
void JOURNEY_STAGES_ARE_EXHAUSTIVE;

/**
 * Keyed by id, so a title lookup cannot miss. Built from the array above and
 * total by the assertion on it, which is what retires the `!` this function
 * used to need on a `findIndex` that could return -1.
 */
const JOURNEY_STAGE_BY_ID = Object.fromEntries(
  JOURNEY_STAGES.map((stage) => [stage.id, stage]),
) as Record<JourneyStageId, JourneyStage>;

/**
 * The panel's stage ids to the measured chain's, and back.
 *
 * Five are identical; the sixth is not — the chain calls the last stage
 * `userValue` and this panel has always called it `value`. Both directions are
 * needed (mapping a funnel IN, building a session filter OUT), and the reverse
 * is INVERTED from the forward map rather than written twice, so neither
 * direction can gain a stage the other has not.
 */
export const CHAIN_STAGE_BY_JOURNEY = {
  connection: "connection",
  discovery: "discovery",
  selection: "selection",
  call: "call",
  response: "response",
  value: "userValue",
} as const satisfies Record<JourneyStageId, UserValueStage>;

/**
 * Compile-time proof the forward map reaches EVERY chain stage.
 *
 * `Record<JourneyStageId, UserValueStage>` only makes the map total over the
 * PANEL's ids. A seventh stage added to `UserValueStage` in the SDK satisfies
 * that annotation untouched, and would leave the reverse map below missing a
 * key its own type promises: `breakStage` walks `USER_VALUE_STAGES` and does
 * an unguarded reverse lookup, so it would hand back `undefined` typed as a
 * `JourneyStageId`, and the stage-title lookup that follows throws — losing
 * the whole chain to the error boundary as "unmeasured". This makes it a build
 * error instead, naming the stage nobody mapped.
 */
type UnmappedChainStage = Exclude<
  UserValueStage,
  (typeof CHAIN_STAGE_BY_JOURNEY)[JourneyStageId]
>;
const CHAIN_STAGES_ARE_EXHAUSTIVE: UnmappedChainStage extends never
  ? true
  : UnmappedChainStage = true;
void CHAIN_STAGES_ARE_EXHAUSTIVE;

export const JOURNEY_STAGE_BY_CHAIN = Object.fromEntries(
  Object.entries(CHAIN_STAGE_BY_JOURNEY).map(([journey, chain]) => [
    chain,
    journey,
  ]),
) as Record<UserValueStage, JourneyStageId>;

/** Index of a stage in chain order — the "earliest failing stage" ordering. */
export function journeyStageIndex(id: JourneyStageId): number {
  return JOURNEY_STAGES.findIndex((stage) => stage.id === id);
}

export function journeyStageTitle(id: JourneyStageId): string {
  return JOURNEY_STAGE_BY_ID[id].title;
}
