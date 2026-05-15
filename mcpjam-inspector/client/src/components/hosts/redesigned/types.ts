import type { Edge, Node } from "@xyflow/react";
import type { HostConfigInputV2, HostStyleId } from "@/lib/host-config-v2";

/**
 * Identifiers for the focus-overlay tabs. Mirrors the header tab order in
 * the Harness design handoff (Agent → MCP Protocol → Apps Extension →
 * Servers → General).
 */
export type HostFocusTabId =
  | "general"
  | "behavior"
  | "protocol"
  | "apps"
  | "servers";

/** Where the user clicked to open the focus overlay. Drives return-focus. */
export type HostFocusOriginNodeId = string | null;

export type HostFocusState =
  | { open: false; tab: null; selectedServerId: null }
  | {
      open: true;
      tab: HostFocusTabId;
      selectedServerId: string | null;
    };

export interface HostAttentionIssue {
  level: "warning" | "error";
  tab: HostFocusTabId;
  field: string;
  message: string;
}

/** ============== Canvas node data types ============== */

/**
 * The parent group node that wraps the three sub-nodes. Renders only the
 * dashed-border container and the floating label strip showing the host
 * name at the top edge. Not selectable — clicks pass through to children.
 */
export interface HostGroupNodeData extends Record<string, unknown> {
  kind: "host-group";
  hostName: string;
}

export interface BehaviorSubNodeData extends Record<string, unknown> {
  kind: "behavior";
  modelId: string;
  modelLabel: string;
  modelProvider: string | null;
  temperature: number;
  hostStyle: HostStyleId;
  hostStyleLabel: string;
  toolApproval: boolean;
  systemPromptEmpty: boolean;
  attentionFields: ReadonlyArray<string>;
}

export interface ProtocolSubNodeData extends Record<string, unknown> {
  kind: "protocol";
  clientInfoSummary: string;
  protocolVersionsSummary: string;
  capabilitiesSummary: string;
  hostContextSummary: string;
  connectionSummary: string;
  attentionFields: ReadonlyArray<string>;
}

export interface AppsExtensionSubNodeData extends Record<string, unknown> {
  kind: "apps";
  enabled: boolean;
  mimeTypesSummary: string;
  hostCapabilitiesCount: number;
  hasOverride: boolean;
  sandboxModeLabel: string;
  openLinksOn: boolean;
  messageOn: boolean;
  updateModelContextLabel: string;
  attentionFields: ReadonlyArray<string>;
}

export interface ServersHubNodeData extends Record<string, unknown> {
  kind: "servers-hub";
  totalCount: number;
}

export interface ServerCardNodeData extends Record<string, unknown> {
  kind: "server-card";
  serverId: string;
  name: string;
  url: string | null;
  isOptional: boolean;
  insecure: boolean;
  hasOverride: boolean;
}

export interface AddServerPillNodeData extends Record<string, unknown> {
  kind: "add-server";
  label: string;
}

export type HostRedesignNodeData =
  | HostGroupNodeData
  | BehaviorSubNodeData
  | ProtocolSubNodeData
  | AppsExtensionSubNodeData
  | ServersHubNodeData
  | ServerCardNodeData
  | AddServerPillNodeData;

export type HostRedesignNodeType =
  | "redesignHostGroup"
  | "redesignBehavior"
  | "redesignProtocol"
  | "redesignApps"
  | "redesignServersHub"
  | "redesignServerCard"
  | "redesignAddServer";

export type HostRedesignFlowNode =
  | Node<HostGroupNodeData, "redesignHostGroup">
  | Node<BehaviorSubNodeData, "redesignBehavior">
  | Node<ProtocolSubNodeData, "redesignProtocol">
  | Node<AppsExtensionSubNodeData, "redesignApps">
  | Node<ServersHubNodeData, "redesignServersHub">
  | Node<ServerCardNodeData, "redesignServerCard">
  | Node<AddServerPillNodeData, "redesignAddServer">;

export interface HostRedesignViewModel {
  hostName: string;
  nodes: HostRedesignFlowNode[];
  edges: Edge[];
  attention: ReadonlyArray<HostAttentionIssue>;
}

/** Snapshot id chip uses a stable short form `hc_xxxx` for display. */
export function shortenSnapshotId(id: string): string {
  if (!id) return "—";
  // Convex ids are long opaque tokens; the handoff design uses an `hc_xxxx`
  // pattern. We take the last 4 chars to keep it visually stable across
  // saves while still rotating when the id changes.
  const tail = id.replace(/[^a-zA-Z0-9]/g, "").slice(-4) || id.slice(-4);
  return `hc_${tail.toLowerCase()}`;
}

/** Builder context shared by canvas/draft consumers. */
export interface HostRedesignContext {
  hostName: string;
  draft: HostConfigInputV2;
  savedSnapshotId: string;
  isDirty: boolean;
  projectServers: ReadonlyArray<{ id: string; name: string; url?: string }>;
}

/** Stable ids for the canvas-level nodes. */
export const HOST_GROUP_NODE_ID = "host-group";
export const BEHAVIOR_NODE_ID = "host-group:behavior";
export const PROTOCOL_NODE_ID = "host-group:protocol";
export const APPS_NODE_ID = "host-group:apps";
export const SERVERS_HUB_NODE_ID = "servers-hub";
export const ADD_SERVER_NODE_ID = "add-server";

/** Returns the focus tab a clicked node should open in the overlay. */
export function focusTabForNodeId(
  nodeId: string,
): { tab: HostFocusTabId; selectedServerId: string | null } | null {
  if (nodeId === HOST_GROUP_NODE_ID) {
    return { tab: "general", selectedServerId: null };
  }
  if (nodeId === BEHAVIOR_NODE_ID) {
    return { tab: "behavior", selectedServerId: null };
  }
  if (nodeId === PROTOCOL_NODE_ID) return { tab: "protocol", selectedServerId: null };
  if (nodeId === APPS_NODE_ID) return { tab: "apps", selectedServerId: null };
  if (nodeId === SERVERS_HUB_NODE_ID) {
    return { tab: "servers", selectedServerId: null };
  }
  if (nodeId.startsWith("server-card:")) {
    return {
      tab: "servers",
      selectedServerId: nodeId.slice("server-card:".length),
    };
  }
  return null;
}
