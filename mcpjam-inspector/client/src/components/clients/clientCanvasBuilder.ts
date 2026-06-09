import type { Edge, Node } from "@xyflow/react";
import { getModelById } from "@/shared/types";
import {
  HOST_BUILDER_ADD_SERVER_NODE_ID,
  HOST_BUILDER_HOST_NODE_ID,
  type HostBuilderAddServerNodeData,
  type HostBuilderChip,
  type HostBuilderContext,
  type HostBuilderNodeData,
  type HostBuilderViewModel,
  type HostFlowNode,
} from "./client-builder-types";

/**
 * Layout constants. Host card at the top, an add-server pseudo-node in
 * the middle, then a vertical stack of server cards below. Spacing is
 * tighter than the chatbox builder because hosts don't render a tools
 * collapsible on each server card.
 */
const HOST_NODE_Y = 0;
const ADD_SERVER_NODE_Y = 180;
const FIRST_SERVER_Y = 300;
const SERVER_ROW_GAP = 120;
const NODE_X = 0;

const NODE_WIDTH = 280;
const ADD_SERVER_OFFSET_X = (NODE_WIDTH - 40) / 2;

function hostChip(
  label: string,
  tone: HostBuilderChip["tone"] = "neutral",
): HostBuilderChip {
  return { label, tone };
}

function createHostNode(
  data: HostBuilderNodeData,
): Node<HostBuilderNodeData, "hostNode"> {
  return {
    id: HOST_BUILDER_HOST_NODE_ID,
    type: "hostNode",
    position: { x: NODE_X, y: HOST_NODE_Y },
    data,
    draggable: false,
  };
}

function createServerNode(
  serverId: string,
  index: number,
  data: HostBuilderNodeData,
): Node<HostBuilderNodeData, "hostNode"> {
  return {
    id: `server:${serverId}`,
    type: "hostNode",
    position: { x: NODE_X, y: FIRST_SERVER_Y + index * SERVER_ROW_GAP },
    data,
    draggable: false,
  };
}

function createAddServerNode(): Node<
  HostBuilderAddServerNodeData,
  "hostAddServerNode"
> {
  return {
    id: HOST_BUILDER_ADD_SERVER_NODE_ID,
    type: "hostAddServerNode",
    position: { x: NODE_X + ADD_SERVER_OFFSET_X, y: ADD_SERVER_NODE_Y },
    data: { label: "Add server" },
    draggable: false,
    selectable: false,
  };
}

function resolveHostData(context: HostBuilderContext): HostBuilderNodeData {
  const { draft, hostName } = context;
  const modelName = draft.modelId
    ? (getModelById(draft.modelId)?.name ?? draft.modelId)
    : "No model selected";
  return {
    kind: "host",
    title: "Host",
    subtitle: hostName.trim() || "Untitled host",
    detailLine: `Model · ${modelName}`,
    hostStyle: draft.hostStyle,
    chips: [],
    state: "ready",
  };
}

function resolveServerData(
  serverId: string,
  context: HostBuilderContext,
): HostBuilderNodeData {
  const server =
    context.projectServers.find((item) => item.id === serverId) ?? null;
  const url = server?.url;
  const insecure = typeof url === "string" && url.startsWith("http://");
  const isOptional = context.draft.optionalServerIds.includes(serverId);

  const chips: HostBuilderChip[] = [];
  if (isOptional) chips.push(hostChip("Optional", "info"));
  if (insecure) chips.push(hostChip("Insecure", "warning"));

  return {
    kind: "server",
    title: server?.name ?? "Server",
    subtitle: url ?? "Project server",
    chips,
    state: insecure ? "attention" : "ready",
    serverId,
  };
}

export function buildHostCanvas(
  context: HostBuilderContext,
): HostBuilderViewModel {
  const { draft } = context;

  // Union required + optional, preserving required order then appending
  // optional ids that aren't already in serverIds.
  const seen = new Set<string>();
  const orderedServerIds: string[] = [];
  for (const id of draft.serverIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    orderedServerIds.push(id);
  }
  for (const id of draft.optionalServerIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    orderedServerIds.push(id);
  }

  const nodes: HostFlowNode[] = [
    createHostNode(resolveHostData(context)),
    createAddServerNode(),
  ];

  orderedServerIds.forEach((serverId, index) => {
    nodes.push(createServerNode(serverId, index, resolveServerData(serverId, context)));
  });

  const edges: Edge[] = orderedServerIds.map((serverId) => ({
    id: `host-server-${serverId}`,
    source: HOST_BUILDER_HOST_NODE_ID,
    target: `server:${serverId}`,
    type: "default",
    style: { stroke: "oklch(0.68 0.11 40 / 0.5)", strokeWidth: 1.5 },
    sourceHandle: "bottom",
    targetHandle: "top",
  }));

  return {
    title: context.hostName.trim() || "Untitled host",
    nodes,
    edges,
  };
}
