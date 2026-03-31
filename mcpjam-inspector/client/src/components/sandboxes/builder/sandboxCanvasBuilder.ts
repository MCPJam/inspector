import type { Edge, Node } from "@xyflow/react";
import type {
  SandboxBuilderContext,
  SandboxBuilderNodeData,
  SandboxBuilderViewModel,
  SandboxFlowNode,
} from "./types";
import { getSandboxHostStyleShortLabel } from "@/lib/sandbox-host-style";
import { getModelById } from "@/shared/types";

const SECTION_Y = {
  host: 0,
  servers: 220,
} as const;

function createNode(
  id: string,
  x: number,
  y: number,
  data: SandboxBuilderNodeData,
): Node<SandboxBuilderNodeData, "sandboxNode"> {
  return {
    id,
    type: "sandboxNode",
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
  context: SandboxBuilderContext,
): SandboxBuilderNodeData {
  const source = context.sandbox ?? context.draft;
  const modelName = source
    ? (getModelById(source.modelId)?.name ?? source.modelId)
    : "Model";
  return {
    kind: "host",
    title: "Host",
    subtitle: source?.name || "New sandbox",
    chips: [
      chip(
        source
          ? getSandboxHostStyleShortLabel(source.hostStyle)
          : getSandboxHostStyleShortLabel("claude"),
      ),
      chip(modelName),
      chip(source ? `Temp ${source.temperature.toFixed(2)}` : "Temp 0.70"),
    ],
    state: source ? "ready" : "draft",
  };
}

function resolveServerState(
  serverId: string,
  context: SandboxBuilderContext,
): SandboxBuilderNodeData {
  const source = context.sandbox ?? context.draft;
  const selected = source
    ? "servers" in source
      ? source.servers.map((server) => server.serverId)
      : source.selectedServerIds
    : [];
  const server =
    context.workspaceServers.find((item) => item._id === serverId) ?? null;
  const insecure = server?.url?.startsWith("http://") ?? false;

  return {
    kind: "server",
    title: server?.name ?? "Server",
    subtitle: server?.url ?? "Workspace server",
    chips: [
      chip(server?.useOAuth ? "OAuth" : "Direct"),
      chip(
        insecure ? "Requires HTTPS" : "HTTPS",
        insecure ? "warning" : "success",
      ),
    ],
    state: !selected.includes(serverId)
      ? "draft"
      : insecure
        ? "attention"
        : "ready",
    serverId,
  };
}

const NODE_WIDTH = 220;
const NODE_GAP = 40;
const COL_PITCH = NODE_WIDTH + NODE_GAP; // 260

function centerRow(rowCount: number, totalWidth: number): number {
  return (totalWidth - rowCount * COL_PITCH + NODE_GAP) / 2;
}

export function buildSandboxCanvas(
  context: SandboxBuilderContext,
): SandboxBuilderViewModel {
  const sandboxOrDraft = context.sandbox ?? context.draft;
  const selectedServerIds = sandboxOrDraft
    ? "servers" in sandboxOrDraft
      ? sandboxOrDraft.servers.map((server) => server.serverId)
      : sandboxOrDraft.selectedServerIds
    : [];

  const nodeMap: Record<string, SandboxBuilderNodeData> = {
    host: resolveHostState(context),
  };

  const serverRowCount = Math.max(1, selectedServerIds.length);
  const totalWidth = Math.max(1, serverRowCount) * COL_PITCH - NODE_GAP;

  const hostX = (totalWidth - NODE_WIDTH) / 2;
  const serverX = centerRow(serverRowCount, totalWidth);

  const nodes: SandboxFlowNode[] = [
    createNode("host", hostX, SECTION_Y.host + 44, nodeMap.host),
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
      source: "host",
      target: `server:${serverId}`,
      ...edgeDefaults,
    })),
  ];

  return {
    title: sandboxOrDraft?.name || "New Sandbox",
    description: sandboxOrDraft?.description ?? "",
    nodeMap,
    nodes,
    edges,
  };
}
