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
 * Dashed parent group that wraps every sub-node for a host. Sized
 * dynamically by the builder to fit the agent card + the protocol/apps
 * hub fan-outs, so the silhouette differs per host.
 */
export interface HostGroupNodeData extends Record<string, unknown> {
  kind: "host-group";
  hostName: string;
}

/**
 * Agent identity card. Stays as a single node — the agent's fields
 * (model, temperature, host style, tool approval, system prompt) form
 * a portrait, not a list, so atomizing them wouldn't add information.
 */
export interface AgentIdentityNodeData extends Record<string, unknown> {
  kind: "agent-identity";
  modelId: string;
  modelLabel: string;
  modelProvider: string | null;
  temperature: number;
  hostStyle: HostStyleId;
  hostStyleLabel: string;
  toolApproval: boolean;
  systemPromptEmpty: boolean;
  attentionFields: ReadonlyArray<string>;
  changedFields: ReadonlyArray<string>;
}

/**
 * Small puck node that anchors a section's fan-out (Protocol or Apps).
 * `kind` distinguishes the two so a single renderer can paint both with
 * the right icon/accent. `subtitle` is optional; currently used only on
 * the protocol hub when versions are pinned (e.g. "pinned 2026-01-26").
 */
export interface SectionHubNodeData extends Record<string, unknown> {
  kind: "section-hub";
  section: "protocol" | "apps";
  title: string;
  subtitle: string;
  /** Subtitle differs from the previous host — drives the morph flash. */
  subtitleChanged: boolean;
  hasAttention: boolean;
}

/**
 * One leaf per protocol slice that's actually overridden. Slices that
 * track SDK defaults stay collapsed into the hub. Stable `leafKey`
 * mirrors the validation field names so a click can deep-link the focus
 * panel to the right input.
 */
export type ProtocolLeafKey =
  | "clientInfo"
  | "protocolVersion"
  | "capabilities"
  | "hostContext"
  | "timeout"
  | "headers";

export interface ProtocolLeafNodeData extends Record<string, unknown> {
  kind: "protocol-leaf";
  leafKey: ProtocolLeafKey;
  label: string;
  value: string;
  isChanged: boolean;
  hasAttention: boolean;
}

/**
 * One leaf per Apps capability. Off capabilities still render — dimmed
 * and struck-through — because the *absence* of a cap is the most
 * informative thing about hosts like Cursor that don't advertise
 * `updateModelContext` or `message`.
 */
export type AppsCapLeafKey =
  | "openLinks"
  | "serverTools"
  | "serverResources"
  | "logging"
  | "updateModelContext"
  | "message";

export interface AppsCapLeafNodeData extends Record<string, unknown> {
  kind: "apps-cap-leaf";
  capKey: AppsCapLeafKey;
  label: string;
  on: boolean;
  /** Short qualifier shown as a tag: "text", "lc:false", etc. */
  qualifier: string | null;
  isChanged: boolean;
  /** Flipped from off → on on the last morph; renders the halo glow. */
  isNewlyOn: boolean;
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
  | AgentIdentityNodeData
  | SectionHubNodeData
  | ProtocolLeafNodeData
  | AppsCapLeafNodeData
  | ServersHubNodeData
  | ServerCardNodeData
  | AddServerPillNodeData;

export type HostRedesignNodeType =
  | "redesignHostGroup"
  | "redesignAgentIdentity"
  | "redesignSectionHub"
  | "redesignProtocolLeaf"
  | "redesignAppsCapLeaf"
  | "redesignServersHub"
  | "redesignServerCard"
  | "redesignAddServer";

export type HostRedesignFlowNode =
  | Node<HostGroupNodeData, "redesignHostGroup">
  | Node<AgentIdentityNodeData, "redesignAgentIdentity">
  | Node<SectionHubNodeData, "redesignSectionHub">
  | Node<ProtocolLeafNodeData, "redesignProtocolLeaf">
  | Node<AppsCapLeafNodeData, "redesignAppsCapLeaf">
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
  /**
   * Previous host's config + display name, captured by the builder view
   * on host switch. When present, the builder marks leaves/fields whose
   * value differs as `isChanged`, which drives the morph diff flash.
   * Undefined on first paint and during in-place edits.
   */
  prev?: {
    hostName: string;
    draft: HostConfigInputV2;
  };
}

/** Stable ids for the canvas-level nodes. */
export const HOST_GROUP_NODE_ID = "host-group";
export const AGENT_IDENTITY_NODE_ID = "host-group:agent";
export const PROTOCOL_HUB_NODE_ID = "host-group:protocol-hub";
export const APPS_HUB_NODE_ID = "host-group:apps-hub";
export const SERVERS_HUB_NODE_ID = "servers-hub";
export const ADD_SERVER_NODE_ID = "add-server";

/** Leaf id constructors — stable across hosts so RF can morph in place. */
export function protocolLeafNodeId(key: ProtocolLeafKey): string {
  return `protocol-leaf:${key}`;
}
export function appsCapLeafNodeId(key: AppsCapLeafKey): string {
  return `apps-cap:${key}`;
}

/** Returns the focus tab a clicked node should open in the overlay. */
export function focusTabForNodeId(
  nodeId: string,
): { tab: HostFocusTabId; selectedServerId: string | null } | null {
  if (nodeId === HOST_GROUP_NODE_ID) {
    return { tab: "general", selectedServerId: null };
  }
  if (nodeId === AGENT_IDENTITY_NODE_ID) {
    return { tab: "behavior", selectedServerId: null };
  }
  // hostContext is a protocol-leaf-shaped node but lives under the
  // apps hub, so route it to the apps tab.
  if (nodeId === protocolLeafNodeId("hostContext")) {
    return { tab: "apps", selectedServerId: null };
  }
  if (
    nodeId === PROTOCOL_HUB_NODE_ID ||
    nodeId.startsWith("protocol-leaf:")
  ) {
    return { tab: "protocol", selectedServerId: null };
  }
  if (nodeId === APPS_HUB_NODE_ID || nodeId.startsWith("apps-cap:")) {
    return { tab: "apps", selectedServerId: null };
  }
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
