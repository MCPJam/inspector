import type { ReactNode } from "react";

export type NodeStatus = "complete" | "current" | "pending";

// Actor/Swimlane node types
export interface ActorNodeData extends Record<string, unknown> {
  label: string;
  color: string;
  totalHeight: number; // Total height for alignment
  segments: Array<{
    id: string;
    type: "box" | "line";
    height: number;
    handleId?: string;
  }>;
}

// Edge data for action labels
export interface ActionEdgeData extends Record<string, unknown> {
  label: string;
  description: string;
  status: NodeStatus;
  details?: Array<{ label: string; value: ReactNode }>;
}

// Action definition for sequence diagram
export interface Action {
  id: string;
  label: string;
  description: string;
  from: string;
  to: string;
  details?: Array<{ label: string; value: ReactNode }>;
}
