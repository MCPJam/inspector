import type { LucideIcon } from "lucide-react";

export type ArchNodeStatus = "complete" | "current" | "pending" | "neutral";

export type HandlePosition = "top" | "right" | "bottom" | "left";

/** Data for a block node (individual component in the architecture) */
export interface ArchBlockNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  icon?: LucideIcon;
  color: string;
  status: ArchNodeStatus;
  width?: number;
  height?: number;
}

/** Data for a group/container node */
export interface ArchGroupNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  color: string;
  status: ArchNodeStatus;
  width: number;
  height: number;
}

/** Edge data */
export interface ArchEdgeData extends Record<string, unknown> {
  stepId?: string;
  label?: string;
  status: ArchNodeStatus;
  pathType?: "smoothstep" | "bezier" | "straight";
}

/** Data-driven architecture node definition */
export interface ArchNodeDef {
  id: string;
  label: string;
  subtitle?: string;
  icon?: LucideIcon;
  color: string;
  type: "block" | "group";
  /** When omitted, auto-layout computes the position */
  position?: { x: number; y: number };
  parentId?: string;
  width?: number;
  height?: number;
}

/** Data-driven architecture edge definition */
export interface ArchEdgeDef {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Which side of the source node the edge leaves from */
  sourceHandle?: HandlePosition;
  /** Which side of the target node the edge enters */
  targetHandle?: HandlePosition;
  /** Edge path algorithm (default: "smoothstep") */
  pathType?: "smoothstep" | "bezier" | "straight";
  /** Render arrows on both ends */
  bidirectional?: boolean;
}

/** Complete architecture diagram scenario */
export interface ArchDiagramScenario {
  nodes: ArchNodeDef[];
  edges: ArchEdgeDef[];
}

/** Maps a walkthrough step to which nodes/edges are highlighted */
export interface StepHighlightMap {
  activeNodes: string[];
  activeEdges: string[];
}
