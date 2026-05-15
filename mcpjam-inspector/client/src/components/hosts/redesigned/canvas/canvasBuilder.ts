import type { Edge } from "@xyflow/react";
import { getModelById } from "@/shared/types";
import { findHostStyle } from "@/lib/host-styles";
import {
  resolveEffectiveHostCapabilities,
  resolveClientInfo,
  resolveSupportedProtocolVersions,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import {
  ADD_SERVER_NODE_ID,
  APPS_NODE_ID,
  BEHAVIOR_NODE_ID,
  HOST_GROUP_NODE_ID,
  PROTOCOL_NODE_ID,
  SERVERS_HUB_NODE_ID,
  type HostRedesignContext,
  type HostRedesignFlowNode,
  type HostRedesignViewModel,
  type HostAttentionIssue,
} from "../types";
import { fieldsWithIssues } from "../focus/useHostDraftValidation";

/**
 * Layout constants. The host group is a parent React Flow node with three
 * children laid out horizontally inside it. The servers hub + cards live
 * below the group as sibling nodes.
 *
 * Sub-node positions inside the parent group are HAND-TUNED constants —
 * we don't run auto-layout. Auto-layout libs (dagre/elk) don't traverse
 * RF's parent/child relationship cleanly and would lay out group and
 * children separately, leading to collisions.
 */
const GROUP_X = 0;
const GROUP_Y = 0;
const GROUP_PADDING_X = 16;
const GROUP_PADDING_TOP = 56;
const GROUP_PADDING_BOTTOM = 16;
const SUB_NODE_WIDTH = 268;
const SUB_NODE_HEIGHT = 232;
const SUB_NODE_GAP = 16;

const GROUP_WIDTH =
  GROUP_PADDING_X * 2 + SUB_NODE_WIDTH * 3 + SUB_NODE_GAP * 2;
const GROUP_HEIGHT = GROUP_PADDING_TOP + SUB_NODE_HEIGHT + GROUP_PADDING_BOTTOM;

const SERVERS_HUB_Y = GROUP_Y + GROUP_HEIGHT + 64;
const SERVERS_HUB_HEIGHT = 64;
const SERVER_CARD_WIDTH = 220;
const SERVER_CARD_HEIGHT = 88;
const SERVER_CARD_GAP_X = 16;
const SERVER_ROW_Y = SERVERS_HUB_Y + SERVERS_HUB_HEIGHT + 56;

function formatModelLabel(modelId: string): {
  label: string;
  provider: string | null;
} {
  if (!modelId) return { label: "No model selected", provider: null };
  const def = getModelById(modelId);
  if (def) return { label: def.name, provider: def.provider };
  return { label: modelId, provider: null };
}

function formatProtocolVersionsSummary(
  draft: HostConfigInputV2,
): string {
  const versions = resolveSupportedProtocolVersions(draft.mcpProfile);
  if (!versions || versions.length === 0) return "SDK defaults";
  if (versions.length === 1) return versions[0];
  return `${versions[0]} + ${versions.length - 1} more`;
}

function formatClientInfoSummary(draft: HostConfigInputV2): string {
  const ci = resolveClientInfo(draft.mcpProfile);
  if (!ci) return "@mcpjam/inspector (default)";
  const name = typeof ci.name === "string" ? ci.name : "(unnamed)";
  const version = typeof ci.version === "string" ? ci.version : "0.0.0";
  return `${name} ${version}`;
}

function formatBaseCapabilitiesSummary(
  draft: HostConfigInputV2,
): string {
  const caps = draft.clientCapabilities ?? {};
  const present: string[] = [];
  if (caps.roots) present.push("roots");
  if (caps.sampling) present.push("sampling");
  if (caps.experimental) present.push("experimental");
  if (present.length === 0) return "none";
  return present.join(" · ");
}

function formatHostContextSummary(draft: HostConfigInputV2): string {
  const hc = draft.hostContext ?? {};
  const keyCount = Object.keys(hc).length;
  if (keyCount === 0) return "{ }";
  return `{ ${keyCount} ${keyCount === 1 ? "field" : "fields"} }`;
}

function formatConnectionSummary(draft: HostConfigInputV2): string {
  const timeoutSecs = Math.round(
    draft.connectionDefaults.requestTimeout / 1000,
  );
  const headerCount = Object.keys(draft.connectionDefaults.headers ?? {})
    .length;
  return `${timeoutSecs}s · ${headerCount}`;
}

function formatMimeTypesSummary(draft: HostConfigInputV2): string {
  const ext = (draft.clientCapabilities?.extensions as
    | Record<string, unknown>
    | undefined)?.["io.modelcontextprotocol/ui"] as
    | { mimeTypes?: unknown }
    | undefined;
  if (!ext) return "off";
  const mimeTypes = Array.isArray(ext.mimeTypes)
    ? (ext.mimeTypes as unknown[]).filter(
        (m): m is string => typeof m === "string",
      )
    : [];
  if (mimeTypes.length === 0) return "On — no MIME types";
  if (mimeTypes.length === 1) return `On — ${mimeTypes[0]}`;
  return `On — ${mimeTypes[0]} + ${mimeTypes.length - 1}`;
}

function formatSandboxModeLabel(draft: HostConfigInputV2): string {
  const mode = draft.mcpProfile?.apps?.sandbox?.csp?.mode;
  if (!mode) return "host-default";
  return mode;
}

function isAppsExtensionEnabled(draft: HostConfigInputV2): boolean {
  const ext = (draft.clientCapabilities?.extensions as
    | Record<string, unknown>
    | undefined)?.["io.modelcontextprotocol/ui"];
  return ext !== undefined;
}

function countAdvertisedHostCapabilities(
  draft: HostConfigInputV2,
): number {
  const blob = resolveEffectiveHostCapabilities({
    hostStyle: draft.hostStyle,
    hostCapabilitiesOverride: draft.hostCapabilitiesOverride,
  });
  // Number of top-level keys present in the advertised blob.
  return Object.keys(blob).length;
}

function resolvedHostCapabilities(draft: HostConfigInputV2) {
  return resolveEffectiveHostCapabilities({
    hostStyle: draft.hostStyle,
    hostCapabilitiesOverride: draft.hostCapabilitiesOverride,
  }) as Record<string, unknown>;
}

export function buildRedesignedHostCanvas(
  context: HostRedesignContext,
  attention: ReadonlyArray<HostAttentionIssue>,
): HostRedesignViewModel {
  const { draft, hostName } = context;

  const behaviorAttention = fieldsWithIssues(attention, "behavior");
  const protocolAttention = fieldsWithIssues(attention, "protocol");
  const appsAttention = fieldsWithIssues(attention, "apps");
  const modelInfo = formatModelLabel(draft.modelId);
  const styleDef = findHostStyle(draft.hostStyle);
  const hostCaps = resolvedHostCapabilities(draft);

  const nodes: HostRedesignFlowNode[] = [];
  const edges: Edge[] = [];

  // 1. The dashed parent group container.
  nodes.push({
    id: HOST_GROUP_NODE_ID,
    type: "redesignHostGroup",
    position: { x: GROUP_X, y: GROUP_Y },
    style: { width: GROUP_WIDTH, height: GROUP_HEIGHT },
    data: {
      kind: "host-group",
      hostName: hostName.trim() || "Untitled host",
    },
    draggable: false,
    selectable: false,
  });

  // 2. Three sub-nodes laid out horizontally inside the group.
  const subNodeY = GROUP_PADDING_TOP;
  const subNodeXs = [
    GROUP_PADDING_X,
    GROUP_PADDING_X + SUB_NODE_WIDTH + SUB_NODE_GAP,
    GROUP_PADDING_X + (SUB_NODE_WIDTH + SUB_NODE_GAP) * 2,
  ];

  nodes.push({
    id: BEHAVIOR_NODE_ID,
    type: "redesignBehavior",
    parentId: HOST_GROUP_NODE_ID,
    extent: "parent",
    position: { x: subNodeXs[0], y: subNodeY },
    data: {
      kind: "behavior",
      modelId: draft.modelId,
      modelLabel: modelInfo.label,
      modelProvider: modelInfo.provider,
      temperature: draft.temperature,
      hostStyle: draft.hostStyle,
      hostStyleLabel: styleDef?.label ?? draft.hostStyle,
      toolApproval: draft.requireToolApproval,
      systemPromptEmpty: draft.systemPrompt.trim() === "",
      attentionFields: Array.from(behaviorAttention),
    },
    draggable: false,
  });

  nodes.push({
    id: PROTOCOL_NODE_ID,
    type: "redesignProtocol",
    parentId: HOST_GROUP_NODE_ID,
    extent: "parent",
    position: { x: subNodeXs[1], y: subNodeY },
    data: {
      kind: "protocol",
      clientInfoSummary: formatClientInfoSummary(draft),
      protocolVersionsSummary: formatProtocolVersionsSummary(draft),
      capabilitiesSummary: formatBaseCapabilitiesSummary(draft),
      hostContextSummary: formatHostContextSummary(draft),
      connectionSummary: formatConnectionSummary(draft),
      attentionFields: Array.from(protocolAttention),
    },
    draggable: false,
  });

  const openLinksOn = !!hostCaps.openLinks;
  const messageOn = !!hostCaps.message;
  const updateModelContext = hostCaps.updateModelContext as
    | Record<string, unknown>
    | undefined;
  const updateModelContextLabel = updateModelContext
    ? updateModelContext.text
      ? "text only"
      : "on"
    : "off";

  nodes.push({
    id: APPS_NODE_ID,
    type: "redesignApps",
    parentId: HOST_GROUP_NODE_ID,
    extent: "parent",
    position: { x: subNodeXs[2], y: subNodeY },
    data: {
      kind: "apps",
      enabled: isAppsExtensionEnabled(draft),
      mimeTypesSummary: formatMimeTypesSummary(draft),
      hostCapabilitiesCount: countAdvertisedHostCapabilities(draft),
      hasOverride: draft.hostCapabilitiesOverride !== undefined,
      sandboxModeLabel: formatSandboxModeLabel(draft),
      openLinksOn,
      messageOn,
      updateModelContextLabel,
      attentionFields: Array.from(appsAttention),
    },
    draggable: false,
  });

  // 3. Servers hub centered below the host group.
  const hubX = GROUP_X + (GROUP_WIDTH - 220) / 2;
  const totalServers =
    draft.serverIds.length + draft.optionalServerIds.length;
  nodes.push({
    id: SERVERS_HUB_NODE_ID,
    type: "redesignServersHub",
    position: { x: hubX, y: SERVERS_HUB_Y },
    style: { width: 220 },
    data: {
      kind: "servers-hub",
      totalCount: totalServers,
    },
    draggable: false,
  });

  // Connector from host group → servers hub.
  edges.push({
    id: "host-group-to-hub",
    source: HOST_GROUP_NODE_ID,
    target: SERVERS_HUB_NODE_ID,
    type: "default",
    style: { stroke: "oklch(0.68 0.11 40 / 0.55)", strokeWidth: 1.5 },
  });

  // 4. Server cards in a horizontal row beneath the hub.
  // Required servers first (solid edges), optional appended (dashed).
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

  const totalCardsWidth =
    orderedServerIds.length === 0
      ? 0
      : orderedServerIds.length * SERVER_CARD_WIDTH +
        (orderedServerIds.length - 1) * SERVER_CARD_GAP_X;
  const cardsStartX =
    GROUP_X + (GROUP_WIDTH - totalCardsWidth) / 2;

  orderedServerIds.forEach((serverId, index) => {
    const server = context.projectServers.find((s) => s.id === serverId);
    const url = server?.url ?? null;
    const insecure = !!url && url.startsWith("http://");
    const isOptional = draft.optionalServerIds.includes(serverId);
    const override = draft.serverConnectionOverrides?.[serverId];
    const hasOverride =
      !!override &&
      ((override.headersOverride &&
        Object.keys(override.headersOverride).length > 0) ||
        override.requestTimeoutOverride !== undefined);

    nodes.push({
      id: `server-card:${serverId}`,
      type: "redesignServerCard",
      position: {
        x: cardsStartX + index * (SERVER_CARD_WIDTH + SERVER_CARD_GAP_X),
        y: SERVER_ROW_Y,
      },
      style: { width: SERVER_CARD_WIDTH, height: SERVER_CARD_HEIGHT },
      data: {
        kind: "server-card",
        serverId,
        name: server?.name ?? "Server",
        url,
        isOptional,
        insecure,
        hasOverride: !!hasOverride,
      },
      draggable: false,
    });

    edges.push({
      id: `hub-to-server-${serverId}`,
      source: SERVERS_HUB_NODE_ID,
      target: `server-card:${serverId}`,
      type: "default",
      style: {
        stroke: insecure
          ? "oklch(0.65 0.18 60)"
          : "oklch(0.68 0.11 40 / 0.55)",
        strokeWidth: 1.5,
        strokeDasharray: isOptional ? "4 4" : undefined,
      },
    });
  });

  // 5. Add server pill — positioned to the right of the last card (or
  // centered under the hub when no servers exist).
  const addServerX =
    orderedServerIds.length === 0
      ? hubX + (220 - 36) / 2
      : cardsStartX +
        orderedServerIds.length * (SERVER_CARD_WIDTH + SERVER_CARD_GAP_X);
  nodes.push({
    id: ADD_SERVER_NODE_ID,
    type: "redesignAddServer",
    position: {
      x: addServerX,
      y: SERVER_ROW_Y + (SERVER_CARD_HEIGHT - 36) / 2,
    },
    data: { kind: "add-server", label: "Add server" },
    draggable: false,
    selectable: false,
  });

  return {
    hostName: hostName.trim() || "Untitled host",
    nodes,
    edges,
    attention,
  };
}
