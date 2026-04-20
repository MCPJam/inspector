import type { Edge, Node } from "@xyflow/react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import type {
  ChatboxBuilderContext,
  ChatboxDraftConfig,
  ChatboxBuilderNodeData,
  ChatboxBuilderViewModel,
  ChatboxFlowNode,
} from "./types";
import { getModelById } from "@/shared/types";
import {
  CHATBOX_BUILDER_HOST_NODE_ID,
  CHATBOX_BUILDER_NODE_WIDTH,
} from "./chatbox-canvas-viewport";

const SECTION_Y = {
  host: 0,
  servers: 220,
} as const;

/**
 * Single source of truth for builder canvas vs Setup rail: prefer the in-memory draft
 * when present so nodes match MCP server selection before save. `chatbox` is only
 * used when there is no draft (e.g. hypothetical read-only callers).
 */
function getCanvasSource(
  context: ChatboxBuilderContext,
): ChatboxSettings | ChatboxDraftConfig | null {
  return context.draft ?? context.chatbox;
}

function optionalServerIdsFromSource(
  source: ChatboxSettings | ChatboxDraftConfig | null,
): string[] {
  if (!source) return [];
  if ("optionalServerIds" in source) return source.optionalServerIds;
  return source.servers.filter((s) => s.optional).map((s) => s.serverId);
}

function createNode(
  id: string,
  x: number,
  y: number,
  data: ChatboxBuilderNodeData,
): Node<ChatboxBuilderNodeData, "chatboxNode"> {
  return {
    id,
    type: "chatboxNode",
    position: { x, y },
    data,
    draggable: false,
  };
}

function chip(
  label: string,
  tone: "neutral" | "success" | "warning" | "info" = "neutral",
) {
  return { label, tone };
}
function resolveHostState(
  context: ChatboxBuilderContext,
): ChatboxBuilderNodeData {
  const source = getCanvasSource(context);
  const modelName = source
    ? (getModelById(source.modelId)?.name ?? source.modelId)
    : "Model";
  const hostStyle = source?.hostStyle ?? "claude";
  return {
    kind: "host",
    title: "Chat Interface",
    subtitle: source?.name?.trim() || "Untitled chatbox",
    detailLine: `Model · ${modelName}`,
    hostStyle,
    chips: [],
    state: source ? "ready" : "draft",
  };
}

function resolveServerState(
  serverId: string,
  context: ChatboxBuilderContext,
): ChatboxBuilderNodeData {
  const source = getCanvasSource(context);
  const selected = source
    ? "servers" in source
      ? source.servers.map((server) => server.serverId)
      : source.selectedServerIds
    : [];
  const optionalIds = optionalServerIdsFromSource(source);
  const server =
    context.workspaceServers.find((item) => item._id === serverId) ?? null;
  const insecure = server?.url?.startsWith("http://") ?? false;

  const chips: ChatboxBuilderNodeData["chips"] = [];
  if (optionalIds.includes(serverId)) {
    chips.push(chip("Optional", "info"));
  }

  return {
    kind: "server",
    title: server?.name ?? "Server",
    subtitle: server?.url ?? "Workspace server",
    chips,
    state: !selected.includes(serverId)
      ? "draft"
      : insecure
        ? "attention"
        : "ready",
    serverId,
  };
}

const NODE_GAP = 40;
const COL_PITCH = CHATBOX_BUILDER_NODE_WIDTH + NODE_GAP;

function centerRow(rowCount: number, totalWidth: number): number {
  return (totalWidth - rowCount * COL_PITCH + NODE_GAP) / 2;
}

export function buildChatboxCanvas(
  context: ChatboxBuilderContext,
): ChatboxBuilderViewModel {
  const chatboxOrDraft = getCanvasSource(context);
  const selectedServerIds = chatboxOrDraft
    ? "servers" in chatboxOrDraft
      ? chatboxOrDraft.servers.map((server) => server.serverId)
      : chatboxOrDraft.selectedServerIds
    : [];

  const nodeMap: Record<string, ChatboxBuilderNodeData> = {
    [CHATBOX_BUILDER_HOST_NODE_ID]: resolveHostState(context),
  };

  const serverRowCount = Math.max(1, selectedServerIds.length);
  const totalWidth = Math.max(1, serverRowCount) * COL_PITCH - NODE_GAP;

  const hostX = (totalWidth - CHATBOX_BUILDER_NODE_WIDTH) / 2;
  const serverX = centerRow(serverRowCount, totalWidth);

  const nodes: ChatboxFlowNode[] = [
    createNode(
      CHATBOX_BUILDER_HOST_NODE_ID,
      hostX,
      SECTION_Y.host + 44,
      nodeMap[CHATBOX_BUILDER_HOST_NODE_ID],
    ),
  ];

  selectedServerIds.forEach((serverId, index) => {
    const id = `server:${serverId}`;
    const x = serverX + index * COL_PITCH;
    const serverNode = resolveServerState(serverId, context);
    nodeMap[id] = serverNode;
    nodes.push(createNode(id, x, SECTION_Y.servers + 44, serverNode));
  });

  const edgeDefaults = {
    type: "smoothRound" as const,
    style: { stroke: "oklch(0.68 0.11 40 / 0.5)", strokeWidth: 1.5 },
    sourceHandle: "bottom",
    targetHandle: "top",
  };
  const edges: Edge[] = [
    ...selectedServerIds.map((serverId) => ({
      id: `host-server-${serverId}`,
      source: CHATBOX_BUILDER_HOST_NODE_ID,
      target: `server:${serverId}`,
      ...edgeDefaults,
    })),
  ];

  return {
    title: chatboxOrDraft?.name || "New Chatbox",
    description: chatboxOrDraft?.description ?? "",
    nodeMap,
    nodes,
    edges,
  };
}
