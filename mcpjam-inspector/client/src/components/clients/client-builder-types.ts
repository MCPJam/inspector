import type { Edge, Node } from "@xyflow/react";
import type { HostConfigInputV2, HostStyleId } from "@/lib/host-config-v2";

export type HostBuilderNodeKind = "host" | "server";

export type HostBuilderNodeState = "ready" | "attention" | "draft";

export type HostSetupSectionId = "basics" | "servers";

export type HostSectionStatusKind = "complete" | "attention" | "optional";

export interface HostBuilderChip {
  label: string;
  tone?: "neutral" | "success" | "warning" | "info";
}

export interface HostBuilderNodeData extends Record<string, unknown> {
  kind: HostBuilderNodeKind;
  title: string;
  subtitle?: string;
  /** Extra line under subtitle (e.g. model name on the host card). */
  detailLine?: string;
  chips: HostBuilderChip[];
  state: HostBuilderNodeState;
  serverId?: string;
  /** Host card only: drives the host-style logo on the canvas. */
  hostStyle?: HostStyleId;
}

export interface HostBuilderAddServerNodeData extends Record<string, unknown> {
  label: string;
}

export interface HostBuilderContext {
  hostName: string;
  draft: HostConfigInputV2;
  projectServers: Array<{ id: string; name: string; url?: string }>;
}

export type HostFlowNode =
  | Node<HostBuilderNodeData, "hostNode">
  | Node<HostBuilderAddServerNodeData, "hostAddServerNode">;

export interface HostBuilderViewModel {
  title: string;
  nodes: HostFlowNode[];
  edges: Edge[];
}

export const HOST_BUILDER_HOST_NODE_ID = "host";
export const HOST_BUILDER_ADD_SERVER_NODE_ID = "add-server";
