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
  /** Small brand marks above the label (e.g. Claude + OpenAI); takes precedence over icon/image in compact layout */
  logos?: Array<{ src: string; alt: string }>;
  /** Optional image rendered below the label (replaces icon when set) */
  imageSrc?: string;
  imageAlt?: string;
}

/** Data for a group/container node */
export interface ArchGroupNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  color: string;
  status: ArchNodeStatus;
  width: number;
  height: number;
  /** Small logo images displayed in the header area */
  logos?: Array<{ src: string; alt: string }>;
}

/** Data for a node that embeds a code snippet or image */
export interface ArchAssetNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  icon?: LucideIcon;
  color: string;
  status: ArchNodeStatus;
  width: number;
  height: number;
  assetType: "code" | "image";
  code?: string;
  codeLang?: string;
  imageSrc?: string;
  imageAlt?: string;
  compact?: boolean;
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
  type: "block" | "group" | "asset";
  /** When omitted, auto-layout computes the position */
  position?: { x: number; y: number };
  parentId?: string;
  width?: number;
  height?: number;
  assetType?: "code" | "image";
  code?: string;
  codeLang?: string;
  imageSrc?: string;
  imageAlt?: string;
  compact?: boolean;
  /** Small logo images (group header or compact block) */
  logos?: Array<{ src: string; alt: string }>;
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
