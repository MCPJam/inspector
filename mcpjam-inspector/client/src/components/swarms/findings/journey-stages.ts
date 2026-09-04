/**
 * The 6-stage user-value chain the Findings tab narrates a goal through.
 *
 * A client-side map, not a Convex field: evidence is ATTRIBUTED to stages by
 * `findings-derivation.ts`, the backend never stores a stage. Order is
 * load-bearing — diagnosis is the EARLIEST failing stage, and "earliest" is
 * index order here.
 */

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

export const JOURNEY_STAGES: readonly JourneyStage[] = [
  {
    id: "connection",
    num: "01",
    title: "Connection",
    question: "Could the configured client establish a session?",
  },
  {
    id: "discovery",
    num: "02",
    title: "Discovery",
    question: "Did the client receive usable primitives and metadata?",
  },
  {
    id: "selection",
    num: "03",
    title: "Selection",
    question: "Did the agent choose an appropriate primitive?",
  },
  {
    id: "call",
    num: "04",
    title: "Tool call",
    question: "Were the arguments valid and faithful to intent?",
  },
  {
    id: "response",
    num: "05",
    title: "Tool response",
    question: "Did the server return an honest, usable result?",
  },
  {
    id: "value",
    num: "06",
    title: "User value",
    question: "Did the configured system complete the original task?",
  },
] as const;

/** Index of a stage in chain order — the "earliest failing stage" ordering. */
export function journeyStageIndex(id: JourneyStageId): number {
  return JOURNEY_STAGES.findIndex((stage) => stage.id === id);
}

export function journeyStageTitle(id: JourneyStageId): string {
  return JOURNEY_STAGES[journeyStageIndex(id)]!.title;
}
