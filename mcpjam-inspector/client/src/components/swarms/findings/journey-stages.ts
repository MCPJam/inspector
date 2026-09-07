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

/** The two sides of the wire, in reading order. */
export type JourneyLaneId = "client" | "server";

export interface JourneyLane {
  id: JourneyLaneId;
  label: string;
}

export const JOURNEY_LANES: readonly JourneyLane[] = [
  { id: "client", label: "Client / agent" },
  { id: "server", label: "Server" },
] as const;

export interface JourneyStage {
  id: JourneyStageId;
  /** Two-digit ordinal for the stage button ("01"…"06"). */
  num: string;
  title: string;
  /** The question the stage answers about the experience. */
  question: string;
  /**
   * Which side should look next when this stage is the diagnosis — see
   * `docs/uvc-client-server-swimlane.md`. A lane is a LOCATION, not a
   * verdict on authorship: Tool Call sits on the server because that is
   * who inspects the payload, even though the agent composed it.
   */
  lane: JourneyLaneId;
}

export const JOURNEY_STAGES: readonly JourneyStage[] = [
  {
    id: "connection",
    num: "01",
    title: "Connection",
    question: "Can the user establish a connection to your server?",
    lane: "client",
  },
  {
    id: "discovery",
    num: "02",
    title: "Discovery",
    question: "Does the agent know your tools exist?",
    lane: "client",
  },
  {
    id: "selection",
    num: "03",
    title: "Tool Selection",
    question: "Did the agent choose the right tool for the user's intent?",
    lane: "client",
  },
  {
    id: "call",
    num: "04",
    title: "Tool Call",
    question: "Were the arguments valid, and faithful to the user intent?",
    lane: "server",
  },
  {
    id: "response",
    num: "05",
    title: "Tool Response",
    question:
      "Did your tool return the correct result with acceptable latency and/or clear errors, and did the agent interpret and render it correctly for the user?",
    lane: "server",
  },
  {
    id: "value",
    num: "06",
    title: "User Value",
    question: "Did the user get what they came for?",
    lane: "client",
  },
] as const;

/** Index of a stage in chain order — the "earliest failing stage" ordering. */
export function journeyStageIndex(id: JourneyStageId): number {
  return JOURNEY_STAGES.findIndex((stage) => stage.id === id);
}

export function journeyStageTitle(id: JourneyStageId): string {
  return JOURNEY_STAGES[journeyStageIndex(id)]!.title;
}

/** True when the stage sits on the other side of the wire from the one before it. */
export function journeyStageCrossesWire(id: JourneyStageId): boolean {
  const index = journeyStageIndex(id);
  const previous = JOURNEY_STAGES[index - 1];
  return Boolean(previous && previous.lane !== JOURNEY_STAGES[index]!.lane);
}

export function journeyLaneLabel(id: JourneyLaneId): string {
  return JOURNEY_LANES.find((lane) => lane.id === id)!.label;
}
