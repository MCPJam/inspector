import type { ReactNode } from "react";

export type NodeStatus = "complete" | "current" | "pending" | "neutral";

/**
 * Data-driven actor definition for sequence diagrams.
 * Each actor becomes a swimlane column in the diagram.
 */
export interface SequenceDiagramActorConfig {
  id: string;
  label: string;
  color: string;
}

/**
 * Action definition for sequence diagram.
 * Represents a message/arrow between two actors.
 */
export interface SequenceDiagramAction {
  id: string;
  label: string;
  description: string;
  from: string;
  to: string;
  details?: Array<{ label: string; value: ReactNode }>;
}

/**
 * Configuration for auto-zoom behavior.
 * When omitted, no auto-zoom occurs (static view, user controls viewport).
 */
export interface DiagramZoomConfig {
  /** Step ID that represents the idle/initial state (zoom to top) */
  idleStepId?: string;
  /** Step ID that represents the complete state (stop auto-zooming) */
  completeStepId?: string;
}

// Actor/Swimlane node data — same shape as OAuth's ActorNodeData
export interface ActorNodeData extends Record<string, unknown> {
  label: string;
  color: string;
  totalHeight: number;
  segments: Array<{
    id: string;
    type: "box" | "line";
    height: number;
    handleId?: string;
  }>;
}

// Edge data for action labels — same shape as OAuth's ActionEdgeData
export interface ActionEdgeData extends Record<string, unknown> {
  label: string;
  description: string;
  status: NodeStatus;
  details?: Array<{ label: string; value: ReactNode }>;
}
