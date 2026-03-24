export type ArchNodeStatus = "complete" | "current" | "pending" | "neutral";

/** Data for a block node (individual component in the architecture) */
export interface ArchBlockNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  icon?: string;
  color: string;
  status: ArchNodeStatus;
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
}

/** Data-driven architecture node definition */
export interface ArchNodeDef {
  id: string;
  label: string;
  subtitle?: string;
  icon?: string;
  color: string;
  type: "block" | "group";
  position: { x: number; y: number };
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
